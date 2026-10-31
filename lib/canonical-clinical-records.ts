import "server-only";
import { NextResponse } from "next/server";
import {
  CLINIC_TIME_ZONE,
  DiagnosisAssociationError,
  DocumentAssociationError,
  ToothVisitConflict,
  changePatientProblemStatusInTransaction,
  closeReferralInTransaction,
  createIntakeFormInTransaction,
  createInternalReferralInTransaction,
  createPatientProblemInTransaction,
  createReferralInTransaction,
  getDocumentForDownloadWith,
  getPartyWith,
  getPatientProblemOwnerWith,
  getPatientWith,
  getPool,
  getPrescriptionWith,
  getReferralWith,
  getSettingsWith,
  insertAuditRow,
  listMedicalHistoryWith,
  listPartiesWith,
  listPatientDocumentsWith,
  listPatientPrescriptionsWith,
  listSavedPrescriptionPrintsWith,
  myClinicalWorkWith,
  patientChartWith,
  patientInDoctorScopeWith,
  recordDocumentInTransaction,
  recordPatientDiagnosisInTransaction,
  recordToothConditionInTransaction,
  recordVitalsInTransaction,
  removeDocumentInTransaction,
  saveMedicalHistoryInTransaction,
  savePrescriptionInTransaction,
  setPatientPhotoWith,
  transitionInternalReferralOnClient,
  validateDocumentAssociations,
  voidPrescriptionInTransaction,
  type DbClient,
  type DbPool,
} from "./db";
import { readClinicalNavigationContextWith } from "./clinical-navigation-db";
import { readClinicalContext } from "./patient-navigation";
import { putFile, readFileByKey, storageStatus } from "./files";
import { imageSize } from "./imageSize";
import { DEFAULT_MAX_BYTES, isDocumentKind, validateUpload } from "./storage";
import { contentMatchesMimeType, SIGNATURE_MISMATCH_MESSAGE } from "./magic-bytes";
import { CONSENT_RECORD_NOTE_LIMIT, DOCUMENT_NOTE_LIMIT, parseStoredConsent } from "./consent-record";
import { buildSuggestions, checkPrescriptionDraft, checkVoidReason } from "./prescription";
import { evaluatePrescriptionSafety } from "./medication-safety";
import { isIssuingClinician } from "./clinical-identity";
import { withHttpIdempotency } from "./http-idempotency";
import {
  buildSafetyAcknowledgementToken,
  verifySafetyAcknowledgementToken,
} from "./prescription-safety-ack";
import { decodePrescriptionPrintCursor } from "./prescription-print-pagination";
import { checkInternalReferralDraft, checkReferralClose, checkReferralDraft, checkReferralTransition } from "./referrals";
import { CONDITION_LABEL, STAGE_LABEL, isValidTooth, toothName, type ConditionStage, type ToothCondition } from "./dental";
import { validateDiagnosisContent } from "./diagnosis";
import { checkProblemDraft, checkProblemStatus } from "./cases";
import { deriveAlerts, normalizeMedicalHistory, normalizeVitals } from "./medical-history";
import { validateIntake } from "./portal";
import { clinicDateString } from "./schedule";
import type { Patient } from "./patient";
import { CanonicalPatientReadRefusal, PATIENT_CARE_CAPABILITIES, readCanonicalPatientRecord } from "./canonical-patient-reads";
import { NO_STORE } from "./canonical-patient-http";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { staffAdmissionRefusal } from "./staff-capability-editor";
import { revalidateVerifiedDurableSession, type VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationCapabilities,
  staffOperationClinician,
  staffOperationIdentity,
  staffOperationOwnerOperations,
  staffOperationPatientScope,
  withStaffOperation,
  type StaffOperationHandle,
  type StaffRuntimeAction,
} from "./staff-operation-runtime";

const CONSENT_NOTE_INVALID_MESSAGE =
  "بيانات الإقرار ناقصة أو أطول من الحد المسموح، فلم يُحفظ شيء. أعد فتح نموذج الإقرار وحاول مجددًا.";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CLINICAL_READ_MAX_BYTES = 2 * 1024 * 1024;

export class CanonicalClinicalRecordsRefusal extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 410 | 503,
    message: string,
    readonly extra?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "CanonicalClinicalRecordsRefusal";
  }
}

export function canonicalClinicalRecordsFailure(
  error: unknown,
  fallback: string,
  scopeDeniedMessage = "لا تملك صلاحية عرض المرضى.",
): NextResponse {
  if (error instanceof CanonicalClinicalRecordsRefusal) {
    return NextResponse.json(
      { code: error.code, message: error.message, ...(error.extra ?? {}) },
      { status: error.status, headers: NO_STORE },
    );
  }
  if (error instanceof CanonicalPatientReadRefusal) {
    const status = error.code === "patient_not_found" ? 404 : error.code === "invalid_patient_query" ? 400 : 403;
    return NextResponse.json({ code: error.code, message: error.message }, { status, headers: NO_STORE });
  }
  if (error instanceof DocumentAssociationError || error instanceof DiagnosisAssociationError) {
    return NextResponse.json({ code: "invalid_clinical_association", message: error.message }, { status: 400, headers: NO_STORE });
  }
  if (error instanceof ToothVisitConflict) {
    return NextResponse.json({ code: "tooth_visit_conflict", message: error.message }, { status: 409, headers: NO_STORE });
  }
  const refusal = staffAdmissionRefusal(error);
  if (refusal) {
    const message = /RECORD_SCOPE_DENIED$/.test(refusal.code) ? scopeDeniedMessage : refusal.message;
    return NextResponse.json({ code: refusal.code, message }, { status: refusal.status, headers: NO_STORE });
  }
  return NextResponse.json({ message: fallback }, { status: 500, headers: NO_STORE });
}

function parsePositiveId(raw: unknown, invalidMessage: string): number {
  const id = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) {
    throw new CanonicalClinicalRecordsRefusal("invalid_id", 400, invalidMessage);
  }
  return id;
}

async function assertPatientInScope(
  client: DbClient,
  handle: StaffOperationHandle,
  action: StaffRuntimeAction,
  patientId: number,
  lockMode: "FOR KEY SHARE" | "FOR UPDATE" = "FOR KEY SHARE",
): Promise<void> {
  const scope = await staffOperationPatientScope(client, handle, action);
  if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  const { rows } = await client.query<{ id: number }>(
    `SELECT id FROM patients WHERE id = $1 ${lockMode}`,
    [patientId],
  );
  const inside = rows.length === 1 && (
    scope.kind === "all"
    || await patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId)
  );
  if (!inside) {
    throw new CanonicalClinicalRecordsRefusal("patient_not_found", 404, "لا يوجد مريض بهذا الرقم ضمن مرضاك.");
  }
}

/* ---------------------------------------------------------------------------
 * 1. Documents & Patient Photo (M2 slice 34)
 * ------------------------------------------------------------------------- */

