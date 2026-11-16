import "server-only";
import { changePatientProblemStatusInTransaction, doctorOwnsPatient, getPool, patientInDoctorScopeWith } from "./db";
import { PROBLEM_STATUSES, type ProblemStatus } from "./cases";
import { clinicalProblemStatusVersion } from "./canonical-problem-status-version";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

export class CanonicalProblemStatusRefusal extends Error {
  constructor(readonly code: "invalid_problem_status" | "problem_status_not_found" | "problem_status_conflict" | "problem_status_unchanged", readonly status: 400 | 404 | 409, message: string) { super(message); this.name = "CanonicalProblemStatusRefusal"; }
}
const missing = () => new CanonicalProblemStatusRefusal("problem_status_not_found",404,"المشكلة غير متاحة ضمن مرضاك.");
const conflict = () => new CanonicalProblemStatusRefusal("problem_status_conflict",409,"تغيّرت المشكلة أو تعذّر تثبيت سياقها. حدّث السجل وراجع النتيجة قبل طلب جديد.");
export function parseCanonicalProblemStatus(rawId: string, body: unknown) {
  const id = Number(rawId), invalid = () => new CanonicalProblemStatusRefusal("invalid_problem_status",400,"راجع رقم المشكلة وحالتها ونسختها الحالية.");
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id) || id > 2147483647 || !body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const r = body as Record<string,unknown>;
  if (Object.keys(r).sort().join(",") !== "expectedVersion,status" || !PROBLEM_STATUSES.includes(r.status as ProblemStatus) || typeof r.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(r.expectedVersion)) throw invalid();
  return {id,status:r.status as ProblemStatus,expectedVersion:r.expectedVersion};
}
/** Changes only the already-visible clinical problem state; never its patient or case link. */
export async function commandCanonicalProblemStatus(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalProblemStatus(rawId,body), action = "clinical.visits.document" as const;
  try { return await withStaffOperation(pool,session,action,async(client,handle) => {
    let scope = await staffOperationPatientScope(client,handle,action);
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const {rows:[initial]} = await client.query<{patient_id:number}>("SELECT patient_id FROM patient_problems WHERE id=$1",[input.id]);
    if (!initial || scope.kind === "own" && !await patientInDoctorScopeWith(client,scope.clinicianPartyId,initial.patient_id)) throw missing();
    const patient = await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE",[initial.patient_id]);
    scope = await staffOperationPatientScope(client,handle,action);
    const {rows:[row]} = await client.query<{id:number;patientId:number;status:string;resolvedAt:string|null;resolvedBy:string|null;versionXmin:string;versionTid:string}>(`SELECT id,patient_id AS "patientId",status,resolved_at::text AS "resolvedAt",resolved_by AS "resolvedBy",xmin::text AS "versionXmin",ctid::text AS "versionTid" FROM patient_problems WHERE id=$1 FOR UPDATE NOWAIT`,[input.id]);
    if (!patient.rows.length || !row) throw missing();
    if (row.patientId !== initial.patient_id) throw conflict();
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if (scope.kind === "own" && !await doctorOwnsPatient(scope.clinicianPartyId,row.patientId,client,"nowait")) throw missing();
    if (clinicalProblemStatusVersion(row) !== input.expectedVersion) throw conflict();
    const actor = await staffOperationIdentity(client,handle,action);
    const result = await changePatientProblemStatusInTransaction(client,{id:input.id,status:input.status,actor:actor.username,actorRole:actor.role});
    if (!result.ok) { if (result.reason === "not_found") throw missing(); throw new CanonicalProblemStatusRefusal("problem_status_unchanged",409,"المشكلة بهذه الحالة سلفًا."); }
    await assertStaffOperation(client,handle,action);
    return {ok:true as const,problemId:input.id,status:input.status};
  }); } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["55P03","40P01","40001"].includes(String(error.code))) throw conflict();
    throw error;
  }
}
