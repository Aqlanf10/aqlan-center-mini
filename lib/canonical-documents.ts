import "server-only";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import {
  DocumentAssociationError, getDocumentForDownloadWith, getPool, getSettingsWith, insertAuditRow, listPatientDocumentsWith,
  patientInDoctorScopeWith, recordDocumentOn, removeDocumentOn, setPatientPhotoOn, validateDocumentAssociations, type DbClient,
} from "./db";
import { putFile, readFileByKey, storageStatus } from "./files";
import { imageSize } from "./imageSize";
import { DEFAULT_MAX_BYTES, isDocumentKind, validateUpload } from "./storage";
import { contentMatchesMimeType, SIGNATURE_MISMATCH_MESSAGE } from "./magic-bytes";
import { CONSENT_RECORD_NOTE_LIMIT, DOCUMENT_NOTE_LIMIT, parseStoredConsent } from "./consent-record";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { readCanonicalPatientRecord } from "./canonical-patient-reads";
import { NO_STORE, canonicalPatientReadFailure } from "./canonical-patient-http";
import type { StaffRecordConstraint } from "./staff-capabilities";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

/**
 * Canonical patient documents and X-rays (M2 slice 75, group 3): GET/POST
 * /api/patients/[id]/documents, GET/DELETE /api/documents/[id] and PUT
 * /api/patients/[id]/photo.
 *
 * - Reads: registered record reads under `clinical.xrays.view`, inside the patient scope
 *   (a document of a patient outside the scope reads as missing). Hidden documents
 *   (removed) are listed and opened only by a holder of `patients.documents.delete` or the
 *   protected owner — the legacy admin label. The storage key never leaves the server;
 *   the file is read from disk only after the snapshot admitted the actor.
 * - Upload: one admitted `clinical.xrays.upload` transaction. Admission, scope, the
 *   configured size limit and the association checks all come BEFORE the bytes are
 *   written to disk. A content-signature mismatch writes only its
 *   `document.upload.rejected_signature` audit row (committed) and is refused (400). The
 *   file is written before its row (legacy order: an orphan file is silent garbage; a row
 *   without a file is worse), and the row and its `document.upload` audit commit together.
 *   An optional `requestKey` (the screens send one) gives a receipt: a double press
 *   returns the first document instead of a second row.
 * - Hide: `patients.documents.delete` (the legacy admin label), inside the scope, with a
 *   written reason; the row lock, the hide, the photo pointer and the audit in one
 *   transaction.
 * - Photo: `patients.edit` inside the scope (legacy: non-restricted labels with edit
 *   access); an image of this patient's own visible documents, or null.
 */
export class CanonicalDocumentRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 410 | 503, message: string, readonly field?: string) {
    super(message);
    this.name = "CanonicalDocumentRefusal";
  }
}
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
export const DOCUMENT_RECEIPT_WINDOW = "1 day";
const CONSENT_NOTE_INVALID_MESSAGE = "بيانات الإقرار ناقصة أو أطول من الحد المسموح، فلم يُحفظ شيء. أعد فتح نموذج الإقرار وحاول مجددًا.";
const documentMissing = () => new CanonicalDocumentRefusal("document_not_found", 404, "المستند غير موجود ضمن مرضاك.");
const invalid = (message: string, field?: string) => new CanonicalDocumentRefusal("invalid_document", 400, message, field);

function positiveId(raw: string, message: string): number {
  if (!/^[1-9][0-9]{0,9}$/.test(raw) || Number(raw) > 2147483647) throw invalid(message);
  return Number(raw);
}
async function inScope(q: Pick<DbClient, "query">, scope: StaffRecordConstraint, patientId: number) {
  if (scope.kind === "all") return true;
  if (scope.kind === "none") return false;
  return patientInDoctorScopeWith(q, scope.clinicianPartyId, patientId);
}

/* ---------------------------------------------------------------- reads */

export async function readCanonicalPatientDocuments(session: VerifiedDurableSession, patientId: number) {
  const storage = await storageStatus();
  return readCanonicalPatientRecord(session, "read:documents.list", patientId, async (query, scope) => {
    const removed = scope.granted("patients.documents.delete") || scope.isProtectedOwner();
    return {
      documents: await listPatientDocumentsWith(query, patientId, removed),
      storageReady: storage.ready,
      storageMessage: storage.ready ? null : storage.message,
    };
  }, 2 * 1024 * 1024);
}

