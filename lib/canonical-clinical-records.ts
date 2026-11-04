import "server-only";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import {
  CLINIC_TIME_ZONE, DiagnosisAssociationError, createIntakeFormOn, getMedicalHistoryWith, getPool, getVitalsWith, insertAuditRow,
  patientInDoctorScopeWith, recordPatientDiagnosisOn, recordVitalsOn, saveMedicalHistoryOn, type DbClient,
} from "./db";
import { deriveAlerts, normalizeMedicalHistory, normalizeVitals } from "./medical-history";
import { validateIntake } from "./portal";
import { validateDiagnosisContent } from "./diagnosis";
import { clinicDateString } from "./schedule";
import { NO_STORE, canonicalPatientReadFailure } from "./canonical-patient-http";
import { bodyErrorResponse, readJsonBody } from "./http-body";
import { JSON_BODY_LIMIT_BYTES } from "./security-limits";
import { selectRequestStaffEnvelope } from "./staff-session-admission";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationClinician, staffOperationIdentity, staffOperationIsProtectedOwner, staffOperationPatientScope, withStaffOperation,
  type StaffOperationHandle,
} from "./staff-operation-runtime";
import { stableJson } from "./canonical-lab-create";

/**
 * Canonical clinical record writes (M2 slice 74, group 3): POST
 * /api/patients/[id]/medical-history, /vitals, /intake-history and /diagnoses. Their reads
 * have been canonical since slice 3.
 *
 * - One admitted `clinical.visits.document` transaction each (the map's capability; the
 *   legacy routes allowed role labels with patient access), inside the patient scope;
 *   outside answers like missing (404). The scope check takes no row lock, so each legacy
 *   body keeps its own lock order (vitals: patient row; diagnosis: per-patient advisory
 *   lock, then the patient FOR KEY SHARE).
 * - Diagnosis: the legacy route allowed the doctor and admin labels only; the canonical
 *   path needs the actor's validated clinician link or the protected owner (never wider).
 * - Writer bodies extracted unchanged (`saveMedicalHistoryOn`, `recordVitalsOn`,
 *   `createIntakeFormOn`, `recordPatientDiagnosisOn`); the audit row — written after the
 *   commit (or fire-and-forget) on the legacy path — commits WITH the record here.
 * - Each create needs a `requestKey` (diagnosis: optional, see below): under a transaction advisory lock on (actor, key),
 *   the receipt (the audit row of the same transaction) is looked up first; the same
 *   request returns the first record (`replayed`), another request with the key is
 *   refused (409). A double press never writes two versions or readings.
 * - The vitals alert (`medicalAlert`) is the same clinical field the legacy route wrote
 *   with the reading, in the same transaction. No money anywhere.
 */
export class CanonicalClinicalRecordRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409, message: string, readonly field?: string) {
    super(message);
    this.name = "CanonicalClinicalRecordRefusal";
  }
}
export const CLINICAL_RECEIPT_WINDOW = "1 day";
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const invalid = (message: string, field?: string) => new CanonicalClinicalRecordRefusal("invalid_clinical_record", 400, message, field);
const patientMissing = () => new CanonicalClinicalRecordRefusal("patient_not_found", 404, "لا يوجد مريض بهذا الرقم ضمن مرضاك.");

function positiveId(raw: string): number {
  if (!/^[1-9][0-9]{0,9}$/.test(raw) || Number(raw) > 2147483647) throw invalid("رقم الملف غير صالح.");
  return Number(raw);
}
function requestKeyOf(body: Record<string, unknown>): string {
  const key = typeof body.requestKey === "string" ? body.requestKey : "";
  if (!KEY_PATTERN.test(key)) throw invalid("مفتاح الطلب مفقود أو غير صالح؛ أعد فتح النموذج.", "requestKey");
  return key;
}
const fingerprintOf = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");

type Kind = "patient.medical_history" | "patient.vitals" | "intake.staff" | "diagnosis.create";

/**
 * One admitted clinical record write: scope (no row lock), the request-key receipt,
 * then the body. `replay(id)` re-reads the first record; `write(stamp)` writes the record
 * and its audit row carrying `stamp`, returning the record.
 */
