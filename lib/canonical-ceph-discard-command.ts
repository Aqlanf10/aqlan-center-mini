import "server-only";
import { discardCephAnalysisInTransaction, doctorOwnsPatient, getPool, insertAuditRow, patientInDoctorScopeWith } from "./db";
import { cephDraftVersionWith } from "./canonical-ceph-draft-version";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

export class CanonicalCephDiscardRefusal extends Error {
  constructor(readonly code: "invalid_ceph_discard" | "ceph_discard_not_found" | "ceph_discard_conflict" | "ceph_discard_reference_invalid", readonly status: 400 | 404 | 409, message: string) {
    super(message); this.name = "CanonicalCephDiscardRefusal";
  }
}
const missing = () => new CanonicalCephDiscardRefusal("ceph_discard_not_found", 404, "المسودة غير متاحة ضمن مرضاك.");
const conflict = () => new CanonicalCephDiscardRefusal("ceph_discard_conflict", 409, "تغيّرت المسودة أو تعذّر تثبيت حالتها. حدّث الدراسة وراجعها قبل طلب رفض جديد.");
export function parseCanonicalCephDiscard(rawId: string, body: unknown) {
  const id = Number(rawId), invalid = () => new CanonicalCephDiscardRefusal("invalid_ceph_discard", 400, "راجع المسودة الحالية وملاحظة الرفض؛ لم يُختصر النص.");
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id) || !body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const value = body as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "expectedVersion,note" || typeof value.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedVersion) || value.note !== null && (typeof value.note !== "string" || value.note.length > 4000)) throw invalid();
  return { id, expectedVersion: value.expectedVersion, note: typeof value.note === "string" ? value.note.trim() || null : null };
}

/** Preserves the existing draft-only soft discard; approved history and child rows are retained. */
export async function commandCanonicalCephDiscard(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalCephDiscard(rawId, body), action = "clinical.ceph.analyze" as const;
  try {
    return await withStaffOperation(pool, session, action, async (client, handle) => {
      let scope = await staffOperationPatientScope(client, handle, action);
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      const { rows: [initial] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM ceph_analyses WHERE id=$1 AND status<>'discarded'", [input.id]);
      if (!initial || scope.kind === "own" && !await patientInDoctorScopeWith(client, scope.clinicianPartyId, initial.patient_id)) throw missing();
      const patient = await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [initial.patient_id]);
      scope = await staffOperationPatientScope(client, handle, action);
      if (!patient.rows.length) throw missing();
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      if (scope.kind === "own" && !await doctorOwnsPatient(scope.clinicianPartyId, initial.patient_id, client, "nowait")) throw missing();
      const { rows: [study] } = await client.query<{ status: string; document_id: number; ortho_case_id: number | null }>(
        "SELECT status,document_id,ortho_case_id FROM ceph_analyses WHERE id=$1 AND patient_id=$2 AND status<>'discarded' FOR UPDATE NOWAIT", [input.id, initial.patient_id]);
      if (!study) throw missing();
      if (study.status !== "draft") throw conflict();
      const document = await client.query("SELECT id FROM patient_documents WHERE id=$1 AND patient_id=$2 FOR SHARE NOWAIT", [study.document_id, initial.patient_id]);
      if (!document.rows.length) throw new CanonicalCephDiscardRefusal("ceph_discard_reference_invalid", 409, "تعذّر التحقق من مراجع المسودة؛ لم تتغيّر حالتها.");
      if (study.ortho_case_id !== null) {
        const ortho = await client.query("SELECT id FROM ortho_cases WHERE id=$1 AND patient_id=$2 FOR SHARE NOWAIT", [study.ortho_case_id, initial.patient_id]);
        if (!ortho.rows.length) throw new CanonicalCephDiscardRefusal("ceph_discard_reference_invalid", 409, "تعذّر التحقق من مراجع المسودة؛ لم تتغيّر حالتها.");
      }
      if (await cephDraftVersionWith(client, input.id, true) !== input.expectedVersion) throw conflict();
      const actor = await staffOperationIdentity(client, handle, action);
      const result = await discardCephAnalysisInTransaction(client, input.id, input.note);
      if (!result.ok) throw conflict();
      await insertAuditRow(client, { action: "ceph.discard", entity: "ceph_analysis", entityId: input.id, entityLabel: input.note?.slice(0, 120) ?? null, actor: actor.username, actorRole: actor.role });
      await assertStaffOperation(client, handle, action);
      return { ok: true as const, studyId: input.id, status: "discarded" as const };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "CEPH_DRAFT_VERSION_LIMIT") throw conflict();
    if (error && typeof error === "object" && "code" in error && ["55P03", "40P01", "40001"].includes(String(error.code))) throw conflict();
    throw error;
  }
}