/** The admitted download: the bytes, read only after the snapshot admitted the actor. */
export async function readCanonicalDocumentFile(session: VerifiedDurableSession, rawId: string) {
  const id = positiveId(rawId, "رقم المستند غير صالح.");
  const found = await runCanonicalReadSnapshot(session, "read:documents.file", async (query, scope) => {
    const row = await getDocumentForDownloadWith(query, id);
    if (!row || !await inScope(query, scope.patientScope, row.document.patientId)) throw documentMissing();
    if (row.document.removedAt && !(scope.granted("patients.documents.delete") || scope.isProtectedOwner())) {
      throw new CanonicalDocumentRefusal("document_hidden", 404, "المستند مخفيّ.");
    }
    return row;
  }, { errorPrefix: "STAFF_READ", maxBytes: 64 * 1024 });
  const bytes = await readFileByKey(found.storageKey);
  if (!bytes) throw new CanonicalDocumentRefusal("document_file_missing", 410, "وصف المستند موجود وملفّه مفقود من التخزين. راجع القرص الملحق.");
  return { document: found.document, bytes };
}

/* ---------------------------------------------------------------- upload */

export interface CanonicalDocumentUpload {
  readonly file: File;
  readonly kind: string;
  readonly title: string;
  readonly note: string | null;
  readonly takenOn: string | null;
  readonly visitId: number | null;
  readonly orthoCaseId: number | null;
  readonly adjustmentId: number | null;
  readonly photoStage: string | null;
  readonly photoView: string | null;
  readonly requestKey: string | null;
}

/** The form fields, validated exactly as the legacy route does (no database). */
export function parseCanonicalDocumentUpload(form: FormData): CanonicalDocumentUpload {
  const file = form.get("file");
  if (!(file instanceof File)) throw invalid("اختر ملفًّا.", "file");
  const rawKind = form.get("kind");
  const kind = isDocumentKind(rawKind) ? rawKind : "other";
  const rawTitle = typeof form.get("title") === "string" ? String(form.get("title")).trim() : "";
  const title = (rawTitle || file.name || "مستند").slice(0, 120);
  const rawNote = typeof form.get("note") === "string" ? String(form.get("note")).trim() : "";
  const rawTaken = typeof form.get("takenOn") === "string" ? String(form.get("takenOn")) : "";
  const consentRecord = kind === "consent" && rawNote.startsWith("{");
  if (consentRecord && (rawNote.length > CONSENT_RECORD_NOTE_LIMIT || parseStoredConsent(rawNote) === null)) throw invalid(CONSENT_NOTE_INVALID_MESSAGE, "note");
  const note = !rawNote ? null : consentRecord ? rawNote : rawNote.slice(0, DOCUMENT_NOTE_LIMIT);
  const optionalId = (value: FormDataEntryValue | null): number | null | undefined => {
    if (value === null || value === "") return null;
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed <= 2147483647 ? parsed : undefined;
  };
  const visitId = optionalId(form.get("visitId"));
  const orthoCaseId = optionalId(form.get("orthoCaseId"));
  const adjustmentId = optionalId(form.get("adjustmentId"));
  if (visitId === undefined || orthoCaseId === undefined || adjustmentId === undefined) throw invalid(new DocumentAssociationError().message);
  const rawStage = form.get("photoStage");
  const photoStage = typeof rawStage === "string" && ["initial", "progress", "debond", "retention"].includes(rawStage) ? rawStage : null;
  const rawView = form.get("photoView");
  const photoView = typeof rawView === "string" && /^[a-z_]{3,30}$/.test(rawView) ? rawView.slice(0, 30) : null;
  const rawKey = form.get("requestKey");
  if (rawKey !== null && (typeof rawKey !== "string" || !KEY_PATTERN.test(rawKey))) throw invalid("مفتاح الطلب غير صالح؛ أعد فتح النموذج.", "requestKey");
  return {
    file, kind, title, note, takenOn: DATE_PATTERN.test(rawTaken) ? rawTaken : null,
    visitId, orthoCaseId, adjustmentId, photoStage, photoView, requestKey: rawKey as string | null,
  };
}