export async function readCanonicalPatientDocuments(session: VerifiedDurableSession, patientId: number) {
  const documents = await readCanonicalPatientRecord(
    session,
    "read:patients.documents",
    patientId,
    async (query, scope) => {
      const includeRemoved = scope.granted("patients.documents.delete");
      return listPatientDocumentsWith(query, patientId, includeRemoved);
    },
    CLINICAL_READ_MAX_BYTES,
  );
  const storage = await storageStatus();
  return {
    documents,
    storageReady: storage.ready,
    storageMessage: storage.ready ? null : storage.message,
  };
}

export async function commandCanonicalDocumentUpload(
  session: VerifiedDurableSession,
  rawPatientId: string,
  form: FormData,
  pool: DbPool = getPool(),
): Promise<{ kind: "uploaded"; document: Awaited<ReturnType<typeof recordDocumentInTransaction>> } | { kind: "rejected_signature"; message: string }> {
  return withStaffOperation(pool, session, "clinical.xrays.upload", async (client, handle) => {
    const patientId = parsePositiveId(rawPatientId, "رقم الملف غير صالح.");
    await assertPatientInScope(client, handle, "clinical.xrays.upload", patientId, "FOR KEY SHARE");

    const storage = await storageStatus();
    if (!storage.ready) {
      throw new CanonicalClinicalRecordsRefusal("storage_unavailable", 503, storage.message);
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new CanonicalClinicalRecordsRefusal("invalid_upload", 400, "اختر ملفًّا.");
    }

    const settings = await getSettingsWith(client);
    const configured = Number(settings["documents.max_megabytes"]);
    const maxBytes = Number.isFinite(configured) && configured > 0
      ? Math.round(configured * 1024 * 1024)
      : DEFAULT_MAX_BYTES;

    const check = validateUpload({ mimeType: file.type, sizeBytes: file.size, maxBytes });
    if (!check.ok) {
      throw new CanonicalClinicalRecordsRefusal("invalid_upload", 400, check.message);
    }

    const rawKind = form.get("kind");
    const kind = isDocumentKind(rawKind) ? rawKind : "other";
    const rawTitle = typeof form.get("title") === "string" ? String(form.get("title")).trim() : "";
    const title = (rawTitle || file.name || "مستند").slice(0, 120);
    const rawNote = typeof form.get("note") === "string" ? String(form.get("note")).trim() : "";
    const rawTaken = typeof form.get("takenOn") === "string" ? String(form.get("takenOn")) : "";

    const consentRecord = kind === "consent" && rawNote.startsWith("{");
    if (consentRecord && (rawNote.length > CONSENT_RECORD_NOTE_LIMIT || parseStoredConsent(rawNote) === null)) {
      throw new CanonicalClinicalRecordsRefusal("invalid_consent_note", 400, CONSENT_NOTE_INVALID_MESSAGE);
    }
    const note = !rawNote ? null : consentRecord ? rawNote : rawNote.slice(0, DOCUMENT_NOTE_LIMIT);
    const takenOn = DATE_PATTERN.test(rawTaken) ? rawTaken : null;

    const optionalId = (value: FormDataEntryValue | null): number | null | undefined => {
      if (value === null || value === "") return null;
      if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return undefined;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) && parsed <= 2147483647 ? parsed : undefined;
    };
    const visitId = optionalId(form.get("visitId"));
    const orthoCaseId = optionalId(form.get("orthoCaseId"));
    const adjustmentId = optionalId(form.get("adjustmentId"));
    if (visitId === undefined || orthoCaseId === undefined || adjustmentId === undefined) {
      throw new DocumentAssociationError();
    }

    const rawStage = form.get("photoStage");
    const photoStage = typeof rawStage === "string"
      && ["initial", "progress", "debond", "retention"].includes(rawStage)
      ? rawStage
      : null;
    const rawView = form.get("photoView");
    const photoView = typeof rawView === "string" && /^[a-z_]{3,30}$/.test(rawView)
      ? rawView.slice(0, 30)
      : null;

    await validateDocumentAssociations({ patientId, visitId, orthoCaseId, adjustmentId }, client);
    const bytes = Buffer.from(await file.arrayBuffer());
    const actor = await staffOperationIdentity(client, handle, "clinical.xrays.upload");

    if (!contentMatchesMimeType(bytes, file.type)) {
      await insertAuditRow(client, {
        action: "document.upload.rejected_signature",
        entity: "patient_documents",
        entityId: String(patientId),
        details: { declared_mime: file.type, size: bytes.length },
        actor: actor.username,
        actorRole: actor.role,
      });
      return { kind: "rejected_signature", message: SIGNATURE_MISMATCH_MESSAGE };
    }

    const dimensions = imageSize(bytes);
    const stored = await putFile(bytes, check.extension);
    const document = await recordDocumentInTransaction(client, {
      patientId,
      visitId,
      kind,
      title,
      mimeType: file.type,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storageKey: stored.key,
      note,
      takenOn,
      uploadedBy: actor.username,
      orthoCaseId,
      adjustmentId,
      photoStage,
      photoView,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
    });
    await insertAuditRow(client, {
      action: "document.upload",
      entity: "patient_documents",
      entityId: document.id,
      entityLabel: title,
      details: { المريض: patientId, النوع: kind, الحجم: document.sizeBytes },
      actor: actor.username,
      actorRole: actor.role,
    });
    return { kind: "uploaded", document };
  });
}

export async function readCanonicalDocumentDownload(
  session: VerifiedDurableSession,
  rawId: string,
  download: boolean,
): Promise<NextResponse> {
  const found = await runCanonicalReadSnapshot(
    session,
    "read:patients.documents",
    async (query, scope) => {
      const id = parsePositiveId(rawId, "رقم المستند غير صالح.");
      const loaded = await getDocumentForDownloadWith(query, id);
      if (!loaded) {
        throw new CanonicalClinicalRecordsRefusal("document_not_found", 404, "المستند غير موجود.");
      }
      const inside = scope.patientScope.kind === "all" || (
        scope.patientScope.kind === "own"
        && await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, loaded.document.patientId)
      );
      if (!inside) {
        throw new CanonicalClinicalRecordsRefusal("document_not_found", 404, "المستند غير موجود.");
      }
      if (loaded.document.removedAt && !scope.granted("patients.documents.delete")) {
        throw new CanonicalClinicalRecordsRefusal("document_removed", 404, "المستند مخفيّ.");
      }
      return loaded;
    },
    { errorPrefix: "STAFF_READ", maxBytes: CLINICAL_READ_MAX_BYTES },
  );

  const bytes = await readFileByKey(found.storageKey);
  if (!bytes) {
    throw new CanonicalClinicalRecordsRefusal(
      "document_storage_missing",
      410,
      "وصف المستند موجود وملفّه مفقود من التخزين. راجع القرص الملحق.",
    );
  }
  const name = encodeURIComponent(found.document.title);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": found.document.mimeType,
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${name}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function commandCanonicalDocumentDelete(
  session: VerifiedDurableSession,
  rawId: string,
  body: Record<string, unknown>,
  pool: DbPool = getPool(),
): Promise<{ ok: true }> {
  return withStaffOperation(pool, session, "patients.documents.delete", async (client, handle) => {
    const id = parsePositiveId(rawId, "رقم المستند غير صالح.");
    const found = await getDocumentForDownloadWith(client, id);
    if (!found) {
      throw new CanonicalClinicalRecordsRefusal("document_not_found", 404, "المستند غير موجود.");
    }
    await assertPatientInScope(client, handle, "patients.documents.delete", found.document.patientId, "FOR UPDATE");
    const note = typeof body.note === "string" ? body.note : "";
    const actor = await staffOperationIdentity(client, handle, "patients.documents.delete");
    const result = await removeDocumentInTransaction(client, { id, actor: actor.username, note });
    if (!result.ok) {
      throw new CanonicalClinicalRecordsRefusal("document_remove_conflict", 409, result.message);
    }
    await insertAuditRow(client, {
      action: "document.remove",
      entity: "patient_documents",
      entityId: id,
      entityLabel: found.document.title,
      details: { السبب: note.trim().slice(0, 200) },
      actor: actor.username,
      actorRole: actor.role,
    });
    return { ok: true };
  });
}

