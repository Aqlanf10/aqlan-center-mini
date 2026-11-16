import "server-only";
import { createCephAnalysisInTransaction, doctorOwnsPatient, getPool, insertAuditRow, patientInDoctorScopeWith, type CephPhase } from "./db";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

export class CanonicalCephCreateRefusal extends Error {
  constructor(readonly code: "invalid_ceph_create" | "ceph_create_not_found" | "ceph_create_conflict" | "ceph_create_reference_invalid", readonly status: 400 | 404 | 409, message: string) {
    super(message); this.name = "CanonicalCephCreateRefusal";
  }
}
const invalid = () => new CanonicalCephCreateRefusal("invalid_ceph_create", 400, "بيانات فتح مسودة السيفالومتري غير صالحة.");
const missing = () => new CanonicalCephCreateRefusal("ceph_create_not_found", 404, "المريض غير متاح ضمن مرضاك.");
const conflict = () => new CanonicalCephCreateRefusal("ceph_create_conflict", 409, "تعذّر فتح المسودة من الحالة الحالية. راجع الدراسات قبل طلب جديد.");
const reference = () => new CanonicalCephCreateRefusal("ceph_create_reference_invalid", 409, "تعذّر التحقق من صورة المريض أو الحالة المرتبطة؛ لم تُنشأ مسودة.");
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

/** One new intention. The native single-draft constraint is not a permanent request receipt. */
export async function commandCanonicalCephCreate(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalCephCreate(rawId, body), action = "clinical.xrays.upload" as const;
  try {
    return await withStaffOperation(pool, session, action, async (client, handle) => {
      let scope = await staffOperationPatientScope(client, handle, action);
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      if (scope.kind === "own" && !await patientInDoctorScopeWith(client, scope.clinicianPartyId, input.patientId)) throw missing();
      const patient = await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [input.patientId]);
      scope = await staffOperationPatientScope(client, handle, action);
      if (!patient.rows.length) throw missing();
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      if (scope.kind === "own" && !await doctorOwnsPatient(scope.clinicianPartyId, input.patientId, client, "nowait")) throw missing();
      const { rows: [document] } = await client.query<{ mime_type: string; removed_at: Date | null }>("SELECT mime_type,removed_at FROM patient_documents WHERE id=$1 AND patient_id=$2 FOR SHARE NOWAIT", [input.documentId, input.patientId]);
      if (!document || document.removed_at !== null || !document.mime_type.startsWith("image/")) throw reference();
      if (input.orthoCaseId !== null) {
        // The same independent grant that admits the case chooser also gates a
        // hand-crafted link. The exact operation reloads authority after waiting.
        const grants = await staffOperationCapabilities(client, handle, action, ["clinical.ortho.view"]);
        if (!grants.has("clinical.ortho.view")) throw new Error("STAFF_OPERATION_CAPABILITY_DENIED");
        const ortho = await client.query("SELECT id FROM ortho_cases WHERE id=$1 AND patient_id=$2 FOR SHARE NOWAIT", [input.orthoCaseId, input.patientId]);
        if (!ortho.rows.length) throw reference();
      }
      // A draft still open is a conflict, never a cached receipt or an instruction to resend.
      if ((await client.query("SELECT id FROM ceph_analyses WHERE patient_id=$1 AND status='draft' LIMIT 1", [input.patientId])).rows.length) throw conflict();
      const { rows: [history] } = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM ceph_analyses WHERE patient_id=$1 AND document_id=$2 AND status<>'discarded'", [input.patientId, input.documentId]);
      const count = Number(history.count);
      if (!Number.isSafeInteger(count) || count < 0) throw conflict();
      const actor = await staffOperationIdentity(client, handle, action);
      const created = await createCephAnalysisInTransaction(client, { ...input, createdBy: actor.username });
      if (!created.ok || !positive(Number(created.id))) throw conflict();
      const id = Number(created.id);
      await insertAuditRow(client, { action: "ceph.create", entity: "ceph_analysis", entityId: String(id), entityLabel: `على المستند #${input.documentId} — مرحلة ${input.phase}`, actor: actor.username, actorRole: actor.role });
      await assertStaffOperation(client, handle, action);
      return { id, duplicateWarning: count > 0 ? `لهذه الصورة ${count} دراسة سابقة؛ تأكد أن فتح دراسة أخرى مقصود.` : null };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["55P03", "40P01", "40001", "23505"].includes(String(error.code))) throw conflict();
    throw error;
  }
}
