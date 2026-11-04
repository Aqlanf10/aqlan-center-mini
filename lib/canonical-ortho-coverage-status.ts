import "server-only";
import { doctorOwnsPatient, getPool, patientInDoctorScopeWith } from "./db";
import { FollowupCoverageError, followupCoverageAvailable, readFollowupCoverageReceiptWith } from "./ortho-followup-coverage-db";
import { parseFollowupCoverageCommand } from "./ortho-followup-coverage";
import { isFollowupCoverageRejection, readFollowupCoverageReceipt } from "./ortho-followup-coverage-recovery";
import { assertStaffOperation, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";
import type { VerifiedDurableSession } from "./staff-durable-session";
const missing=()=>new FollowupCoverageError(404,"coverage_status_unavailable","الحالة غير متاحة ضمن مرضاك.");
const invalidReceipt=()=>new FollowupCoverageError(409,"coverage_receipt_invalid","تعذّر التحقق من إيصال الطلب؛ يبقى معلّقًا.");
export function canonicalCoverageStatusCommand(patientId:number,caseId:number,body:unknown){
 const command=parseFollowupCoverageCommand(body);
 if(!command||command.source.patientId!==patientId||command.source.orthoCaseId!==caseId)throw new FollowupCoverageError(400,"invalid_command","طلب التحقق من نطاق التغطية غير صالح.");
 return command;
}
/** Exact existing outcome only. This admits neither a new decision nor a retry. */
export async function readCanonicalCoverageCommandStatus(session:VerifiedDurableSession,patientId:number,caseId:number,body:unknown,pool=getPool()){
 const command=canonicalCoverageStatusCommand(patientId,caseId,body),action="finance.agreements.manage" as const;
 try{return await withStaffOperation(pool,session,action,async(client,handle)=>{
  let scope=await staffOperationPatientScope(client,handle,action);
  if(scope.kind==="none")throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  if(scope.kind==="own"&&!await patientInDoctorScopeWith(client,scope.clinicianPartyId,patientId))throw missing();
  if(!(await client.query("SELECT id FROM ortho_cases WHERE id=$1 AND patient_id=$2",[caseId,patientId])).rows.length)throw missing();
  if(!await followupCoverageAvailable(client))throw new FollowupCoverageError(503,"coverage_not_ready","سجل نطاق المتابعات غير جاهز للتحقق.");
  // Same receipt fence as the compatibility writer; a missing row is never a
  // rejection while another transaction may still be deciding the outcome.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["ortho-followup-command:"+command.commandId]);
  await assertStaffOperation(client,handle,action);
  if(!(await client.query("SELECT id FROM patients WHERE id=$1 FOR SHARE NOWAIT",[patientId])).rows.length)throw missing();
  scope=await staffOperationPatientScope(client,handle,action);
  if(scope.kind==="none")throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  if(scope.kind==="own"&&!await doctorOwnsPatient(scope.clinicianPartyId,patientId,client,"nowait"))throw missing();
  if(!(await client.query("SELECT id FROM ortho_cases WHERE id=$1 AND patient_id=$2 FOR SHARE NOWAIT",[caseId,patientId])).rows.length)throw missing();
  const actor=await staffOperationIdentity(client,handle,action);
  const result=await readFollowupCoverageReceiptWith(client,{patientId,orthoCaseId:caseId,actorUserId:actor.userId,command});
  const attempt={actor:actor.username,patientId,orthoCaseId:caseId,command};
  if(result.state==="committed"&&!readFollowupCoverageReceipt(result.revision,attempt))throw invalidReceipt();
  if(result.state==="rejected"&&(!isFollowupCoverageRejection(result,attempt)||result.rejection.actorUserId!==actor.userId))throw invalidReceipt();
  await assertStaffOperation(client,handle,action);
  return result;
 });}catch(error){
  if(error&&typeof error==="object"&&"code" in error&&["55P03","40P01","40001"].includes(String(error.code)))throw new FollowupCoverageError(409,"coverage_status_conflict","تعذّر تثبيت الحالة؛ لا تزال نتيجة الطلب بحاجة للتحقق.");
  if(error instanceof RangeError)throw invalidReceipt();
  throw error;
 }
}
