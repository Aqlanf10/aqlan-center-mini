import type {SessionPayload} from './auth';
import {getPool,findUserByUsername,doctorOwnedPatientIds,orthoFollowupBoard,insertAuditRow,CLINIC_TIME_ZONE} from './db';
import {revalidateSessionInTransaction} from './session';
import {projectOrthoFollowupWorklist} from './ortho-followup-worklist-contract';
import type {FollowupBucket} from './ortho-followup';
export class OrthoFollowupAuthorityError extends Error {
 constructor(readonly status:401|403|409,message:string){super(message);}
}
/** A read is authorized at its first account snapshot, not retroactively after
 * every later ownership change. The held account SHARE lock and one repeatable
 * snapshot keep account, ownership, and clinical projection coherent. No schema
 * bootstrap or clinic-wide patient locks are performed on this read path. */
export async function readAuthorizedOrthoFollowupBoard(session:SessionPayload,today:string,asOf:Date,preparation?:{worklistBucket:FollowupBucket}){
 const client=await getPool().connect();
 try{
  // Not READ ONLY: PostgreSQL forbids the account's SELECT FOR SHARE in that mode.
  // Default board reads issue no data writes or DDL. Optional worklist
  // preparation writes only its audit within this transaction.
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const current=await revalidateSessionInTransaction(session,client).catch(error=>{if((error as {code?:string}).code==='40001')throw error;return null;});
  if(!current||current.userId!==session.userId||current.role!==session.role||current.expiresAt<Date.now())throw new OrthoFollowupAuthorityError(401,'انتهت الجلسة أو تغيّرت صلاحياتها. سجّل الدخول من جديد.');
  if(!['admin','reception','doctor'].includes(current.role))throw new OrthoFollowupAuthorityError(403,'غير مصرّح لك بالاطلاع على لوحة متابعة التقويم.');
  let partyId:number|null=null;
  if(current.role==='doctor'){
   const user=await findUserByUsername(current.username,client).catch(()=>null);
   if(!user||!user.isActive||user.id!==current.userId||user.role!=='doctor'||user.username.toLowerCase()!==current.username.toLowerCase())throw new OrthoFollowupAuthorityError(401,'انتهت الجلسة.');
   if(user.permissions?.canViewAllPatients!==true){
    if(typeof current.partyId!=='number'||!Number.isSafeInteger(current.partyId)||current.partyId<=0)throw new OrthoFollowupAuthorityError(403,'حساب الطبيب غير مرتبط بطبيب معالج؛ راجع صلاحيات الحساب.');
    partyId=current.partyId;
   }
  }
  let board=await orthoFollowupBoard(today,asOf,client);
  if(partyId!==null){const owned=await doctorOwnedPatientIds(partyId,[...new Set(board.map(row=>row.patientId))],client);board=board.filter(row=>owned.has(row.patientId));}
  if(preparation){
   const worklist=projectOrthoFollowupWorklist(board,{bucket:preparation.worklistBucket,today,asOf,timeZone:CLINIC_TIME_ZONE,actorId:current.userId});
   await insertAuditRow(client,{action:'ortho.followup_worklist',entity:'ortho_cases',actor:current.username,actorRole:current.role,details:{event:'prepared_followup_worklist',bucket:worklist.bucket,caseCount:worklist.rows.length,today,asOf:worklist.asOf,timeZone:worklist.timeZone}});
  }
  if(current.expiresAt<Date.now())throw new OrthoFollowupAuthorityError(401,'انتهت الجلسة أثناء تحميل اللوحة.');
  await client.query('COMMIT');return board;
 }catch(error){
  await client.query('ROLLBACK').catch(()=>{});
  if((error as {code?:string}).code==='40001')throw new OrthoFollowupAuthorityError(409,'تغيّرت صلاحيات الحساب أثناء تحميل اللوحة. أعد المحاولة.');
  throw error;
 }finally{client.release();}
}
