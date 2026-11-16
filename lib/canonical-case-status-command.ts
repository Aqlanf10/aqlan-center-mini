import "server-only";
import { changeClinicalCaseStatusInTransaction, doctorOwnsPatient, getPool, patientInDoctorScopeWith } from "./db";
import { CASE_STATUSES, type CaseStatus } from "./cases";
import { clinicalCaseStatusVersion } from "./canonical-case-status-version";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

export class CanonicalCaseStatusRefusal extends Error {
  constructor(readonly code: "invalid_case_status" | "case_status_not_found" | "case_status_conflict" | "case_status_transition" | "case_status_ortho_managed" | "case_status_capability_denied", readonly status: 400 | 403 | 404 | 409, message: string) { super(message); this.name = "CanonicalCaseStatusRefusal"; }
}
const missing = () => new CanonicalCaseStatusRefusal("case_status_not_found",404,"الحالة غير متاحة ضمن مرضاك.");
const conflict = () => new CanonicalCaseStatusRefusal("case_status_conflict",409,"تغيّرت الحالة أو تعذّر تثبيت سياقها. حدّث السجل وراجع النتيجة قبل طلب جديد.");
const invalid = () => new CanonicalCaseStatusRefusal("invalid_case_status",400,"راجع حالة العلاج والنتيجة؛ إلغاء الحالة يحتاج سببًا مكتوبًا.");
export function parseCanonicalCaseStatus(rawId:string,body:unknown){
  const id=Number(rawId);
  if(!/^[1-9]\d*$/.test(rawId)||!Number.isSafeInteger(id)||id<1||id>2147483647||!body||typeof body!=="object"||Array.isArray(body))throw invalid();
  const r=body as Record<string,unknown>;
  if(Object.keys(r).sort().join(",")!=="expectedVersion,outcome,status"||!CASE_STATUSES.includes(r.status as CaseStatus)
    ||typeof r.expectedVersion!=="string"||!/^[a-f0-9]{64}$/.test(r.expectedVersion)||r.outcome!==null&&(typeof r.outcome!=="string"||r.outcome.length>2000))throw invalid();
  const outcome=typeof r.outcome==="string"?r.outcome.trim()||null:null;
  if(r.status==="cancelled"&&!outcome)throw invalid();
  return {id,status:r.status as CaseStatus,outcome,expectedVersion:r.expectedVersion};
}

/** Uses the existing clinical transition engine; no reassignment, native ortho
 * state mutation or post-commit rich/financial reader. */
export async function commandCanonicalCaseStatus(session:VerifiedDurableSession,rawId:string,body:unknown,pool=getPool()){
  const input=parseCanonicalCaseStatus(rawId,body),action="clinical.plans.edit" as const;
  try{return await withStaffOperation(pool,session,action,async(client,handle)=>{
    let scope=await staffOperationPatientScope(client,handle,action);
    if(scope.kind==="none")throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const {rows:[initial]}=await client.query<{patient_id:number}>("SELECT patient_id FROM clinical_cases WHERE id=$1",[input.id]);
    if(!initial||scope.kind==="own"&&!await patientInDoctorScopeWith(client,scope.clinicianPartyId,initial.patient_id))throw missing();
    const patient=await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE",[initial.patient_id]);
    scope=await staffOperationPatientScope(client,handle,action);
    const {rows:[row]}=await client.query<{id:number;patientId:number;specialty:string;orthoCaseId:number|null;status:string;outcome:string|null;completedAt:string|null;versionXmin:string;versionTid:string}>(`SELECT id,patient_id AS "patientId",specialty,ortho_case_id AS "orthoCaseId",status,outcome,completed_at::text AS "completedAt",xmin::text AS "versionXmin",ctid::text AS "versionTid" FROM clinical_cases WHERE id=$1 FOR UPDATE NOWAIT`,[input.id]);
    if(!patient.rows.length||!row)throw missing();
    if(row.patientId!==initial.patient_id)throw conflict();
    if(scope.kind==="none")throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if(scope.kind==="own"&&!await doctorOwnsPatient(scope.clinicianPartyId,row.patientId,client,"nowait"))throw missing();
    const capabilities=await staffOperationCapabilities(client,handle,action,["clinical.ortho.view"]);
    if((row.specialty==="orthodontics"||row.orthoCaseId!==null)&&!capabilities.has("clinical.ortho.view"))throw new CanonicalCaseStatusRefusal("case_status_capability_denied",403,"حالة التقويم تحتاج صلاحية عرض التقويم المستقلة.");
    // A bridged case is always managed through the native ortho lifecycle, even
    // for the protected owner. Never create a second source of its status.
    if(row.orthoCaseId!==null)throw new CanonicalCaseStatusRefusal("case_status_ortho_managed",409,"حالة التقويم تُدار وتُغلق من «التقويم وسيفالو».");
    if(clinicalCaseStatusVersion(row)!==input.expectedVersion)throw conflict();
    const actor=await staffOperationIdentity(client,handle,action);
    const result=await changeClinicalCaseStatusInTransaction(client,{id:input.id,status:input.status,outcome:input.outcome,actor:actor.username,actorRole:actor.role});
    if(!result.ok){
      if(result.reason==="not_found")throw missing();
      if(result.reason==="ortho_managed")throw new CanonicalCaseStatusRefusal("case_status_ortho_managed",409,"حالة التقويم تُدار وتُغلق من «التقويم وسيفالو».");
      throw new CanonicalCaseStatusRefusal("case_status_transition",409,"لا يمكن نقل الحالة إلى هذه الحالة — المنتهية لا تُعاد فتحها؛ افتح حالةً جديدة.");
    }
    await assertStaffOperation(client,handle,action);
    return {ok:true as const,caseId:input.id,status:input.status};
  });}catch(error){
    if(error&&typeof error==="object"&&"code" in error&&["55P03","40P01","40001"].includes(String(error.code)))throw conflict();
    throw error;
  }
}
