/** Atomic same-currency positive amendment of one explicitly approved, single-item plan.
 * Original clinical/financial identities are never updated. New debt is ONLY
 * the price difference, documented as a dated invoice and immutable event.
 */
import type { SessionPayload } from "./auth";
import { ensureSchema, getPool, insertAuditRow, type DbClient } from "./db";
import { readApprovedAgreement } from "./approved-agreements";
import { debtRequestHash, DebtRepaymentError } from "./debt-installments-db";
import { readInvoiceSettlementPosition } from "./invoice-settlement-position";
import { lockDebtAccountForSchedule } from "./debt-account-position";
import { documentNumberSql } from "./document-numbers";
import { revalidateSessionInTransaction } from "./session";
import { quoteAgreementAmendment } from "./agreement-amendment-quote";
import { requireCurrency, settlePaymentMinor, type Currency } from "./money";
import { clinicDateString } from "./schedule";
import { CLINIC_TIME_ZONE } from "./db";
import { getSettingsInTransaction } from "./db";

type EventRow = {id:string;plan_id:number;plan_item_id:number;patient_id:number;
  delta_invoice_id:number;new_service_id:number;new_unit_minor:string;delta_minor:string;
  receipt:Record<string,unknown>;};
type PlanRow={id:number;patient_id:number;base_currency:string;status:string;consent_at:Date|null};
type ItemRow={id:number;plan_id:number;service_id:number|null;service_name:string;unit_price_minor:string;
  quantity:number;case_id:number|null;doctor_id:number|null;status:string;};