async function clinicalWrite<T>(
  session: VerifiedDurableSession, patientId: number, kind: Kind, requestKey: string | null, fingerprint: string,
  receiptField: string, pool: ReturnType<typeof getPool>,
  work: (ctx: { client: DbClient; handle: StaffOperationHandle; actor: { actor: string; actorRole: string } }) => {
    replay: (id: number) => Promise<T | null>;
    write: (stamp: Record<string, string>) => Promise<T>;
    authorize?: () => Promise<void>;
  },
): Promise<T & { replayed: boolean }> {
  return withStaffOperation(pool, session, "clinical.visits.document", async (client, handle) => {
    const scope = await staffOperationPatientScope(client, handle, "clinical.visits.document");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const identity = await staffOperationIdentity(client, handle, "clinical.visits.document");
    const steps = work({ client, handle, actor: { actor: identity.username, actorRole: identity.role } });
    await steps.authorize?.();
    const inside = async (id: number) => scope.kind === "all" || patientInDoctorScopeWith(client, scope.clinicianPartyId, id);
    if (requestKey === null) {
      if (!await inside(patientId)) throw patientMissing();
      return { ...await steps.write({}), replayed: false };
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtext('clinical-record:' || $1::text || ':' || $2::text))", [identity.userId, requestKey]);
    const { rows: [receipt] } = await client.query<{ record: string | null; fingerprint: string | null; patient: string }>(
      `SELECT details->>$4 AS record, details->>'requestFingerprint' AS fingerprint, entity_id AS patient FROM audit_log
        WHERE action = $3 AND created_at > NOW() - $5::interval
          AND details->>'requestKey' = $1 AND details->>'requestActorId' = $2::text
        ORDER BY id DESC LIMIT 1`,
      [requestKey, identity.userId, kind, receiptField, CLINICAL_RECEIPT_WINDOW]);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) {
        throw new CanonicalClinicalRecordRefusal("clinical_request_key_reused", 409, "مفتاح الطلب استُعمل لطلب مختلف؛ أعد فتح النموذج وأرسل من جديد.");
      }
      const first = receipt.record ? await steps.replay(Number(receipt.record)) : null;
      if (!first || !await inside(patientId)) throw patientMissing();
      return { ...first, replayed: true };
    }
    if (!await inside(patientId)) throw patientMissing();
    const record = await steps.write({ requestKey, requestFingerprint: fingerprint, requestActorId: String(identity.userId) });
    return { ...record, replayed: false };
  });
}

export async function commandCanonicalMedicalHistory(session: VerifiedDurableSession, rawPatientId: string, body: Record<string, unknown>, pool = getPool()) {
  const patientId = positiveId(rawPatientId);
  const requestKey = requestKeyOf(body);
  const parsed = normalizeMedicalHistory(body);
  if (!parsed.ok) throw invalid(parsed.message);
  return clinicalWrite(session, patientId, "patient.medical_history", requestKey, fingerprintOf({ patientId, ...parsed.value }), "النسخة", pool, ({ client, actor }) => ({
    replay: id => getMedicalHistoryWith(client, id),
    write: async stamp => {
      const saved = await saveMedicalHistoryOn(client, patientId, parsed.value, actor.actor);
      if (!saved) throw patientMissing();
      await insertAuditRow(client, {
        action: "patient.medical_history", entity: "patient", entityId: patientId,
        details: {
          النسخة: saved.id, الحساسية: saved.allergies.length, الأدوية: saved.medications.length,
          التنبيهات: deriveAlerts(saved).map(alert => alert.label), تأكيد_المريض: saved.patientConfirmed, ...stamp,
        },
        ...actor,
      });
      return saved;
    },
  }));
}

/** The vitals body's date and alert, validated exactly as the legacy route does. */
function vitalsOptions(body: Record<string, unknown>) {
  const recordedDate = body.recordedAt;
  const parsedDate = typeof recordedDate === "string" ? new Date(`${recordedDate}T00:00:00Z`) : null;
  if (recordedDate !== undefined && (typeof recordedDate !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(recordedDate)
    || !parsedDate || !Number.isFinite(parsedDate.getTime())
    || parsedDate.toISOString().slice(0, 10) !== recordedDate
    || recordedDate < "0001-01-01"
    || recordedDate > clinicDateString(new Date(), CLINIC_TIME_ZONE))) {
    throw invalid("تاريخ القياس غير صالح أو في المستقبل.", "recordedAt");
  }
  const medicalAlert = body.medicalAlert;
  if (medicalAlert !== undefined && medicalAlert !== null && (typeof medicalAlert !== "string" || medicalAlert.length > 800)) {
    throw invalid("التنبيه الطبي غير صالح أو طويل جدًا.", "medicalAlert");
  }
  return { recordedDate: recordedDate as string | undefined, medicalAlert: medicalAlert as string | null | undefined };
}

export async function commandCanonicalVitals(session: VerifiedDurableSession, rawPatientId: string, body: Record<string, unknown>, pool = getPool()) {
  const patientId = positiveId(rawPatientId);
  const requestKey = requestKeyOf(body);
  const parsed = normalizeVitals(body);
  if (!parsed.ok) throw invalid(parsed.message);
  const options = vitalsOptions(body);
  return clinicalWrite(session, patientId, "patient.vitals", requestKey, fingerprintOf({ patientId, ...parsed.value, ...options }), "القراءة", pool, ({ client, actor }) => ({
    replay: async id => {
      const reading = await getVitalsWith(client, id);
      if (!reading) return null;
      const { rows: [patient] } = await client.query<{ medical_alert: string | null }>("SELECT medical_alert FROM patients WHERE id = $1", [reading.patientId]);
      return { ...reading, ...(options.medicalAlert !== undefined ? { medicalAlert: patient?.medical_alert ?? null } : {}) };
    },
    write: async stamp => {
      const saved = await recordVitalsOn(client, patientId, parsed.value, actor.actor, options);
      if (!saved) throw patientMissing();
      await insertAuditRow(client, {
        action: "patient.vitals", entity: "patient", entityId: patientId,
        details: { القراءة: saved.id, الزيارة: saved.visitId, ...stamp }, ...actor,
      });
      // The alert is the exact validated value written with the reading (legacy contract:
      // omission never implies removal).
      return { ...saved, ...(options.medicalAlert !== undefined ? { medicalAlert: options.medicalAlert } : {}) };
    },
  }));
}

