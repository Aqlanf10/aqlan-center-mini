import "server-only";
import { completeCephAnalysisInTransaction, doctorOwnsPatient, getPool, insertAuditRow, patientInDoctorScopeWith } from "./db";
import { cephDraftVersionWith } from "./canonical-ceph-draft-version";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

export class CanonicalCephCompleteRefusal extends Error {
  constructor(readonly code: "invalid_ceph_complete" | "ceph_complete_not_found" | "ceph_complete_conflict" | "ceph_complete_reference_invalid" | "ceph_complete_conditions", readonly status: 400 | 404 | 409, message: string) {
    super(message); this.name = "CanonicalCephCompleteRefusal";
  }
}
const missing = () => new CanonicalCephCompleteRefusal("ceph_complete_not_found", 404, "المسودة غير متاحة ضمن مرضاك.");
const conflict = () => new CanonicalCephCompleteRefusal("ceph_complete_conflict", 409, "تغيّرت المسودة أو تعذّر تثبيت حالتها. حدّث الدراسة وراجعها قبل اعتماد جديد.");
export function parseCanonicalCephComplete(rawId: string, body: unknown) {
  const id = Number(rawId), invalid = () => new CanonicalCephCompleteRefusal("invalid_ceph_complete", 400, "اعتماد الدراسة يتطلب قراءة المسودة الحالية وتأكيدًا صريحًا.");
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id) || id > 2147483647 || !body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const value = body as Record<string, unknown>;
  if (Object.keys(value).join(",") !== "expectedVersion" || typeof value.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedVersion)) throw invalid();
  return { id, expectedVersion: value.expectedVersion };
}

/** Explicit approval of one observed saved draft; no new image access or historical repair. */
export async function commandCanonicalCephComplete(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalCephComplete(rawId, body), action = "clinical.ceph.analyze" as const;
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
      if (!document.rows.length) throw new CanonicalCephCompleteRefusal("ceph_complete_reference_invalid", 409, "تعذّر التحقق من مراجع المسودة؛ لم تتغيّر حالتها.");
      if (study.ortho_case_id !== null) {
        const ortho = await client.query("SELECT id FROM ortho_cases WHERE id=$1 AND patient_id=$2 FOR SHARE NOWAIT", [study.ortho_case_id, initial.patient_id]);
        if (!ortho.rows.length) throw new CanonicalCephCompleteRefusal("ceph_complete_reference_invalid", 409, "تعذّر التحقق من مراجع المسودة؛ لم تتغيّر حالتها.");
      }
      if (await cephDraftVersionWith(client, input.id, true) !== input.expectedVersion) throw conflict();
      const actor = await staffOperationIdentity(client, handle, action);
      const done = await completeCephAnalysisInTransaction(client, input.id, actor.username);
      if (!done.result.ok) throw new CanonicalCephCompleteRefusal("ceph_complete_conditions", 409, done.result.message ?? "تعذّر اعتماد المسودة الحالية.");
      await insertAuditRow(client, { action: "ceph.complete", entity: "ceph_analysis", entityId: input.id, entityLabel: done.auditLabel, actor: actor.username, actorRole: actor.role });
      const budget = (await client.query<{ landmarks: string; measurements: string; bytes: string }>(`SELECT
        (SELECT count(*)::text FROM ceph_landmarks WHERE analysis_id=$1) landmarks,
        (SELECT count(*)::text FROM ceph_measurements WHERE analysis_id=$1) measurements,
        (octet_length(to_jsonb(a)::text)
          +COALESCE((SELECT sum(octet_length(to_jsonb(l)::text)) FROM ceph_landmarks l WHERE analysis_id=$1),0)
          +COALESCE((SELECT sum(octet_length(to_jsonb(m)::text)) FROM ceph_measurements m WHERE analysis_id=$1),0)
          +COALESCE((SELECT sum(octet_length(to_jsonb(d)::text)) FROM ceph_diagnoses d WHERE analysis_id=$1),0))::text bytes
        FROM ceph_analyses a WHERE id=$1`, [input.id])).rows[0];
      if (!budget || !Object.values(budget).every(value => Number.isSafeInteger(Number(value)) && Number(value) >= 0)
        || Number(budget.landmarks) > 256 || Number(budget.measurements) > 256 || Number(budget.bytes) > 2 * 1024 * 1024) throw conflict();
      await assertStaffOperation(client, handle, action);
      return { ok: true as const, studyId: input.id, status: "completed" as const };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "CEPH_DRAFT_VERSION_LIMIT") throw conflict();
    if (error && typeof error === "object" && "code" in error && ["55P03", "40P01", "40001"].includes(String(error.code))) throw conflict();
    throw error;
  }
}
