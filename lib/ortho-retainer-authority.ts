import type {SessionPayload} from './auth';
import {getPool,insertAuditRow} from './db';
import {canAccessPatient} from './patient-access';
import {revalidateSessionInTransaction} from './session';
import type {RetainerType} from './ortho';
export interface OrthoRetainerMetadata {id:number;retainer:RetainerType;deliveredOn:string|null;preserveExistingDeliveryDate?:boolean}
export interface OrthoRetainerRequest {patientId:number;session:SessionPayload}
export class OrthoRetainerAuthorityError extends Error {
 constructor(readonly status:400|401|403|409,readonly code:string,message:string){super(message);}
}
function fail(status:400|401|403|409,code:string,message:string):never{throw new OrthoRetainerAuthorityError(status,code,message);}
const positive=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0;
/** Authenticated retainer metadata only. Never infers delivery or changes lifecycle. */
export async function writeAuthorizedOrthoRetainer(input:OrthoRetainerMetadata,request:OrthoRetainerRequest):Promise<boolean>{
 const id=input.id;
 if(!positive(id)||!request||!positive(request.patientId)||!positive(request.session?.userId)||typeof request.session?.username!=='string')fail(400,'invalid_retainer_request','هوية طلب تغيير بيانات المثبّت غير صالحة.');
 const client=await getPool().connect();
 try{
  await client.query('BEGIN');
  // Match merge/sign-off order: patient, current account/access witnesses, case.
  await client.query('SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE',[request.patientId]);
  const current=await revalidateSessionInTransaction(request.session,client);
  if(!current||current.userId!==request.session.userId||current.username!==request.session.username||current.role!==request.session.role||current.expiresAt<Date.now())fail(401,'session_expired','انتهت الجلسة أو تغيّرت صلاحياتها؛ أعد تسجيل الدخول.');
  if(!['admin','doctor','reception'].includes(current.role)||!await canAccessPatient(current,request.patientId,undefined,client,'nowait'))fail(403,'patient_access_denied','غير مصرّح لك بتعديل بيانات مثبّت هذه الحالة.');
  const {rows:[found]}=await client.query<{patient_id:number;status:string;retainer:string|null;retainer_on:string|null}>("SELECT patient_id,status,retainer,retainer_on::text FROM ortho_cases WHERE id=$1 FOR UPDATE",[id]);
  if(found&&found.patient_id!==request.patientId)fail(409,'case_scope_changed','تغيّرت هوية حالة التقويم؛ أعد تحميل الملف.');
  if(!found||!['active','retention'].includes(found.status)){await client.query('ROLLBACK');return false;}
  // Preserve the existing atomic date-preservation CASE exactly. Only the
  // returned stored values, never inferred delivery evidence, enter the audit.
  const {rows:[saved]}=await client.query<{retainer:string|null;retainer_on:string|null}>(
    `UPDATE ortho_cases SET retainer = $2,
            retainer_on = CASE
              WHEN $2::text = 'none' THEN NULL
              WHEN $4::boolean AND $2::text <> 'none'
                AND retainer = $2::text AND retainer_on IS NOT NULL
              THEN retainer_on
              ELSE $3::date
            END
      WHERE id = $1 AND status IN ('active','retention')
      RETURNING retainer,retainer_on::text`,
    [input.id,input.retainer,input.deliveredOn,input.preserveExistingDeliveryDate===true]);
  if(!saved)throw Error('retainer_update_missing');
  if(found.retainer!==saved.retainer||found.retainer_on!==saved.retainer_on){
   await insertAuditRow(client,{action:'ortho.retainer_metadata',entity:'ortho_cases',entityId:id,actor:current.username,actorRole:current.role,details:{patientId:found.patient_id,fromRetainer:found.retainer,toRetainer:saved.retainer,fromDate:found.retainer_on,toDate:saved.retainer_on}});
  }
  // Locks preserve account/access witnesses; wall-clock expiry can still advance.
  if(current.expiresAt<Date.now())fail(401,'session_expired','انتهت الجلسة أثناء التعديل؛ أعد تسجيل الدخول.');
  await client.query('COMMIT');return true;
 }catch(error){
  await client.query('ROLLBACK').catch(()=>{});
  if((error as {code?:string}).code==='55P03')fail(409,'retainer_authority_busy','تغيّر مرجع الصلاحية أثناء التعديل؛ أعد المحاولة بعد تحديث الملف.');
  throw error;
 }finally{client.release();}
}