const PHOTO_IDENTITY_FIELDS = [
  "id", "patientNumber", "fullName", "phone", "altPhone", "gender", "birthYear", "birthDate", "address",
  "guardianName", "guardianPhone", "nationalId", "email", "preferredChannel", "createdAt", "photoDocumentId",
] as const;
const PHOTO_CARE_FIELDS = ["medicalAlert", "flags", "note", "referralSource", "referredBy"] as const;

function projectPhotoPatient(patient: Patient, care: boolean, operational: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of PHOTO_IDENTITY_FIELDS) {
    out[field] = (patient as unknown as Record<string, unknown>)[field] ?? null;
  }
  if (care) {
    for (const field of PHOTO_CARE_FIELDS) {
      out[field] = (patient as unknown as Record<string, unknown>)[field] ?? null;
    }
  } else if (operational) {
    out.flags = patient.flags ?? [];
  }
  return out;
}

export async function commandCanonicalPatientPhoto(
  session: VerifiedDurableSession,
  rawPatientId: string,
  body: Record<string, unknown>,
  pool: DbPool = getPool(),
): Promise<Record<string, unknown>> {
  return withStaffOperation(pool, session, "patients.edit", async (client, handle) => {
    const patientId = parsePositiveId(rawPatientId, "رقم الملف غير صالح.");
    await assertPatientInScope(client, handle, "patients.edit", patientId, "FOR UPDATE");
    const documentId = body.documentId === null ? null : Number(body.documentId);
    if (documentId !== null && (!Number.isSafeInteger(documentId) || documentId <= 0)) {
      throw new CanonicalClinicalRecordsRefusal("invalid_photo_document", 400, "اختر صورة من مستندات المريض.");
    }
    const result = await setPatientPhotoWith(client, patientId, documentId);
    if (!result.ok) {
      const mapping = {
        not_found: { status: 404 as const, message: "المريض غير موجود." },
        document_not_found: { status: 404 as const, message: "الصورة ليست من مستندات هذا المريض أو أُخفيت." },
        not_image: { status: 400 as const, message: "اختر صورة (JPG أو PNG) لا ملفًّا آخر." },
      }[result.reason];
      throw new CanonicalClinicalRecordsRefusal(`photo_${result.reason}`, mapping.status, mapping.message);
    }
    const held = await staffOperationCapabilities(client, handle, "patients.edit", [...PATIENT_CARE_CAPABILITIES, "patients.operational-summary.view"]);
    const care = PATIENT_CARE_CAPABILITIES.some(c => held.has(c));
    const operational = care || held.has("patients.operational-summary.view");
    const actor = await staffOperationIdentity(client, handle, "patients.edit");
    await insertAuditRow(client, {
      action: "patient.photo",
      entity: "patient",
      entityId: patientId,
      entityLabel: `${result.patient.fullName} (${result.patient.patientNumber})`,
      details: { المستند: documentId },
      actor: actor.username,
      actorRole: actor.role,
    });
    return projectPhotoPatient(result.patient, care, operational);
  });
}

/* ---------------------------------------------------------------------------
 * 2. Prescriptions (M2 slice 34)
 * ------------------------------------------------------------------------- */

export async function readCanonicalPatientPrescriptions(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(
    session,
    "read:patients.prescriptions",
    patientId,
    async (query, scope) => {
      const prescriptions = await listPatientPrescriptionsWith(query, patientId);
      const suggestions = buildSuggestions(
        prescriptions
          .filter(record => record.status === "active" && record.items.length > 0)
          .map(record => ({ items: record.items, createdAt: record.createdAt })),
      );
      const historyRows = await listMedicalHistoryWith(query, patientId, 1);

      let prescriberOptions: { issuerId: number | null; canChooseAnyDoctor: boolean; doctors: { id: number; name: string }[] } = {
        issuerId: null,
        canChooseAnyDoctor: false,
        doctors: [],
      };
      if (scope.clinicianPartyId !== null) {
        const issuer = await getPartyWith(query, scope.clinicianPartyId);
        if (issuer && issuer.kind === "doctor" && issuer.isActive && issuer.name.trim()) {
          const canChooseAnyDoctor = scope.ownerMay("staff.clinician-link.change");
          const doctors = (canChooseAnyDoctor ? await listPartiesWith(query, "doctor") : [issuer])
            .filter(doctor => doctor.kind === "doctor" && doctor.isActive && doctor.name.trim())
            .map(doctor => ({ id: doctor.id, name: doctor.name }));
          prescriberOptions = { issuerId: issuer.id, canChooseAnyDoctor, doctors };
        }
      }
      return {
        prescriptions,
        suggestions,
        prescriberOptions,
        latestMedicalHistory: historyRows[0] ?? null,
      };
    },
    CLINICAL_READ_MAX_BYTES,
  );
}

export async function readCanonicalSavedPrescriptionPrints(
  session: VerifiedDurableSession,
  rawPatientId: string,
  rawVisit: string | null,
  rawCursor: string | null,
) {
  const patientId = Number(rawPatientId);
  const visitId = rawVisit === null ? null : Number(rawVisit);
  if (!Number.isSafeInteger(patientId) || patientId <= 0 || (visitId !== null && (!Number.isSafeInteger(visitId) || visitId <= 0))) {
    throw new CanonicalClinicalRecordsRefusal("invalid_prescription_query", 400, "رقم المريض أو الزيارة غير صالح.");
  }
  return readCanonicalPatientRecord(
    session,
    "read:patients.prescriptions-saved",
    patientId,
    async (query) => {
      if (visitId !== null) {
        const { rows } = await query.query<{ patient_id: number | null }>(
          "SELECT patient_id FROM visits WHERE id = $1",
          [visitId],
        );
        if (rows[0]?.patient_id !== patientId) {
          throw new CanonicalClinicalRecordsRefusal("visit_mismatch", 404, "الزيارة لا تطابق المريض.");
        }
      }
      let cursor;
      try {
        cursor = decodePrescriptionPrintCursor(rawCursor, patientId, visitId);
      } catch {
        throw new CanonicalClinicalRecordsRefusal("invalid_cursor", 400, "مؤشر الصفحة غير صالح؛ حدّث القائمة.");
      }
      return listSavedPrescriptionPrintsWith(query, patientId, visitId, cursor);
    },
    CLINICAL_READ_MAX_BYTES,
  );
}

