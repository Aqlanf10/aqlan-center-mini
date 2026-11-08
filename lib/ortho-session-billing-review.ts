import type {SessionPayload} from './auth';
import {getPool} from './db';
import {revalidateSessionInTransaction} from './session';
import {canAccessPatient} from './patient-access';
import {financeAccessFor} from './finance-permissions';
import {canViewMoney} from './roles';
import {readSessionBillingReview,type SessionBillingReview} from './ortho-session-billing-review-contract';
export class SessionBillingReviewError extends Error {constructor(readonly status:400|401|403|404|409,readonly code:string){super(code);}}
function fail(status:400|401|403|404|409,code:string):never{throw new SessionBillingReviewError(status,code);}
export async function getSessionBillingReview(input:{session:SessionPayload;patientId:number;orthoCaseId:number}):Promise<SessionBillingReview>{
 if(![input.patientId,input.orthoCaseId,input.session?.userId].every(v=>Number.isSafeInteger(v)&&Number(v)>0))fail(400,'invalid_scope');
 const client=await getPool().connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const patient=(await client.query('SELECT id FROM patients WHERE id=$1 FOR SHARE',[input.patientId])).rows[0];
  const current=await revalidateSessionInTransaction(input.session,client);
  if(!current||current.userId!==input.session.userId||current.role!==input.session.role||current.username!==input.session.username||current.expiresAt<Date.now())fail(401,'session_expired');
  const financialOnly=current.role==='cashier'||current.role==='accountant';
  if(financialOnly){if(!financeAccessFor(current.role,current.financeAccess).viewPatientLedger)fail(403,'ledger_access_denied');}
  else if(!['admin','reception','doctor'].includes(current.role)||!await canAccessPatient(current,input.patientId,undefined,client,'nowait'))fail(403,'patient_access_denied');
  if(!patient)fail(404,'patient_not_found');
  const owner=(await client.query('SELECT patient_id FROM ortho_cases WHERE id=$1',[input.orthoCaseId])).rows[0];
  if(!owner||owner.patient_id!==input.patientId)fail(404,'case_not_found');
  const money=canViewMoney(current.role),access=financialOnly?'financial':money?'clinical_financial':'clinical';
  const size=(await client.query(`SELECT count(*)::text count,COALESCE(sum(octet_length(COALESCE(billing_decision_reason,''))+octet_length(COALESCE(billing_decided_by,''))),0)::text bytes FROM ortho_adjustments WHERE case_id=$1`,[input.orthoCaseId])).rows[0];
  if(!size||BigInt(size.count)>1000n||BigInt(size.bytes)>2097152n)fail(409,'review_limit');
  const rows=(await client.query(`SELECT a.id,a.done_on::text done_on,a.billing_class,a.billing_decision,
   ${financialOnly?'NULL::text':'a.billing_decision_reason'} reason,a.billing_decided_by,a.billing_decided_at,
   a.billing_invoice_id IS NOT NULL has_invoice,
   ${money?'i.id invoice_id,i.invoice_number,i.status invoice_status':'NULL::int invoice_id,NULL::text invoice_number,NULL::text invoice_status'}
   FROM ortho_adjustments a ${money?'LEFT JOIN invoices i ON i.id=a.billing_invoice_id AND i.patient_id=$2':''}
   WHERE a.case_id=$1 ORDER BY a.done_on,a.id LIMIT 1001`,money?[input.orthoCaseId,input.patientId]:[input.orthoCaseId])).rows;
  if(rows.some(r=>r.invoice_id!==null&&!['open','paid','cancelled'].includes(r.invoice_status)))fail(409,'invalid_invoice_status');
  const generatedAt=(await client.query('SELECT transaction_timestamp() at')).rows[0].at.toISOString();
  let result:SessionBillingReview;
  try{result=readSessionBillingReview({patientId:input.patientId,orthoCaseId:input.orthoCaseId,actorId:current.userId,generatedAt,access,entries:rows.map(r=>({id:r.id,doneOn:r.done_on,recordedClass:r.billing_class,decision:r.billing_decision,reason:r.reason,reasonRestricted:financialOnly,decidedBy:r.billing_decided_by,decidedAt:r.billing_decided_at?.toISOString()??null,invoice:!money?{state:'restricted'}:!r.has_invoice?{state:'none'}:!r.invoice_id?{state:'missing'}:{state:r.invoice_status==='cancelled'?'cancelled':'current',id:r.invoice_id,number:r.invoice_number}}))},{...input,actorId:current.userId,access});}catch{fail(409,'invalid_billing_record');}
  if(current.expiresAt<Date.now())fail(401,'session_expired');
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});if(['40001','55P03'].includes((error as {code?:string}).code??''))fail(409,'review_changed');throw error;}finally{client.release();}
}
