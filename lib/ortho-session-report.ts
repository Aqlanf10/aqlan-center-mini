/** Fresh text-only chronology; not an immutable historical capture or care attestation. */
import type {SessionPayload} from './auth';
import {getPool,insertAuditRow} from './db';
import {revalidateSessionInTransaction} from './session';
import {canAccessPatient} from './patient-access';
import {PHASE_LABEL,isElasticClass,type OrthoPhase,type ElasticClass} from './ortho';
export interface OrthoSessionReportEntry {id:number;doneOn:string;phase:OrthoPhase|null;upperWire:string|null;lowerWire:string|null;elastics:ElasticClass;elasticNote:string|null;done:string|null;nextWeeks:number;note:string|null;recordedBy:string;visitId:number|null;visitSigned:boolean|null}
export interface OrthoSessionReport {patientId:number;orthoCaseId:number;clinicalCaseId:number;patientName:string;generatedAt:string;actorId:number;entries:OrthoSessionReportEntry[]}
export class OrthoSessionReportError extends Error {constructor(readonly status:400|401|403|404|409,readonly code:string){super(code);}}
function fail(status:400|401|403|404|409,code:string):never{throw new OrthoSessionReportError(status,code);}
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const nullableText=(v:unknown,max:number):v is string|null=>v===null||typeof v==='string'&&v.length<=max;
const day=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
/** Patient -> live account/access. One repeatable snapshot binds case, unique
 * bridge and session/visit facts; final expiry follows preparation audit. */
export async function prepareOrthoSessionReport(input:{session:SessionPayload;patientId:number;orthoCaseId:number}):Promise<OrthoSessionReport>{
 if(!positive(input.patientId)||!positive(input.orthoCaseId)||!positive(input.session?.userId))fail(400,'invalid_session_report_scope');
 const client=await getPool().connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const patient=(await client.query<{id:number;full_name:string}>('SELECT id,full_name FROM patients WHERE id=$1 FOR SHARE',[input.patientId])).rows[0];
  const current=await revalidateSessionInTransaction(input.session,client);
  if(!current||current.userId!==input.session.userId||current.username!==input.session.username||current.role!==input.session.role||current.expiresAt<Date.now())fail(401,'session_expired');
  if(!['admin','doctor','reception'].includes(current.role)||!await canAccessPatient(current,input.patientId,undefined,client,'nowait'))fail(403,'patient_access_denied');
  if(!patient)fail(404,'patient_not_found');
  const caseRow=(await client.query<{patient_id:number}>('SELECT patient_id FROM ortho_cases WHERE id=$1',[input.orthoCaseId])).rows[0];
  if(!caseRow||caseRow.patient_id!==input.patientId)fail(404,'ortho_case_not_found');
  const bridges=(await client.query<{id:number;patient_id:number;specialty:string}>('SELECT id,patient_id,specialty FROM clinical_cases WHERE ortho_case_id=$1 ORDER BY id LIMIT 2',[input.orthoCaseId])).rows;
  if(bridges.length!==1||bridges[0].patient_id!==input.patientId||bridges[0].specialty!=='orthodontics')fail(409,'session_report_bridge_unavailable');
  const clinicalCaseId=bridges[0].id;
  const size=(await client.query<{count:string;bytes:string}>(`SELECT count(*)::text count,COALESCE(SUM(octet_length(COALESCE(done,''))+octet_length(COALESCE(note,''))+octet_length(COALESCE(elastic_note,''))+octet_length(COALESCE(upper_wire,''))+octet_length(COALESCE(lower_wire,''))+octet_length(recorded_by)),0)::text bytes FROM ortho_adjustments WHERE case_id=$1`,[input.orthoCaseId])).rows[0];
  if(!size||!/^\d+$/.test(size.count)||!/^\d+$/.test(size.bytes)||BigInt(size.count)>1000n||BigInt(size.bytes)>2097152n)fail(409,'session_report_limit');
  const rows=(await client.query<Record<string,unknown>>(`SELECT a.id,a.done_on::text done_on,a.phase,a.upper_wire,a.lower_wire,a.elastics,a.elastic_note,a.done,a.next_weeks,a.note,a.recorded_by,a.visit_id,v.id linked_visit_id,v.signed_at
    FROM ortho_adjustments a LEFT JOIN visits v ON v.id=a.visit_id AND v.patient_id=$2 AND (v.case_id IS NULL OR v.case_id=$3)
    WHERE a.case_id=$1 ORDER BY a.done_on ASC,a.id ASC LIMIT 1001`,[input.orthoCaseId,input.patientId,clinicalCaseId])).rows;
  if(rows.length>1000||rows.length!==Number(size.count))fail(409,'session_report_limit');
  const entries=rows.map(r=>{
   if(!positive(r.id)||!day(r.done_on)||r.phase!==null&&(typeof r.phase!=='string'||!Object.hasOwn(PHASE_LABEL,r.phase))||!isElasticClass(r.elastics)||!positive(r.next_weeks)||r.next_weeks>52||!nullableText(r.upper_wire,4000)||!nullableText(r.lower_wire,4000)||!nullableText(r.elastic_note,4000)||!nullableText(r.done,4000)||!nullableText(r.note,4000)||typeof r.recorded_by!=='string'||!r.recorded_by.trim()||r.recorded_by.length>200)fail(409,'invalid_session_report_row');
   if(r.visit_id!==null&&(!positive(r.visit_id)||r.linked_visit_id!==r.visit_id))fail(409,'session_report_visit_scope');
   if(r.signed_at!==null&&(!(r.signed_at instanceof Date)||!Number.isFinite(r.signed_at.getTime())))fail(409,'invalid_session_report_signature');
   return {id:r.id,doneOn:r.done_on,phase:r.phase as OrthoPhase|null,upperWire:r.upper_wire,lowerWire:r.lower_wire,elastics:r.elastics,elasticNote:r.elastic_note,done:r.done,nextWeeks:r.next_weeks,note:r.note,recordedBy:r.recorded_by,visitId:r.visit_id as number|null,visitSigned:r.visit_id===null?null:r.signed_at!==null};
  });
  if(typeof patient.full_name!=='string'||!patient.full_name.trim()||patient.full_name.length>1000)fail(409,'invalid_session_report_patient');
  const generatedAt=(await client.query<{at:Date}>('SELECT transaction_timestamp() at')).rows[0]?.at;
  if(!(generatedAt instanceof Date)||!Number.isFinite(generatedAt.getTime()))fail(409,'invalid_session_report_clock');
  await insertAuditRow(client,{action:'ortho.sessions_print',entity:'ortho_cases',entityId:input.orthoCaseId,actor:current.username,actorRole:current.role,details:{event:'prepared_session_chronology',patientId:input.patientId,clinicalCaseId,sessionCount:entries.length,generatedAt:generatedAt.toISOString()}});
  if(current.expiresAt<Date.now())fail(401,'session_expired');
  await client.query('COMMIT');
  return {patientId:input.patientId,orthoCaseId:input.orthoCaseId,clinicalCaseId,patientName:patient.full_name,generatedAt:generatedAt.toISOString(),actorId:current.userId,entries};
 }catch(error){await client.query('ROLLBACK').catch(()=>{});if(['40001','55P03'].includes((error as {code?:string}).code??''))fail(409,'session_report_changed');throw error;}finally{client.release();}
}