type CanonicalRxOutcome =
  | { kind: "saved"; status: 201; payload: Record<string, unknown> }
  | { kind: "preview"; status: 200; payload: Record<string, unknown> }
  | { kind: "blocked"; status: 409; payload: Record<string, unknown> };

export async function commandCanonicalPrescriptionCreate(
  request: Request,
  session: VerifiedDurableSession,
  body: Record<string, unknown>,
  pool: DbPool = getPool(),
): Promise<NextResponse> {
  const claims = revalidateVerifiedDurableSession(session);
  const actorKey = claims ? `canon:${claims.durableIdentity.realmId}:${claims.durableIdentity.subjectId}` : "canon:expired";
  const execute = async (): Promise<NextResponse> => {
    try {
      const outcome = await withStaffOperation<CanonicalRxOutcome>(
        pool,
        session,
        "clinical.prescriptions.write",
        async (client, handle) => {
          const doctorPartyId = await staffOperationClinician(client, handle, "clinical.prescriptions.write");
          if (doctorPartyId === null) {
            throw new CanonicalClinicalRecordsRefusal(
              "clinician_link_required",
              403,
              "إصدار الوصفات يقتضي ربط الحساب بجهة طبيب نشطة.",
            );
          }
          const issuerDoctor = await getPartyWith(client, doctorPartyId);
          if (!issuerDoctor || issuerDoctor.kind !== "doctor" || !issuerDoctor.isActive || !issuerDoctor.name.trim()) {
            throw new CanonicalClinicalRecordsRefusal(
              "clinician_inactive",
              403,
              "هوية الحساب السريرية غير نشطة أو غير صالحة.",
            );
          }

          const patientId = Number(body.patientId);
          if (!Number.isSafeInteger(patientId) || patientId <= 0) {
            throw new CanonicalClinicalRecordsRefusal("invalid_patient_id", 400, "رقم الملف غير صالح للوصفة.");
          }
          await assertPatientInScope(client, handle, "clinical.prescriptions.write", patientId, "FOR KEY SHARE");

          const rawVisit = Number(body.visitId);
          if (body.visitId !== undefined && body.visitId !== null && (!Number.isSafeInteger(rawVisit) || rawVisit <= 0)) {
            throw new CanonicalClinicalRecordsRefusal("invalid_visit_id", 400, "رقم الزيارة غير صالح.");
          }
          const visitId = Number.isSafeInteger(rawVisit) && rawVisit > 0 ? rawVisit : null;

          const selectedId = body.prescribingDoctorPartyId === undefined ? doctorPartyId : Number(body.prescribingDoctorPartyId);
          if (!Number.isSafeInteger(selectedId) || selectedId <= 0) {
            throw new CanonicalClinicalRecordsRefusal("invalid_prescribing_doctor", 400, "اختر طبيبًا صالحًا من القائمة.");
          }
          const actor = await staffOperationIdentity(client, handle, "clinical.prescriptions.write");
          let ownerAuthority: { bindingVersion: string; fingerprint: string } | null = null;
          if (selectedId !== doctorPartyId) {
            const ownerOps = await staffOperationOwnerOperations(client, handle, "clinical.prescriptions.write", ["staff.clinician-link.change"]);
            if (!ownerOps.has("staff.clinician-link.change")) {
              throw new CanonicalClinicalRecordsRefusal(
                "other_doctor_forbidden",
                403,
                "اختيار طبيب آخر لإصدار الوصفة متاح للمالك الطبيب المرتبط بهوية موثوقة فقط.",
              );
            }
            ownerAuthority = {
              bindingVersion: actor.generationId,
              fingerprint: `${actor.realmId}:${actor.subjectId}:${actor.generationId}`,
            };
          }

          const selectedDoctor = selectedId === doctorPartyId ? issuerDoctor : await getPartyWith(client, selectedId);
          if (!selectedDoctor || selectedDoctor.kind !== "doctor" || !selectedDoctor.isActive || !selectedDoctor.name.trim()) {
            throw new CanonicalClinicalRecordsRefusal("prescribing_doctor_inactive", 400, "الطبيب المحدد غير موجود أو غير نشط.");
          }

          const draft = checkPrescriptionDraft({
            ownerAuthority,
            prescribingDoctorName: selectedDoctor.name,
            prescribingDoctorPartyId: selectedId,
            patientId,
            visitId,
            diagnosis: body.diagnosis,
            notes: body.notes,
            instructionsLang: body.instructionsLang,
            items: body.items,
          });
          if (!draft.ok) {
            throw new CanonicalClinicalRecordsRefusal("invalid_prescription", 400, draft.message);
          }

          if (draft.value.visitId !== null) {
            const { rows: visits } = await client.query<{ patient_id: number | null }>(
              "SELECT patient_id FROM visits WHERE id = $1 FOR SHARE",
              [draft.value.visitId],
            );
            if (!visits[0]) {
              throw new CanonicalClinicalRecordsRefusal("visit_not_found", 400, "الزيارة المذكورة غير موجودة.");
            }
            if (visits[0].patient_id !== draft.value.patientId) {
              throw new CanonicalClinicalRecordsRefusal(
                "visit_wrong_patient",
                400,
                "الزيارة المذكورة تخص مريضًا آخر — لا تُربط وصفة مريض بزيارة غيره.",
              );
            }
          }

          const acknowledgedSafetyToken =
            typeof body.acknowledgedSafetyToken === "string" && body.acknowledgedSafetyToken.length > 0
              ? body.acknowledgedSafetyToken
              : null;

          const patient = await getPatientWith(client, draft.value.patientId);
          const historyRows = await listMedicalHistoryWith(client, draft.value.patientId, 1);
          const latestMedicalHistory = historyRows[0] ?? null;

          let finalWarnings: ReturnType<typeof evaluatePrescriptionSafety> = [];
          let acknowledged = false;

          if (patient || latestMedicalHistory) {
            const alerts = evaluatePrescriptionSafety(
              draft.value.items.map(item => ({ name: item.name, dose: item.dose })),
              patient?.medicalAlert ?? null,
              latestMedicalHistory,
            );
            const critical = alerts.filter(alert => alert.severity === "critical");
            if (critical.length > 0) {
              return {
                kind: "blocked",
                status: 409,
                payload: {
                  message: "تعارض دوائي حرج مع التنبيهات الطبية المسجلة في ملف المريض — لا تُحفظ الوصفة ولا تُطبَع رسمية.",
                  safetyAlerts: critical,
                  blockReason: "critical_medication_safety",
                },
              };
            }
            const warnings = alerts.filter(alert => alert.severity !== "critical");
            if (warnings.length > 0 || acknowledgedSafetyToken) {
              if (!acknowledgedSafetyToken) {
                return {
                  kind: "preview",
                  status: 200,
                  payload: {
                    requiresAcknowledgement: true,
                    safetyWarnings: warnings,
                    acknowledgementToken: buildSafetyAcknowledgementToken({
                      username: actor.username,
                      draft: draft.value,
                      warnings,
                    }),
                  },
                };
              }
              const verdict = verifySafetyAcknowledgementToken(acknowledgedSafetyToken, {
                username: actor.username,
                draft: draft.value,
                warnings,
              });
              if (!verdict.ok) {
                if (verdict.failure === "warning_fingerprint_changed" && warnings.length > 0) {
                  return {
                    kind: "preview",
                    status: 200,
                    payload: {
                      requiresAcknowledgement: true,
                      ackRejected: true,
                      ackReason: "warning_fingerprint_changed",
                      message:
                        "تحذيرات السلامة تغيّرت منذ عرضها عليك (تحديثٌ في ملف المريض) — راجع التحذيرات الحالية أدناه وأقرّها من جديد قبل الحفظ.",
                      safetyWarnings: warnings,
                      acknowledgementToken: buildSafetyAcknowledgementToken({
                        username: actor.username,
                        draft: draft.value,
                        warnings,
                      }),
                    },
                  };
                }
                const message =
                  verdict.failure === "expired"
                    ? "انتهت صلاحية إقرار التحذيرات (١٠ دقائق) — أعد الحفظ من جديد لتُعرض التحذيرات الحالية ثم أقرّها."
                    : verdict.failure === "warning_fingerprint_changed"
                      ? "التحذيرات التي أقررتَها تغيّرت ولم يعد لتحذيراتٍ موجودة في الملف الحالي — لا يُحفظ بإقرارٍ قديم. أعد الحفظ من جديد."
                      : "الوصفة التي تُقرّها ليست الوصفة المعروضة عند التحذيرات (تغيّرت الأدوية/البيانات أو الرمز لا يخصّك) — راجع التحذيرات وأقرّها من جديد.";
                return {
                  kind: "blocked",
                  status: 409,
                  payload: { message, ackRejected: true, ackReason: verdict.failure },
                };
              }
              finalWarnings = warnings;
              acknowledged = true;
            }
          }

          const record = await savePrescriptionInTransaction(
            client,
            draft.value,
            actor.username,
            actor.role,
            doctorPartyId,
          );
          return {
            kind: "saved",
            status: 201,
            payload: acknowledged
              ? { id: record.id, createdAt: record.createdAt, safetyWarnings: finalWarnings, acknowledged: true }
              : { id: record.id, createdAt: record.createdAt },
          };
        },
      );
      return NextResponse.json(outcome.payload, { status: outcome.status, headers: NO_STORE });
    } catch (error) {
      return canonicalClinicalRecordsFailure(error, "تعذّر حفظ الوصفة.");
    }
  };

  if (!claims) return execute();
  return withHttpIdempotency(request, "prescriptions.create", actorKey, body, execute);
}

