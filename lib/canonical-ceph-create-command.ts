import "server-only";
import { createCephAnalysis, getPool, type CephPhase } from "./db";
import { CanonicalCephWriteFailure, runCanonicalCephWrite } from "./canonical-ceph-write";
import { staffOperationCapabilities } from "./staff-operation-runtime";
import type { VerifiedDurableSession } from "./staff-durable-session";

export class CanonicalCephCreateRefusal extends Error {
  constructor(readonly code: "invalid_ceph_create" | "ceph_create_not_found" | "ceph_create_conflict" | "ceph_create_session_expired", readonly status: 400 | 401 | 404 | 409, message: string) {
    super(message); this.name = "CanonicalCephCreateRefusal";
  }
}
const invalid = () => new CanonicalCephCreateRefusal("invalid_ceph_create", 400, "بيانات فتح مسودة السيفالومتري غير صالحة.");
// One private refusal for a hidden, removed, foreign or missing image or case, as in #539.
const reference = () => new CanonicalCephWriteFailure("conflict", "تعذّر التحقق من صورة المريض أو الحالة المرتبطة؛ لم تُنشأ مسودة.");
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const phases = new Set(["pretreatment", "during", "posttreatment", "followup"]);
export function parseCanonicalCephCreate(raw: string, body: unknown) {
  const patientId = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(patientId) || patientId > 2147483647 || !body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const row = body as Record<string, unknown>;
  if (Object.keys(row).some(k => !["documentId", "orthoCaseId", "phase", "xrayDate", "device", "refSet"].includes(k)) || !positive(row.documentId)) throw invalid();
  if (row.orthoCaseId !== undefined && row.orthoCaseId !== null && !positive(row.orthoCaseId)) throw invalid();
  if (row.phase !== undefined && (typeof row.phase !== "string" || !phases.has(row.phase))) throw invalid();
  const text = (value: unknown, max: number) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.length > max) throw invalid();
    return value.trim() || null;
  };
  const date = row.xrayDate;
  if (date !== undefined && date !== null && (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < "0001-01-01" || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) throw invalid();
  return { patientId, documentId: row.documentId, orthoCaseId: row.orthoCaseId as number | null | undefined ?? null, phase: (row.phase ?? "pretreatment") as CephPhase, xrayDate: date as string | null | undefined ?? null, device: text(row.device, 120), refSet: text(row.refSet, 60) };
}

/**
 * One new draft through staging's protected creator (patient → image lock order, same-patient
 * image and orthodontic case, audit), admitted by clinical.xrays.upload and current patient scope.
 * Before the creator runs, #539's checks hold in the same transaction: the image must be the patient's
 * current image (one private refusal for hidden, removed, foreign or missing references), and linking an
 * orthodontic case needs the same clinical.ortho.view grant that shows the case chooser.
 */
export async function commandCanonicalCephCreate(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalCephCreate(rawId, body);
  try {
    return await runCanonicalCephWrite(session, "clinical.xrays.upload", { kind: "patient", patientId: input.patientId, documentId: input.documentId }, async ({ client, handle, admit }) => {
      await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [input.patientId]);
      const { rows: [document] } = await client.query<{ mime_type: string; removed_at: Date | null }>(
        "SELECT mime_type,removed_at FROM patient_documents WHERE id=$1 AND patient_id=$2 FOR SHARE NOWAIT", [input.documentId, input.patientId]);
      if (!document || document.removed_at !== null || !document.mime_type.startsWith("image/")) throw reference();
      if (input.orthoCaseId !== null) {
        const grants = await staffOperationCapabilities(client, handle, "clinical.xrays.upload", ["clinical.ortho.view"]);
        if (!grants.has("clinical.ortho.view")) throw new Error("STAFF_OPERATION_CAPABILITY_DENIED");
        const ortho = await client.query("SELECT id FROM ortho_cases WHERE id=$1 AND patient_id=$2 FOR SHARE NOWAIT", [input.orthoCaseId, input.patientId]);
        if (!ortho.rows.length) throw reference();
      }
      const { rows: [history] } = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ceph_analyses WHERE patient_id=$1 AND document_id=$2 AND status<>'discarded'", [input.patientId, input.documentId]);
      const count = Number(history.count);
      const created = await createCephAnalysis({ patientId: input.patientId, documentId: input.documentId, createdBy: "",
        orthoCaseId: input.orthoCaseId, phase: input.phase, xrayDate: input.xrayDate, device: input.device, refSet: input.refSet },
      { patientId: input.patientId, documentId: input.documentId, admit });
      if (!created.ok) return created;
      const duplicateWarning = count > 0 ? `لهذه الصورة ${count} دراسة سابقة؛ تأكد أن فتح دراسة أخرى مقصود.` : null;
      return { ok: true as const, value: { id: created.id, duplicateWarning } };
    }, pool);
  } catch (error) {
    if (error instanceof CanonicalCephWriteFailure) throw new CanonicalCephCreateRefusal(
      error.kind === "not_found" ? "ceph_create_not_found" : error.kind === "expired" ? "ceph_create_session_expired" : "ceph_create_conflict",
      error.kind === "not_found" ? 404 : error.kind === "expired" ? 401 : 409, error.message);
    throw error;
  }
}
