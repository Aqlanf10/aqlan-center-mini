import type {SessionPayload} from './auth';
import {getPool,insertAuditRow} from './db';
import {canAccessPatient} from './patient-access';
import {revalidateSessionInTransaction} from './session';
import {PHASE_ORDER,type OrthoPhase} from './ortho';
export interface OrthoPhaseRequest {patientId:number;session:SessionPayload}
export class OrthoPhaseAuthorityError extends Error {
 constructor(readonly status:400|401|403|409,readonly code:string,message:string){super(message);}
}
function fail(status:400|401|403|409,code:string,message:string):never{throw new OrthoPhaseAuthorityError(status,code,message);}
const positive=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0;
/** Authenticated phase metadata only. Never infers delivery or changes lifecycle. */
export async function writeAuthorizedOrthoPhase(id:number,phase:OrthoPhase,request:OrthoPhaseRequest):Promise<boolean>{
 if(!PHASE_ORDER.includes(phase))return false;
 if(!positive(id)||!request||!positive(request.patientId)||!positive(request.session?.userId)||typeof request.session?.username!=='string')fail(400,'invalid_phase_request','هوية طلب تغيير المرحلة غير صالحة.');
 const client=await getPool().connect();
 try{
  await client.query('BEGIN');
  // Match merge/sign-off order: patient, current account/access witnesses, case.
  await client.query('SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE',[request.patientId]);
  const current=await revalidateSessionInTransaction(request.session,client);
  if(!current||current.userId!==request.session.userId||current.username!==request.session.username||current.role!==request.session.role||current.expiresAt<Date.now())fail(401,'session_expired','انتهت الجلسة أو تغيّرت صلاحياتها؛ أعد تسجيل الدخول.');
  if(!['admin','doctor','reception'].includes(current.role)||!await canAccessPatient(current,request.patientId,undefined,client,'nowait'))fail(403,'patient_access_denied','غير مصرّح لك بتعديل مرحلة هذه الحالة.');
  const {rows:[found]}=await client.query<{patient_id:number;status:string;phase:string}>('SELECT patient_id,status,phase FROM ortho_cases WHERE id=$1 FOR UPDATE',[id]);
  if(found&&found.patient_id!==request.patientId)fail(409,'case_scope_changed','تغيّرت هوية حالة التقويم؛ أعد تحميل الملف.');
  if(!found||!['active','retention'].includes(found.status)){await client.query('ROLLBACK');return false;}
  if(found.phase!==phase){
   await client.query('UPDATE ortho_cases SET phase=$2 WHERE id=$1',[id,phase]);
   await insertAuditRow(client,{action:'ortho.phase',entity:'ortho_cases',entityId:id,actor:current.username,actorRole:current.role,details:{patientId:found.patient_id,fromPhase:found.phase,toPhase:phase}});
  }
  // Locks preserve account/access witnesses; wall-clock expiry can still advance.
  if(current.expiresAt<Date.now())fail(401,'session_expired','انتهت الجلسة أثناء التعديل؛ أعد تسجيل الدخول.');
  await client.query('COMMIT');return true;
 }catch(error){
  await client.query('ROLLBACK').catch(()=>{});
  if((error as {code?:string}).code==='55P03')fail(409,'phase_authority_busy','تغيّر مرجع الصلاحية أثناء التعديل؛ أعد المحاولة بعد تحديث الملف.');
  throw error;
 }finally{client.release();}
}