export async function commandCanonicalPrescriptionVoid(
  session: VerifiedDurableSession,
  rawId: string,
  body: Record<string, unknown>,
  pool: DbPool = getPool(),
): Promise<{ ok: true }> {
  return withStaffOperation(pool, session, "clinical.prescriptions.write", async (client, handle) => {
    const doctorPartyId = await staffOperationClinician(client, handle, "clinical.prescriptions.write");
    if (doctorPartyId === null) {
      throw new CanonicalClinicalRecordsRefusal(
        "clinician_link_required",
        403,
        "إبطال الوصفات يقتضي هوية مُصدر سريرية نشطة.",
      );
    }
    const issuerDoctor = await getPartyWith(client, doctorPartyId);
    if (!issuerDoctor || issuerDoctor.kind !== "doctor" || !issuerDoctor.isActive) {
      throw new CanonicalClinicalRecordsRefusal(
        "clinician_inactive",
        403,
        "هوية الحساب السريرية غير نشطة أو غير صالحة.",
      );
    }
    const id = parsePositiveId(rawId, "رقم وصفة غير صالح.");
    const check = checkVoidReason(body.reason);
    if (!check.ok) {
      throw new CanonicalClinicalRecordsRefusal("invalid_void_reason", 400, check.reason);
    }
    const prescription = await getPrescriptionWith(client, id);
    if (!prescription) {
      throw new CanonicalClinicalRecordsRefusal("prescription_not_found", 404, "الوصفة غير موجودة.");
    }
    await assertPatientInScope(client, handle, "clinical.prescriptions.write", prescription.patientId, "FOR KEY SHARE");
    const actor = await staffOperationIdentity(client, handle, "clinical.prescriptions.write");
    if (!isIssuingClinician(prescription, { partyId: doctorPartyId, username: actor.username })) {
      const issuedBy =
        prescription.doctorPartyId != null
          ? `أصدرها طبيب آخر (جهة #${prescription.doctorPartyId})`
          : `أصدرها حساب «${prescription.createdBy}»`;
      throw new CanonicalClinicalRecordsRefusal(
        "void_not_issuer",
        403,
        `لا يُبطل وصفةً إلا مُصدرها — هذه الوصفة ${issuedBy}. الوصول إلى المريض لا يمنح حق إبطال وصفة زميل؛ عالِج الأمر مع مُصدرها أو عبر صلاحية صريحة من الإدارة.`,
      );
    }
    const result = await voidPrescriptionInTransaction(
      client,
      {
        id,
        reason: check.reason,
        actor: actor.username,
        actorRole: actor.role,
        issuingDoctorPartyId: prescription.doctorPartyId ?? null,
        patientId: prescription.patientId,
      },
      doctorPartyId,
    );
    if (!result.ok) {
      throw new CanonicalClinicalRecordsRefusal("prescription_already_void", 409, result.message);
    }
    return { ok: true };
  });
}

/* ---------------------------------------------------------------------------
 * 3. Referrals (M2 slice 34)
 * ------------------------------------------------------------------------- */