type ServiceRow={id:number;name:string;category:string|null;is_active:boolean};
const safe=(n:string|number)=>{const v=Number(n);if(!Number.isSafeInteger(v))fail("قيمة مالية خارج النطاق الآمن.");return v;};
const positive=(n:unknown):n is number=>typeof n==="number"&&Number.isSafeInteger(n)&&n>0;
const fail=(message:string,code:DebtRepaymentError["code"]="conflict"):never=>{throw new DebtRepaymentError(code,message);};
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const amount=(n:number)=>Number.isSafeInteger(n)&&n>=0;
const sameCurrency=(currency:string):Currency=>requireCurrency(currency,"اتفاق العلاج",0);
async function authorize(client:DbClient,session:SessionPayload){
 const active=await revalidateSessionInTransaction(session,client);
 if(!active||active.role!=="admin")fail("يتطلب تعديل اتفاق العلاج جلسة مدير سارية.","unauthorized");
}
function paymentGross(source:Record<string,unknown>,currency:Currency){
 if(!Array.isArray(source.payments))fail("مصدر التسويات غير مكتمل؛ يلزم مراجعة مالية.");
 let payments=0,refunds=0;
 for(const data of source.payments){
  if(!record(data)||!positive(data.id)||!(data.kind==="payment"||data.kind==="refund"))fail("سند غير مثبت.");
  const money=settlePaymentMinor({id:data.id,currency:sameCurrency(String(data.currency)),
   amountMinor:safe(data.amount_minor as number),baseAmountMinor:safe(data.base_amount_minor as number)},currency);
  if(data.kind==="payment")payments+=money;else refunds+=money;
  if(!amount(payments)||!amount(refunds))fail("تسوية خارج النطاق الآمن.");
 }
 return {payments,refunds};
}
async function snapshot(client:DbClient,planId:number){
 const plan=(await client.query<PlanRow>("SELECT id,patient_id,base_currency,status,consent_at FROM treatment_plans WHERE id=$1",[planId])).rows[0];
 if(!plan)fail("الخطة غير موجودة.","missing");
 const approval=await readApprovedAgreement(client,planId);
 if(!approval||approval.patient_id!==plan.patient_id||approval.currency!==plan.base_currency
    ||!approval.invoice_id||approval.source_kind==="opening"||plan.status!=="active"||!plan.consent_at)
  fail("مطلوب اتفاق فعال معتمد ومغطى بفاتورة واحدة مثبتة؛ لم يُنشأ تعديل.");
 const currency=sameCurrency(plan.base_currency);
 const items=(await client.query<ItemRow>("SELECT id,plan_id,service_id,service_name,unit_price_minor::text,quantity,case_id,doctor_id,status FROM plan_items WHERE plan_id=$1 AND status<>'cancelled' ORDER BY id",[planId])).rows;
 if(items.length!==1||!items[0].service_id||!positive(items[0].quantity))fail("تعدد بنود العلاج يحتاج تخصيصًا ماليًا مستقلًا؛ لا يُخمّن فرق السعر.");
 const item=items[0];
 const sourceInvoice=(await client.query<{patient_id:number;base_currency:string;total_minor:string;discount_minor:string;status:string}>(
   "SELECT patient_id,base_currency,total_minor::text,discount_minor::text,status FROM invoices WHERE id=$1",[approval.invoice_id])).rows[0];
 if(!sourceInvoice||sourceInvoice.patient_id!==plan.patient_id||sourceInvoice.base_currency!==currency||
    sourceInvoice.status==="cancelled"||safe(sourceInvoice.total_minor)-safe(sourceInvoice.discount_minor)!==safe(approval.total_minor))
   fail("أصل الفاتورة لم يعد مطابقًا للاتفاق المعتمد.");
 const unrelated=(await client.query(`SELECT 1 FROM invoices i
   WHERE i.plan_id=$1 AND i.id<>$2 AND NOT EXISTS
   (SELECT 1 FROM agreement_delta_amendments e WHERE e.delta_invoice_id=i.id)
   UNION ALL SELECT 1 FROM payments p WHERE p.plan_id=$1
   AND (p.invoice_id IS NULL OR p.invoice_id<>$2) LIMIT 1`,[planId,approval.invoice_id])).rows;
 if(unrelated.length)fail("يوجد مصدر مالي آخر غير منسوب؛ يلزم إثبات التغطية.");
 const duplicateWork=(await client.query(`SELECT 1 FROM invoice_items ii
   WHERE ii.invoice_id<>$2 AND
     (ii.plan_item_id=$1 OR (ii.source_type='plan_item' AND ii.source_id=$1))
     AND NOT EXISTS(SELECT 1 FROM agreement_delta_amendments e WHERE e.delta_invoice_id=ii.invoice_id)
   LIMIT 1`,[item.id,approval.invoice_id])).rows;
 if(duplicateWork.length)fail("توجد فوترة أخرى للعمل؛ لا تُضاعف أصل العلاج.");
 const events=(await client.query<EventRow>("SELECT id,plan_id,plan_item_id,patient_id,delta_invoice_id,new_service_id,new_unit_minor::text,delta_minor::text,receipt FROM agreement_delta_amendments WHERE plan_id=$1 ORDER BY id",[planId])).rows;
 let total=safe(approval.total_minor),payments=0,refunds=0;
 const root=await readInvoiceSettlementPosition(client,{patientId:plan.patient_id,invoiceId:approval.invoice_id,currency});
 if(!root.available||root.principalMinor!==safe(approval.total_minor))fail("تغطية الفاتورة الأصلية غير مثبتة.");
 const rootGross=paymentGross(root.sourceSnapshot,currency);
 payments+=rootGross.payments;refunds+=rootGross.refunds;
 for(const event of events){
   if(event.plan_item_id!==item.id||event.patient_id!==plan.patient_id||event.plan_id!==planId)
      fail("سلسلة تعديلات الاتفاق غير متطابقة.");
   const doc=await readInvoiceSettlementPosition(client,{patientId:plan.patient_id,invoiceId:event.delta_invoice_id,currency});
   if(!doc.available||doc.principalMinor!==safe(event.delta_minor))
      fail("فرق الاتفاق السابق لا يطابق مستند مديونيته.");
   const gross=paymentGross(doc.sourceSnapshot,currency);
   payments+=gross.payments;refunds+=gross.refunds;total+=safe(event.delta_minor);
   if(!amount(total)||!amount(payments)||!amount(refunds))fail("تجميع المبالغ خارج النطاق.");
 }
 if(refunds>payments)fail("الاستردادات تتجاوز سندات المصدر؛ يلزم مراجعة مالية.");
 const oldServiceId=events.length?events[events.length-1].new_service_id:item.service_id!;
 const oldUnitMinor=events.length?safe(events[events.length-1].new_unit_minor):safe(item.unit_price_minor);
 const result={planId,patientId:plan.patient_id,itemId:item.id,caseId:item.case_id,doctorId:item.doctor_id,
  currency,approvalInvoiceId:approval.invoice_id,quantity:item.quantity,oldServiceId,oldUnitMinor,
  previousAgreementMinor:total,recordedPaymentsMinor:payments,recordedRefundsMinor:refunds,
  previousAmendmentId:events.length?safe(events[events.length-1].id):null,
  sourceProof:root.proofHash,documentProofs:events.map(e=>({id:e.id,invoiceId:e.delta_invoice_id,deltaMinor:e.delta_minor})),
 };
 return {...result,sourceHash:debtRequestHash(result)};
}
export async function readAgreementAmendment(planId:number,session:SessionPayload){
 if(!positive(planId))fail("معرف الخطة غير صالح.","invalid");
 await ensureSchema();const client=await getPool().connect();let destroy=false;
 try{await authorize(client,session);await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const result=await snapshot(client,planId);
  const services=(await client.query<ServiceRow>("SELECT id,name,category,is_active FROM services WHERE is_active=TRUE ORDER BY name,id")).rows;
  await client.query("COMMIT");
  return {...result,services};
 }catch(e){try{await client.query("ROLLBACK");}catch{destroy=true;}throw e;}finally{client.release(destroy);}
}
export type AmendmentWrite={idempotencyKey:string;expectedSourceHash:string;newServiceId:number;newUnitMinor:number;reason:string;};
export async function saveAgreementAmendment(planId:number,input:AmendmentWrite,session:SessionPayload){
 if(!positive(planId)||!record(input)||Object.keys(input).some(k=>!["idempotencyKey","expectedSourceHash","newServiceId","newUnitMinor","reason"].includes(k))
  ||typeof input.idempotencyKey!=="string"||!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)
  ||typeof input.expectedSourceHash!=="string"||!/^[a-f0-9]{64}$/.test(input.expectedSourceHash)
  ||!positive(input.newServiceId)||!amount(input.newUnitMinor)||typeof input.reason!=="string"
  ||input.reason.trim().length<3||input.reason.trim().length>300)
   fail("يرجى مراجعة الخدمة المحددة والسعر ومفتاح الطلب والسبب.","invalid");
 const hash=debtRequestHash({purpose:"agreement-delta-v1",planId,input,actor:session.userId});
 await ensureSchema();const client=await getPool().connect();let destroy=false;
 try{
  await client.query("BEGIN");await authorize(client,session);
  const replay=async()=>{
   const row=(await client.query<{request_hash:string;actor_id:number;plan_id:number;receipt:Record<string,unknown>;id:string}>(
    "SELECT request_hash,actor_id,plan_id,receipt,id FROM agreement_delta_amendments WHERE idempotency_key=$1",[input.idempotencyKey])).rows[0];
   if(!row)return null;
   if(row.request_hash!==hash||row.actor_id!==session.userId||row.plan_id!==planId)fail("مفتاح إعادة المحاولة مستعمل لطلب آخر.");
   return {...row.receipt,eventId:safe(row.id),replayed:true};
  };
  const earlier=await replay();if(earlier){await client.query("COMMIT");return earlier;}
  const owner=(await client.query<{patient_id:number}>("SELECT patient_id FROM treatment_plans WHERE id=$1",[planId])).rows[0];
  if(!owner)fail("الخطة غير موجودة.","missing");
  // Single patient lock serializes repeated and competing source/settlement writers.
  await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE",[owner.patient_id]);
  await lockDebtAccountForSchedule(client,owner.patient_id,true);
  await client.query("SELECT id FROM plan_items WHERE plan_id=$1 ORDER BY id FOR UPDATE",[planId]);
  const repeated=await replay();if(repeated){await authorize(client,session);await client.query("COMMIT");return repeated;}
  const before=await snapshot(client,planId);
  if(before.sourceHash!==input.expectedSourceHash)fail("تغيرت مصادر الاتفاق أو التسويات؛ حدّث المعاينة.","stale");
  if(before.patientId!==owner.patient_id)fail("تغير مالك المصدر؛ أوقف التعديل.");
  const service=(await client.query<ServiceRow>("SELECT id,name,category,is_active FROM services WHERE id=$1",[input.newServiceId])).rows[0];
  if(!service?.is_active)fail("يجب اختيار خدمة فعالة صراحة، ولا تكفي كتابة اسمها في السبب.","invalid");
  // This first writer authorizes positive price deltas in the same original currency.
  const quote=quoteAgreementAmendment({...before,previousServiceId:before.oldServiceId,
    selectedServiceId:input.newServiceId,previousUnitPriceMinor:before.oldUnitMinor,
    selectedUnitPriceMinor:input.newUnitMinor,reason:input.reason});
  if(quote.deltaMinor<=0)fail("هذا المسار للترقية الموجبة فقط؛ لا يُسجل رصيدًا سالبًا.","invalid");
  const settings=await getSettingsInTransaction(client);
  const nowDate=clinicDateString(new Date(),CLINIC_TIME_ZONE);
  if(settings["finance.locked_before"]?.trim()&&nowDate<settings["finance.locked_before"].trim())
    fail("الفترة المالية الحالية مقفلة.");
  const {rows:[deltaInvoice]}=await client.query<{id:number}>(`INSERT INTO invoices
    (invoice_number,patient_id,base_currency,total_minor,discount_minor,status,plan_id,note,created_by)
    VALUES(${documentNumberSql("invoice")},$1,$2,$3,0,'open',NULL,$4,$5) RETURNING id`,
    [before.patientId,before.currency,quote.deltaMinor,`فرق اتفاق الخطة #${planId} — ${input.reason.trim()}`,session.username]);
  await client.query(`INSERT INTO invoice_items
    (invoice_id,service_id,doctor_id,description,quantity,unit_price_minor,total_minor)
    VALUES($1,$2,NULL,$3,1,$4,$4)`,
    [deltaInvoice.id,input.newServiceId,`فرق ترقية العلاج — ${service.name}`,quote.deltaMinor]);
  // Doctor_id intentionally null: no automatic accrued/earned commission
  // before the canonical policy and incremental cost attribution are verified.
  const receipt={planId,patientId:before.patientId,planItemId:before.itemId,caseId:before.caseId,
    originalInvoiceId:before.approvalInvoiceId,deltaInvoiceId:deltaInvoice.id,
    previousServiceId:before.oldServiceId,newServiceId:input.newServiceId,
    currency:before.currency,previousAgreementMinor:quote.previousAgreementMinor,
    deltaMinor:quote.deltaMinor,revisedAgreementMinor:quote.revisedAgreementMinor,
    settledMinor:quote.settledMinor,remainingMinor:quote.remainingMinor,
    idempotencyKey:input.idempotencyKey,commissionDecision:"requires_policy_evaluation",cashMovementMinor:0};
  const row=(await client.query<{id:string}>(`INSERT INTO agreement_delta_amendments
   (plan_id,plan_item_id,patient_id,case_id,original_invoice_id,delta_invoice_id,previous_amendment_id,
    old_service_id,new_service_id,doctor_id,quantity,old_unit_minor,new_unit_minor,
    previous_agreement_minor,delta_minor,revised_agreement_minor,settled_snapshot_minor,source_hash,
    idempotency_key,request_hash,actor_id,actor_username,reason,receipt)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb) RETURNING id`,
   [planId,before.itemId,before.patientId,before.caseId,before.approvalInvoiceId,deltaInvoice.id,
    before.previousAmendmentId,before.oldServiceId,input.newServiceId,before.doctorId,
    before.quantity,before.oldUnitMinor,input.newUnitMinor,quote.previousAgreementMinor,
    quote.deltaMinor,quote.revisedAgreementMinor,quote.settledMinor,before.sourceHash,
    input.idempotencyKey,hash,session.userId,session.username,input.reason.trim(),JSON.stringify(receipt)])).rows[0];
  await insertAuditRow(client,{action:"plan.agreement_delta_amendment",entity:"treatment_plans",entityId:planId,
   actor:session.username,actorRole:session.role,
   details:{eventId:safe(row.id),sourceInvoiceId:before.approvalInvoiceId,deltaInvoiceId:deltaInvoice.id,
    beforeMinor:quote.previousAgreementMinor,afterMinor:quote.revisedAgreementMinor,
    deltaMinor:quote.deltaMinor,sourceProofHash:before.sourceHash,reason:input.reason.trim(),
    fromServiceId:before.oldServiceId,toServiceId:input.newServiceId,refundsPreserved:true,
    originalInvoicesPreserved:true,cashMovementMinor:0}});
  await authorize(client,session);await client.query("COMMIT");
  return {...receipt,eventId:safe(row.id),replayed:false};
 }catch(e){try{await client.query("ROLLBACK");}catch{destroy=true;}throw e;}finally{client.release(destroy);}
}