export async function commandCanonicalDocumentUpload(session: VerifiedDurableSession, rawPatientId: string, input: CanonicalDocumentUpload, pool = getPool()) {
  const patientId = positiveId(rawPatientId, "رقم الملف غير صالح.");
  const storage = await storageStatus();
  if (!storage.ready) throw new CanonicalDocumentRefusal("storage_not_ready", 503, storage.message);
  const bytes = Buffer.from(await input.file.arrayBuffer());
  const fingerprint = createHash("sha256").update(JSON.stringify({
    patientId, sha: createHash("sha256").update(bytes).digest("hex"), mime: input.file.type, kind: input.kind, title: input.title, note: input.note,
    takenOn: input.takenOn, visitId: input.visitId, orthoCaseId: input.orthoCaseId, adjustmentId: input.adjustmentId,
    photoStage: input.photoStage, photoView: input.photoView,
  })).digest("hex");
  // Every admission step (grant, scope, size limit, associations, receipt) runs before a
  // byte is written to disk.
  return withStaffOperation(pool, session, "clinical.xrays.upload", async (client, handle) => {
    const scope = await staffOperationPatientScope(client, handle, "clinical.xrays.upload");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const identity = await staffOperationIdentity(client, handle, "clinical.xrays.upload");
    const actor = { actor: identity.username, actorRole: identity.role };
    if (input.requestKey) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('document-upload:' || $1::text || ':' || $2::text))", [identity.userId, input.requestKey]);
      const { rows: [receipt] } = await client.query<{ entity_id: string; fingerprint: string | null }>(
        `SELECT entity_id, details->>'requestFingerprint' AS fingerprint FROM audit_log
          WHERE action = 'document.upload' AND created_at > NOW() - $3::interval
            AND details->>'requestKey' = $1 AND details->>'requestActorId' = $2::text
          ORDER BY id DESC LIMIT 1`, [input.requestKey, identity.userId, DOCUMENT_RECEIPT_WINDOW]);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new CanonicalDocumentRefusal("document_request_key_reused", 409, "مفتاح الطلب استُعمل لملفٍ مختلف؛ أعد فتح النموذج وارفع من جديد.");
        const first = await getDocumentForDownloadWith(client, Number(receipt.entity_id));
        if (!first || !await inScope(client, scope, first.document.patientId)) throw documentMissing();
        return { kind: "stored" as const, document: { ...first.document, replayed: true } };
      }
    }
    if (!await inScope(client, scope, patientId)) throw new CanonicalDocumentRefusal("patient_not_found", 404, "لا يوجد مريض بهذا الرقم ضمن مرضاك.");
    const settings = await getSettingsWith(client);
    const configured = Number(settings["documents.max_megabytes"]);
    const maxBytes = Number.isFinite(configured) && configured > 0 ? Math.round(configured * 1024 * 1024) : DEFAULT_MAX_BYTES;
    const check = validateUpload({ mimeType: input.file.type, sizeBytes: input.file.size, maxBytes });
    if (!check.ok) throw invalid(check.message, "file");
    if (!contentMatchesMimeType(bytes, input.file.type)) {
      // The refusal's own evidence commits; nothing is written to disk.
      await insertAuditRow(client, {
        action: "document.upload.rejected_signature", entity: "patient_documents", entityId: String(patientId),
        details: { declared_mime: input.file.type, size: bytes.length }, ...actor,
      });
      return { kind: "rejected_signature" as const };
    }
    const dimensions = imageSize(bytes);
    // Validate the associations under their locks before the disk write; the row insert
    // re-validates them on the same transaction.
    try {
      const stored = await putFileAfterAssociations(client, patientId, input, bytes, check.extension);
      const document = await recordDocumentOn(client, {
        patientId, visitId: input.visitId, kind: input.kind as Parameters<typeof recordDocumentOn>[1]["kind"], title: input.title,
        mimeType: input.file.type, sizeBytes: stored.sizeBytes, sha256: stored.sha256, storageKey: stored.key,
        note: input.note, takenOn: input.takenOn, uploadedBy: identity.username, orthoCaseId: input.orthoCaseId,
        adjustmentId: input.adjustmentId, photoStage: input.photoStage, photoView: input.photoView,
        width: dimensions?.width ?? null, height: dimensions?.height ?? null,
      });
      await insertAuditRow(client, {
        action: "document.upload", entity: "patient_documents", entityId: document.id, entityLabel: input.title,
        details: {
          المريض: patientId, النوع: input.kind, الحجم: document.sizeBytes,
          ...(input.requestKey ? { requestKey: input.requestKey, requestFingerprint: fingerprint, requestActorId: String(identity.userId) } : {}),
        },
        ...actor,
      });
      return { kind: "stored" as const, document: { ...document, replayed: false } };
    } catch (error) {
      if (error instanceof DocumentAssociationError) throw invalid(error.message);
      throw error;
    }
  });
}