export async function commandCanonicalReferralCreate(
  session: VerifiedDurableSession,
  rawPatientId: string,
  body: Record<string, unknown>,
  pool: DbPool = getPool(),
) {
  return withStaffOperation(pool, session, "clinical.referrals.manage", async (client, handle) => {
    const doctorPartyId = await staffOperationClinician(client, handle, "clinical.referrals.manage");
    if (doctorPartyId === null) {
      throw new CanonicalClinicalRecordsRefusal(
        "clinician_link_required",
        403,
        "خطاب الإحالة يصدره طبيب مرتبط بجهة سريرية نشطة.",
      );
    }
    const doctor = await getPartyWith(client, doctorPartyId);
    if (!doctor || doctor.kind !== "doctor" || !doctor.isActive || !doctor.name.trim()) {
      throw new CanonicalClinicalRecordsRefusal("clinician_inactive", 403, "هوية الحساب السريرية غير نشطة أو غير صالحة.");
    }
    const patientId = parsePositiveId(rawPatientId, "رقم مريض غير صالح.");
    await assertPatientInScope(client, handle, "clinical.referrals.manage", patientId, "FOR KEY SHARE");
    const actor = await staffOperationIdentity(client, handle, "clinical.referrals.manage");

    if (body.kind === "internal") {
      const internal = checkInternalReferralDraft(body);
      if (!internal.ok) {
        throw new CanonicalClinicalRecordsRefusal("invalid_referral", 400, internal.message);
      }
      const result = await createInternalReferralInTransaction(client, {
        ...internal.value,
        patientId,
        doctorPartyId,
        actor: actor.username,
        actorRole: actor.role,
      });
      if (!result.ok) {
        const messages = {
          no_patient: ["لا يوجد مريض بهذا الرقم.", 404],
          bad_receiver: ["الطبيب المحال إليه غير موجود أو غير نشط.", 400],
          self: ["لا تُحال الحالة إلى المحيل نفسه.", 400],
          bad_link: ["الحالة أو بند الخطة المختار لا يخص هذا المريض.", 400],
        } as const;
        const [message, status] = messages[result.reason];
        throw new CanonicalClinicalRecordsRefusal(`referral_${result.reason}`, status, message);
      }
      return result.referral;
    }

    const draft = checkReferralDraft(body);
    if (!draft.ok) {
      throw new CanonicalClinicalRecordsRefusal("invalid_referral", 400, draft.message);
    }
    const created = await createReferralInTransaction(client, {
      ...draft.value,
      patientId,
      doctorPartyId,
      actor: actor.username,
      actorRole: actor.role,
    });
    if (!created) {
      throw new CanonicalClinicalRecordsRefusal("patient_not_found", 404, "لا يوجد مريض بهذا الرقم.");
    }
    return created;
  });
}

export async function commandCanonicalReferralClose(
  session: VerifiedDurableSession,
  rawId: string,
  body: Record<string, unknown>,
  pool: DbPool = getPool(),
) {
  return withStaffOperation(pool, session, "clinical.referrals.manage", async (client, handle) => {
    const id = parsePositiveId(rawId, "رقم إحالة غير صالح.");
    const close = checkReferralClose(body);
    if (!close.ok) {
      throw new CanonicalClinicalRecordsRefusal("invalid_referral_close", 400, close.message);
    }
    const existing = await getReferralWith(client, id);
    if (!existing) {
      throw new CanonicalClinicalRecordsRefusal("referral_not_found", 404, "لا توجد إحالة بهذا الرقم.");
    }
    await assertPatientInScope(client, handle, "clinical.referrals.manage", existing.patientId, "FOR KEY SHARE");
    const actor = await staffOperationIdentity(client, handle, "clinical.referrals.manage");
    const result = await closeReferralInTransaction(client, {
      id,
      status: close.value.status,
      note: close.value.note,
      actor: actor.username,
      actorRole: actor.role,
    });
    if (!result.ok) {
      if (result.reason === "not_found") {
        throw new CanonicalClinicalRecordsRefusal("referral_not_found", 404, "لا توجد إحالة بهذا الرقم.");
      }
      if (result.reason === "internal") {
        throw new CanonicalClinicalRecordsRefusal(
          "referral_internal",
          409,
          "الإحالة الداخلية تُدار بخطواتها (قبول، حجز، إكمال) لا بالإغلاق المباشر.",
        );
      }
      throw new CanonicalClinicalRecordsRefusal("referral_already_closed", 409, "هذه الإحالة أُغلقت من قبل.");
    }
    return result.referral;
  });
}

export async function commandCanonicalReferralTransition(
  session: VerifiedDurableSession,
  rawId: string,
  body: Record<string, unknown>,
  pool: DbPool = getPool(),
) {
  return withStaffOperation(pool, session, "clinical.referrals.manage", async (client, handle) => {
    const id = parsePositiveId(rawId, "رقم إحالة غير صالح.");
    const transition = checkReferralTransition(body);
    if (!transition.ok) {
      throw new CanonicalClinicalRecordsRefusal("invalid_referral_transition", 400, transition.message);
    }
    const actor = await staffOperationIdentity(client, handle, "clinical.referrals.manage");
    const actorPartyId = await staffOperationClinician(client, handle, "clinical.referrals.manage");
    const ownerOps = await staffOperationOwnerOperations(client, handle, "clinical.referrals.manage", ["staff.clinician-link.change"]);
    const isOwner = ownerOps.has("staff.clinician-link.change");

    const result = await transitionInternalReferralOnClient(
      client,
      { id, ...transition.value, actor: actor.username, actorRole: actor.role },
      {
        authorize: async (current) => {
          const scope = await staffOperationPatientScope(client, handle, "clinical.referrals.manage");
          if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
          const inside = scope.kind === "all"
            || await patientInDoctorScopeWith(client, scope.clinicianPartyId, current.patient_id);
          if (!inside) {
            throw new CanonicalClinicalRecordsRefusal("referral_not_found", 404, "لا توجد إحالة بهذا الرقم.");
          }
          if (isOwner) return;
          const isReceiver = actorPartyId !== null && actorPartyId === current.to_party_id;
          const isReferrer = actorPartyId !== null && actorPartyId === current.doctor_party_id;
          const allowed = (() => {
            switch (transition.value.action) {
              case "accept":
              case "decline":
              case "complete":
                return isReceiver;
              case "schedule":
                return actorPartyId === null || isReceiver;
              case "cancel":
              case "acknowledge":
                return isReferrer;
            }
          })();
          if (!allowed) {
            const who = {
              accept: "الطبيب المحال إليه",
              decline: "الطبيب المحال إليه",
              complete: "الطبيب المحال إليه",
              schedule: "منسق الحجز أو الطبيب المحال إليه",
              cancel: "الطبيب المحيل",
              acknowledge: "الطبيب المحيل",
            }[transition.value.action];
            throw new CanonicalClinicalRecordsRefusal("referral_actor_forbidden", 403, `هذه الخطوة يقوم بها ${who}.`);
          }
        },
      },
    );
    if (!result.ok) {
      const messages = {
        not_found: ["لا توجد إحالة بهذا الرقم.", 404],
        external: ["هذه إحالة خارجية — تُغلق بنتيجتها من خطابها.", 409],
        invalid_transition: ["لا تصحّ هذه الخطوة في حالة الإحالة الآن — حدّث الصفحة.", 409],
        bad_appointment: ["اختر موعدًا محجوزًا قادمًا لهذا المريض مع الطبيب المحال إليه، غير مرتبطٍ بإحالةٍ أخرى.", 400],
      } as const;
      const [message, status] = messages[result.reason];
      throw new CanonicalClinicalRecordsRefusal(`referral_${result.reason}`, status, message);
    }
    return (await getReferralWith(client, id))!;
  });
}

export async function readCanonicalMyReferrals(session: VerifiedDurableSession) {
  return runCanonicalReadSnapshot(
    session,
    "clinical.referrals.manage",
    async (query, scope) => {
      if (scope.clinicianPartyId === null) {
        return { toMe: [], sentOpen: [], returnedToMe: [], today: [] };
      }
      return myClinicalWorkWith(query, scope.clinicianPartyId);
    },
    { errorPrefix: "STAFF_READ", maxBytes: CLINICAL_READ_MAX_BYTES },
  );
}

/* ---------------------------------------------------------------------------
 * 4. Dental Chart, Clinical Context & Structured Patient Clinical Writes (M2 slice 34)
 * ------------------------------------------------------------------------- */

