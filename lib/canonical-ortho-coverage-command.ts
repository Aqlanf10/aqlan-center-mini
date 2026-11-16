import "server-only";
import { doctorOwnsPatient, getPool, patientInDoctorScopeWith } from "./db";
import { appendFollowupCoverageWith, FollowupCoverageError } from "./ortho-followup-coverage-db";
import { canonicalCoverageStatusCommand } from "./canonical-ortho-coverage-status";
import { isFollowupCoverageRejection, readFollowupCoverageReceipt } from "./ortho-followup-coverage-recovery";
import { assertStaffOperation, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";
import type { VerifiedDurableSession } from "./staff-durable-session";
const missing=()=>new FollowupCoverageError(404,"coverage_command_unavailable","الحالة غير متاحة ضمن مرضاك.");
/** Existing routine coverage decision only. No new invoice, cash, retrospective
 * signed-proof change or financial policy; exact native durable command reused. */
export async function commandCanonicalFollowupCoverage(session:VerifiedDurableSession,patientId:number,caseId:number,body:unknown,pool=getPool()){
 const command=canonicalCoverageStatusCommand(patientId,caseId,body),action="finance.agreements.manage" as const;
 try{
  const outcome=await withStaffOperation(pool,session,action,async(client,handle)=>{
   const scope=await staffOperationPatientScope(client,handle,action);
   if(scope.kind==="none")throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
   if(scope.kind==="own"&&!await patientInDoctorScopeWith(client,scope.clinicianPartyId,patientId))throw missing();
   if(!(await client.query("SELECT id FROM ortho_cases WHERE id=$1 AND patient_id=$2",[caseId,patientId])).rows.length)throw missing();
   const actor=await staffOperationIdentity(client,handle,action);
   const assertCurrent=async()=>{
    await assertStaffOperation(client,handle,action);
    const fresh=await staffOperationPatientScope(client,handle,action);
    if(fresh.kind==="none")throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if(fresh.kind==="own"&&!await doctorOwnsPatient(fresh.clinicianPartyId,patientId,client,"nowait"))throw missing();
    if(!(await client.query("SELECT id FROM ortho_cases WHERE id=$1 AND patient_id=$2",[caseId,patientId])).rows.length)throw missing();
   };
   const result=await appendFollowupCoverageWith(client,{patientId,orthoCaseId:caseId},command,{userId:actor.userId,username:actor.username,role:actor.role},patientId,{bounded:true,assertCurrent});
   const attempt={actor:actor.username,patientId,orthoCaseId:caseId,command};
   if(result.state==="committed"&&!readFollowupCoverageReceipt(result.revision,attempt)
    ||result.state==="rejected"&&(!isFollowupCoverageRejection(result,attempt)||result.rejection.actorUserId!==actor.userId))
     throw new FollowupCoverageError(409,"coverage_receipt_invalid","تعذّر التحقق من إيصال الطلب؛ يبقى معلّقًا.");
   await assertCurrent();
   return result;
  });
  // A native terminal refusal is itself a committed audited result. Translating
  // it inside the transaction callback would roll back its durable tombstone.
  if(outcome.state==="rejected")throw new FollowupCoverageError(409,outcome.rejection.code,outcome.rejection.message,outcome.rejection);
  return {ok:true as const,replayed:outcome.replayed,revision:outcome.revision};
 }catch(error){
  if(error&&typeof error==="object"&&"code" in error&&["55P03","40P01","40001"].includes(String(error.code)))throw new FollowupCoverageError(409,"coverage_command_conflict","تعذّر تثبيت الحالة أو المصدر؛ تحقق من نتيجة الطلب نفسه قبل المتابعة.");
  throw error;
 }
}