async function putFileAfterAssociations(client: DbClient, patientId: number, input: CanonicalDocumentUpload, bytes: Buffer, extension: string) {
  await validateDocumentAssociations({ patientId, visitId: input.visitId, orthoCaseId: input.orthoCaseId, adjustmentId: input.adjustmentId }, client);
  return putFile(bytes, extension);
}

/* ---------------------------------------------------------------- hide */

export async function commandCanonicalDocumentHide(session: VerifiedDurableSession, rawId: string, body: Record<string, unknown>, pool = getPool()) {
  const id = positiveId(rawId, "رقم المستند غير صالح.");
  const note = typeof body.note === "string" ? body.note : "";
  return withStaffOperation(pool, session, "patients.documents.delete", async (client, handle) => {
    const scope = await staffOperationPatientScope(client, handle, "patients.documents.delete");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const identity = await staffOperationIdentity(client, handle, "patients.documents.delete");
    const { rows: [row] } = await client.query<{ patient_id: number; title: string }>("SELECT patient_id, title FROM patient_documents WHERE id = $1 FOR UPDATE", [id]);
    if (!row || !await inScope(client, scope, row.patient_id)) throw documentMissing();
    const result = await removeDocumentOn(client, { id, actor: identity.username, note });
    if (!result.ok) throw new CanonicalDocumentRefusal("document_hide_refused", note.trim().length < 3 ? 400 : 409, result.message, note.trim().length < 3 ? "note" : undefined);
    await insertAuditRow(client, {
      action: "document.remove", entity: "patient_documents", entityId: id, entityLabel: row.title,
      details: { السبب: note.trim().slice(0, 200) }, actor: identity.username, actorRole: identity.role,
    });
    return { ok: true as const };
  });
}

/* ---------------------------------------------------------------- photo */

const PHOTO_REFUSAL = {
  not_found: () => new CanonicalDocumentRefusal("patient_not_found", 404, "لا يوجد مريض بهذا الرقم ضمن مرضاك."),
  document_not_found: () => new CanonicalDocumentRefusal("document_not_found", 404, "الصورة ليست من مستندات هذا المريض أو أُخفيت."),
  not_image: () => invalid("اختر صورة (JPG أو PNG) لا ملفًّا آخر.", "documentId"),
} as const;

export async function commandCanonicalPatientPhoto(session: VerifiedDurableSession, rawPatientId: string, body: Record<string, unknown>, pool = getPool()) {
  const patientId = positiveId(rawPatientId, "رقم الملف غير صالح.");
  const documentId = body.documentId === null ? null : Number(body.documentId);
  if (documentId !== null && (!Number.isInteger(documentId) || documentId <= 0)) throw invalid("اختر صورة من مستندات المريض.", "documentId");
  return withStaffOperation(pool, session, "patients.edit", async (client, handle) => {
    const scope = await staffOperationPatientScope(client, handle, "patients.edit");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if (!await inScope(client, scope, patientId)) throw PHOTO_REFUSAL.not_found();
    const identity = await staffOperationIdentity(client, handle, "patients.edit");
    const result = await setPatientPhotoOn(client, patientId, documentId);
    if (!result.ok) throw PHOTO_REFUSAL[result.reason]();
    await insertAuditRow(client, {
      action: "patient.photo", entity: "patient", entityId: patientId,
      entityLabel: `${result.patient.fullName} (${result.patient.patientNumber})`,
      details: { المستند: documentId }, actor: identity.username, actorRole: identity.role,
    });
    return { id: result.patient.id, photoDocumentId: documentId };
  });
}

/* ---------------------------------------------------------------- HTTP */

export function canonicalDocumentFailure(error: unknown, fallback: string): NextResponse {
  if (error instanceof CanonicalDocumentRefusal) {
    return NextResponse.json({ code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) }, { status: error.status, headers: NO_STORE });
  }
  return canonicalPatientReadFailure(error, fallback);
}
export { SIGNATURE_MISMATCH_MESSAGE };