export async function readCanonicalPatientChart(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(
    session,
    "read:patients.clinical",
    patientId,
    (query) => patientChartWith(query, patientId),
    CLINICAL_READ_MAX_BYTES,
  );
}

export async function commandCanonicalToothCondition(
  session: VerifiedDurableSession,
  rawPatientId: string,
  source: Record<string, unknown>,
  pool: DbPool = getPool(),
) {
  return withStaffOperation(pool, session, "clinical.visits.document", async (client, handle) => {
    const patientId = parsePositiveId(rawPatientId, "رقم المريض غير صالح.");
    await assertPatientInScope(client, handle, "clinical.visits.document", patientId, "FOR KEY SHARE");

    let visitId: number | null = null;
    if (source.visitId !== undefined && source.visitId !== null) {
      const raw = source.visitId;
      if (
        (typeof raw !== "number" && !(typeof raw === "string" && /^\d+$/.test(raw)))
        || !Number.isInteger(Number(raw)) || Number(raw) <= 0 || Number(raw) > 2_147_483_647
      ) {
        throw new CanonicalClinicalRecordsRefusal("invalid_visit_id", 400, "رقم الزيارة غير صالح.");
      }
      visitId = Number(raw);
    }

    const toothCode = Number(source.toothCode);
    if (!isValidTooth(toothCode)) {
      throw new CanonicalClinicalRecordsRefusal("invalid_tooth_code", 400, "رقم السن غير صالح بترقيم FDI.");
    }
    const condition = String(source.condition ?? "") as ToothCondition;
    if (!(condition in CONDITION_LABEL)) {
      throw new CanonicalClinicalRecordsRefusal("invalid_tooth_condition", 400, "حالة السن غير معروفة.");
    }
    const stage = String(source.stage ?? "existing") as ConditionStage;
    if (!(stage in STAGE_LABEL)) {
      throw new CanonicalClinicalRecordsRefusal("invalid_tooth_stage", 400, "مرحلة الحالة غير معروفة.");
    }

    const actor = await staffOperationIdentity(client, handle, "clinical.visits.document");
    const record = await recordToothConditionInTransaction(client, {
      patientId,
      toothCode,
      condition,
      stage,
      surfaces: typeof source.surfaces === "string" ? source.surfaces : null,
      note: typeof source.note === "string" ? source.note.slice(0, 300) : null,
      visitId,
      recordedBy: actor.username,
    });
    if (!record) {
      throw new CanonicalClinicalRecordsRefusal("patient_not_found", 404, "المريض غير موجود.");
    }
    await insertAuditRow(client, {
      action: "chart.record",
      entity: "patient",
      entityId: patientId,
      entityLabel: `${toothName(toothCode)} — ${CONDITION_LABEL[condition]} (${STAGE_LABEL[stage]})`,
      details: { السن: toothCode, الحالة: condition, المرحلة: stage, الأسطح: record.surfaces },
      actor: actor.username,
      actorRole: actor.role,
    });
    return record;
  });
}

export async function readCanonicalClinicalContext(
  session: VerifiedDurableSession,
  rawPatientId: string,
  searchParams: URLSearchParams,
) {
  const patientId = parsePositiveId(rawPatientId, "رقم مريض غير صالح.");
  const parsed = readClinicalContext(searchParams);
  if (parsed.contextError) {
    throw new CanonicalClinicalRecordsRefusal(
      "invalid_clinical_context",
      400,
      "مرجع العلاج في الرابط غير صالح. اختر الحالة صراحةً.",
    );
  }
  const context = parsed.context ?? {};
  const result = await readCanonicalPatientRecord(
    session,
    "read:patients.clinical",
    patientId,
    async (query, scope) => {
      if ((context.planId !== undefined || context.planItemId !== undefined) && !scope.granted("clinical.plans.view")) {
        throw new CanonicalClinicalRecordsRefusal("plans_view_required", 403, "لا تملك صلاحية عرض خطط العلاج.");
      }
      return readClinicalNavigationContextWith(query, patientId, context);
    },
    CLINICAL_READ_MAX_BYTES,
  );
  if (!result.ok) {
    throw new CanonicalClinicalRecordsRefusal(
      result.reason,
      result.reason === "not_found" ? 404 : 409,
      "تعذّر التحقق من الحالة أو البند المقصود. لم يتم اختيار حالة بديلة.",
      { reason: result.reason },
    );
  }
  return result;
}

export async function commandCanonicalDiagnosisCreate(
  session: VerifiedDurableSession,
  rawPatientId: string,
  source: Record<string, unknown>,
  pool: DbPool = getPool(),
) {
  return withStaffOperation(pool, session, "clinical.visits.document", async (client, handle) => {
    const patientId = parsePositiveId(rawPatientId, "رقم الملف غير صالح.");
    await assertPatientInScope(client, handle, "clinical.visits.document", patientId, "FOR KEY SHARE");

    const check = validateDiagnosisContent(source.content);
    if (!check.ok) {
      throw new CanonicalClinicalRecordsRefusal("invalid_diagnosis", 400, check.message);
    }
    const label = typeof source.label === "string" && source.label.trim()
      ? source.label.trim().slice(0, 120)
      : null;

    let orthoCaseId: number | null = null;
    if (source.orthoCaseId !== undefined && source.orthoCaseId !== null) {
      const raw = source.orthoCaseId;
      if (
        (typeof raw !== "number" && !(typeof raw === "string" && /^\d+$/.test(raw)))
        || !Number.isInteger(Number(raw)) || Number(raw) <= 0 || Number(raw) > 2_147_483_647
      ) {
        throw new CanonicalClinicalRecordsRefusal("invalid_ortho_case_id", 400, "رقم حالة التقويم غير صالح.");
      }
      orthoCaseId = Number(raw);
    }

    const actor = await staffOperationIdentity(client, handle, "clinical.visits.document");
    const saved = await recordPatientDiagnosisInTransaction(client, {
      patientId,
      content: check.content as unknown as Record<string, unknown>,
      label,
      orthoCaseId,
      visitId: null,
      createdBy: actor.username,
    });
    await insertAuditRow(client, {
      action: "diagnosis.create",
      entity: "patient_diagnoses",
      entityId: saved.id,
      entityLabel: `نسخة ${saved.version}`,
      details: { المريض: patientId, النسخة: saved.version },
      actor: actor.username,
      actorRole: actor.role,
    });
    return saved;
  });
}

export async function commandCanonicalProblemCreate(
  session: VerifiedDurableSession,
  rawPatientId: string,
  body: Record<string, unknown>,
  pool: DbPool = getPool(),
) {
  return withStaffOperation(pool, session, "clinical.visits.document", async (client, handle) => {
    const patientId = parsePositiveId(rawPatientId, "رقم مريض غير صالح.");
    await assertPatientInScope(client, handle, "clinical.visits.document", patientId, "FOR KEY SHARE");

    const draft = checkProblemDraft(body);
    if (!draft.ok) {
      throw new CanonicalClinicalRecordsRefusal("invalid_problem", 400, draft.message);
    }
    const actor = await staffOperationIdentity(client, handle, "clinical.visits.document");
    const result = await createPatientProblemInTransaction(client, {
      ...draft.value,
      patientId,
      actor: actor.username,
      actorRole: actor.role,
    });
    if (!result.ok) {
      throw new CanonicalClinicalRecordsRefusal(
        `problem_${result.reason}`,
        result.reason === "no_patient" ? 404 : 400,
        result.reason === "no_patient" ? "لا يوجد مريض بهذا الرقم." : "الحالة المختارة لا تخص هذا المريض.",
      );
    }
    return result.problem;
  });
}

