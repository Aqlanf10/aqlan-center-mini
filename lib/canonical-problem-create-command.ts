import "server-only";
import { createPatientProblemInTransaction, doctorOwnsPatient, getPool, patientInDoctorScopeWith } from "./db";
import { checkProblemDraft } from "./cases";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

export class CanonicalProblemCreateRefusal extends Error {
  constructor(readonly code: "invalid_problem_create" | "problem_create_patient_not_found" | "problem_create_case_not_found" | "problem_create_conflict", readonly status: 400 | 404 | 409, message: string) { super(message); this.name = "CanonicalProblemCreateRefusal"; }
}
const missing = () => new CanonicalProblemCreateRefusal("problem_create_patient_not_found",404,"المريض غير متاح ضمن مرضاك.");
const missingCase = () => new CanonicalProblemCreateRefusal("problem_create_case_not_found",404,"الحالة المختارة غير متاحة لهذا المريض.");
const conflict = () => new CanonicalProblemCreateRefusal("problem_create_conflict",409,"تعذّر تثبيت سجل المريض والحالة. حدّث القائمة وراجع النتيجة قبل طلب جديد.");
export function parseCanonicalProblemCreate(rawId: string, body: unknown) {
  const patientId = Number(rawId), invalid = () => new CanonicalProblemCreateRefusal("invalid_problem_create",400,"راجع المشكلة وموضعها وتخصصها والحالة المختارة؛ لم يُختصر النص.");
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(patientId) || patientId > 2147483647 || !body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const value = body as Record<string,unknown>;
  if (Object.keys(value).sort().join(",") !== "caseId,label,site,specialty" || typeof value.label !== "string" || value.label.length > 200 || value.site !== null && (typeof value.site !== "string" || value.site.length > 60) || value.specialty !== null && (typeof value.specialty !== "string" || !value.specialty) || value.caseId !== null && (typeof value.caseId !== "number" || !Number.isSafeInteger(value.caseId) || value.caseId <= 0 || value.caseId > 2147483647)) throw invalid();
  const draft = checkProblemDraft(value);
  if (!draft.ok) throw invalid();
  return {patientId,...draft.value};
}
/** Creates clinical documentation only; a case link never assigns responsibility. */
export async function commandCanonicalProblemCreate(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalProblemCreate(rawId,body), action = "clinical.visits.document" as const;
  try { return await withStaffOperation(pool,session,action,async(client,handle) => {
    let scope = await staffOperationPatientScope(client,handle,action);
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if (scope.kind === "own" && !await patientInDoctorScopeWith(client,scope.clinicianPartyId,input.patientId)) throw missing();
    const patient = await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE",[input.patientId]);
    scope = await staffOperationPatientScope(client,handle,action);
    if (!patient.rows.length) throw missing();
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if (scope.kind === "own" && !await doctorOwnsPatient(scope.clinicianPartyId,input.patientId,client,"nowait")) throw missing();
    if (input.caseId !== null) {
      const capabilities = await staffOperationCapabilities(client,handle,action,["clinical.ortho.view"]);
      const {rows:[linked]} = await client.query<{patient_id:number;specialty:string;ortho_case_id:number|null}>("SELECT patient_id,specialty,ortho_case_id FROM clinical_cases WHERE id=$1 AND patient_id=$2 AND ($3::boolean OR (ortho_case_id IS NULL AND specialty <> 'orthodontics')) FOR SHARE NOWAIT",[input.caseId,input.patientId,capabilities.has("clinical.ortho.view")]);
      if (!linked || linked.patient_id !== input.patientId) throw missingCase();
      if ((linked.specialty === "orthodontics" || linked.ortho_case_id !== null) && !capabilities.has("clinical.ortho.view")) throw missingCase();
      if (linked.ortho_case_id !== null) {
        const native = await client.query("SELECT id FROM ortho_cases WHERE id=$1 AND patient_id=$2 FOR SHARE NOWAIT",[linked.ortho_case_id,input.patientId]);
        if (!native.rows.length || linked.specialty !== "orthodontics") throw missingCase();
      }
    }
    const actor = await staffOperationIdentity(client,handle,action);
    const result = await createPatientProblemInTransaction(client,{...input,actor:actor.username,actorRole:actor.role});
    if (!result.ok) { if (result.reason === "no_patient") throw missing(); throw missingCase(); }
    await assertStaffOperation(client,handle,action);
    return {ok:true as const,problemId:result.problemId};
  }); } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["55P03","40P01","40001"].includes(String(error.code))) throw conflict();
    throw error;
  }
}