export async function commandCanonicalIntake(session: VerifiedDurableSession, rawPatientId: string, body: Record<string, unknown>, pool = getPool()) {
  const patientId = positiveId(rawPatientId);
  const requestKey = requestKeyOf(body);
  const validation = validateIntake(body);
  if (!validation.ok) throw invalid(validation.message);
  return clinicalWrite(session, patientId, "intake.staff", requestKey, fingerprintOf({ patientId, ...validation.value }), "الاستمارة", pool, ({ client, actor }) => ({
    replay: async id => {
      const { rows: [row] } = await client.query<{ id: number; created_at: Date }>("SELECT id, created_at FROM patient_intake_forms WHERE id = $1", [id]);
      return row ? { id: row.id, createdAt: row.created_at.toISOString() } : null;
    },
    write: async stamp => {
      const { rows } = await client.query("SELECT 1 FROM patients WHERE id = $1", [patientId]);
      if (!rows[0]) throw patientMissing();
      return createIntakeFormOn(client, patientId, validation.value, actor, stamp);
    },
  }));
}

const parseCaseId = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  if ((typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value)))
    || !Number.isInteger(Number(value)) || Number(value) <= 0 || Number(value) > 2_147_483_647) throw invalid("رقم حالة التقويم غير صالح.", "orthoCaseId");
  return Number(value);
};

export async function commandCanonicalDiagnosis(session: VerifiedDurableSession, rawPatientId: string, body: Record<string, unknown>, pool = getPool()) {
  const patientId = positiveId(rawPatientId);
  // Optional here: the reviewed diagnosis panel (hash-pinned) sends its exact body once
  // under repeated submission, and each version is serialized by the writer's advisory
  // lock. A key, when sent, gives the same receipt as the other records.
  const requestKey = body.requestKey === undefined ? null : requestKeyOf(body);
  const check = validateDiagnosisContent(body.content);
  if (!check.ok) throw invalid(check.message, "content");
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 120) : null;
  const orthoCaseId = parseCaseId(body.orthoCaseId);
  const content = check.content as unknown as Record<string, unknown>;
  try {
    return await clinicalWrite(session, patientId, "diagnosis.create", requestKey, fingerprintOf({ patientId, content, label, orthoCaseId }), "التشخيص", pool, ({ client, handle, actor }) => ({
      authorize: async () => {
        // The legacy doctor/admin labels: the clinician link, or the protected owner.
        const clinician = await staffOperationClinician(client, handle, "clinical.visits.document");
        if (clinician === null && !await staffOperationIsProtectedOwner(client, handle, "clinical.visits.document")) {
          throw new CanonicalClinicalRecordRefusal("diagnosis_clinician_required", 403, "تسجيل التشخيص للطبيب المرتبط بجهة طبيب.");
        }
      },
      replay: async id => {
        const { rows: [row] } = await client.query<{ id: number; version: number }>("SELECT id, version FROM patient_diagnoses WHERE id = $1", [id]);
        return row ?? null;
      },
      write: async stamp => {
        const saved = await recordPatientDiagnosisOn(client, { patientId, content, label, orthoCaseId, visitId: null, createdBy: actor.actor });
        await insertAuditRow(client, {
          action: "diagnosis.create", entity: "patient_diagnoses", entityId: saved.id, entityLabel: `نسخة ${saved.version}`,
          details: { المريض: patientId, النسخة: saved.version, التشخيص: saved.id, ...stamp }, ...actor,
        });
        return saved;
      },
    }));
  } catch (error) {
    if (error instanceof DiagnosisAssociationError) throw invalid(error.message, "orthoCaseId");
    throw error;
  }
}

/** The canonical branch of a clinical record POST (null for a legacy envelope). */
export async function canonicalClinicalRecordRoute(
  request: Request,
  run: (handle: VerifiedDurableSession, body: Record<string, unknown>) => Promise<unknown>,
  fallback: string,
): Promise<NextResponse | null> {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind !== "canonical") return null;
  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  try {
    return NextResponse.json(await run(selected.handle, body), { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof CanonicalClinicalRecordRefusal) {
      return NextResponse.json({ code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) }, { status: error.status, headers: NO_STORE });
    }
    return canonicalPatientReadFailure(error, fallback);
  }
}