export async function commandCanonicalProblemStatus(
  session: VerifiedDurableSession,
  rawId: string,
  body: Record<string, unknown>,
  pool: DbPool = getPool(),
) {
  return withStaffOperation(pool, session, "clinical.visits.document", async (client, handle) => {
    const id = parsePositiveId(rawId, "رقم مشكلة غير صالح.");
    const status = checkProblemStatus(body);
    if (!status.ok) {
      throw new CanonicalClinicalRecordsRefusal("invalid_problem_status", 400, status.message);
    }
    const patientId = await getPatientProblemOwnerWith(client, id);
    if (!patientId) {
      throw new CanonicalClinicalRecordsRefusal("problem_not_found", 404, "لا توجد مشكلة بهذا الرقم.");
    }
    await assertPatientInScope(client, handle, "clinical.visits.document", patientId, "FOR KEY SHARE");
    const actor = await staffOperationIdentity(client, handle, "clinical.visits.document");
    const result = await changePatientProblemStatusInTransaction(client, {
      id,
      status: status.value,
      actor: actor.username,
      actorRole: actor.role,
    });
    if (!result.ok) {
      throw new CanonicalClinicalRecordsRefusal(
        `problem_${result.reason}`,
        result.reason === "not_found" ? 404 : 409,
        result.reason === "not_found" ? "لا توجد مشكلة بهذا الرقم." : "المشكلة بهذه الحالة سلفًا.",
      );
    }
    return result.problem;
  });
}

export async function commandCanonicalVitalsCreate(
  session: VerifiedDurableSession,
  rawPatientId: string,
  body: unknown,
  pool: DbPool = getPool(),
) {
  return withStaffOperation(pool, session, "clinical.visits.document", async (client, handle) => {
    const patientId = parsePositiveId(rawPatientId, "رقم الملف غير صالح.");
    await assertPatientInScope(client, handle, "clinical.visits.document", patientId, "FOR UPDATE");

    const parsed = normalizeVitals(body);
    if (!parsed.ok) {
      throw new CanonicalClinicalRecordsRefusal("invalid_vitals", 400, parsed.message);
    }
    const source = (body ?? {}) as Record<string, unknown>;
    const recordedDate = source.recordedAt;
    const parsedDate = typeof recordedDate === "string" ? new Date(`${recordedDate}T00:00:00Z`) : null;
    if (
      recordedDate !== undefined
      && (typeof recordedDate !== "string"
        || !DATE_PATTERN.test(recordedDate)
        || !parsedDate
        || !Number.isFinite(parsedDate.getTime())
        || parsedDate.toISOString().slice(0, 10) !== recordedDate
        || recordedDate < "0001-01-01"
        || recordedDate > clinicDateString(new Date(), CLINIC_TIME_ZONE))
    ) {
      throw new CanonicalClinicalRecordsRefusal("invalid_vitals_date", 400, "تاريخ القياس غير صالح أو في المستقبل.");
    }
    const medicalAlert = source.medicalAlert;
    if (
      medicalAlert !== undefined
      && medicalAlert !== null
      && (typeof medicalAlert !== "string" || medicalAlert.length > 800)
    ) {
      throw new CanonicalClinicalRecordsRefusal("invalid_medical_alert", 400, "التنبيه الطبي غير صالح أو طويل جدًا.");
    }

    const actor = await staffOperationIdentity(client, handle, "clinical.visits.document");
    const saved = await recordVitalsInTransaction(client, patientId, parsed.value, actor.username, {
      recordedDate: recordedDate as string | undefined,
      medicalAlert: medicalAlert as string | null | undefined,
    });
    if (!saved) {
      throw new CanonicalClinicalRecordsRefusal("patient_not_found", 404, "المريض غير موجود.");
    }
    await insertAuditRow(client, {
      action: "patient.vitals",
      entity: "patient",
      entityId: patientId,
      details: { القراءة: saved.id, الزيارة: saved.visitId },
      actor: actor.username,
      actorRole: actor.role,
    });
    return { ...saved, ...(medicalAlert !== undefined ? { medicalAlert } : {}) };
  });
}

export async function commandCanonicalIntakeCreate(
  session: VerifiedDurableSession,
  rawPatientId: string,
  body: unknown,
  pool: DbPool = getPool(),
) {
  return withStaffOperation(pool, session, "clinical.visits.document", async (client, handle) => {
    const patientId = parsePositiveId(rawPatientId, "رقم المريض غير صالح.");
    await assertPatientInScope(client, handle, "clinical.visits.document", patientId, "FOR KEY SHARE");

    const validation = validateIntake(body);
    if (!validation.ok) {
      throw new CanonicalClinicalRecordsRefusal("invalid_intake", 400, validation.message);
    }
    const actor = await staffOperationIdentity(client, handle, "clinical.visits.document");
    const created = await createIntakeFormInTransaction(client, patientId, validation.value, {
      actor: actor.username,
      actorRole: actor.role,
    });
    if (!created) {
      throw new CanonicalClinicalRecordsRefusal("patient_not_found", 404, "ملف المريض غير موجود.");
    }
    return created;
  });
}

export async function commandCanonicalMedicalHistoryCreate(
  session: VerifiedDurableSession,
  rawPatientId: string,
  body: unknown,
  pool: DbPool = getPool(),
) {
  return withStaffOperation(pool, session, "clinical.visits.document", async (client, handle) => {
    const patientId = parsePositiveId(rawPatientId, "رقم الملف غير صالح.");
    await assertPatientInScope(client, handle, "clinical.visits.document", patientId, "FOR KEY SHARE");

    const parsed = normalizeMedicalHistory(body);
    if (!parsed.ok) {
      throw new CanonicalClinicalRecordsRefusal("invalid_medical_history", 400, parsed.message);
    }
    const actor = await staffOperationIdentity(client, handle, "clinical.visits.document");
    const saved = await saveMedicalHistoryInTransaction(client, patientId, parsed.value, actor.username);
    if (!saved) {
      throw new CanonicalClinicalRecordsRefusal("patient_not_found", 404, "المريض غير موجود.");
    }
    await insertAuditRow(client, {
      action: "patient.medical_history",
      entity: "patient",
      entityId: patientId,
      details: {
        النسخة: saved.id,
        الحساسية: saved.allergies.length,
        الأدوية: saved.medications.length,
        التنبيهات: deriveAlerts(saved).map(alert => alert.label),
        تأكيد_المريض: saved.patientConfirmed,
      },
      actor: actor.username,
      actorRole: actor.role,
    });
    return saved;
  });
}
