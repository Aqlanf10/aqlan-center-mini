import { createHash } from "node:crypto";
import type { SessionPayload } from "./auth";
import { ensureSchema, getPool, insertAuditRow, PLAN_ITEM_FINANCIAL_LINEAGE_SQL, CLINIC_TIME_ZONE, type DbClient } from "./db";
import { revalidateSessionInTransaction } from "./session";
import { readInvoiceSettlementPosition } from "./invoice-settlement-position";
import { lockDebtAccountForSchedule } from "./debt-account-position";
import { PURCHASE_RESET_FENCE } from "./clinic-reset";
import { documentNumberSql } from "./document-numbers";
import { requireCurrency } from "./money";
import { clinicDateString } from "./schedule";
import { parseDoctorCommissionConfig } from "./doctor-permissions";
import { resolvePolicyForShare } from "./commission";
import { agreementReconciliationIntentText, reconcileAgreementAmounts, type AgreementReconciliationCommand,
  type AgreementReconciliationView, type AgreementReconciliationReceipt, type AgreementReconciliationResult,
  type AgreementReconciliationAttemptStatus } from "./agreement-reconciliation";

export class AgreementReconciliationError extends Error {
 constructor(readonly code: string, message: string, readonly status = 409) { super(message); this.name = "AgreementReconciliationError"; }
}
function fail(code: string, message: string, status = 409): never { throw new AgreementReconciliationError(code,message,status); }
const safe = (value: string|number): number => { const n=Number(value); if(!Number.isSafeInteger(n))fail("agreement_review_required","القيمة المالية تحتاج مراجعة."); return n; };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const hash = (value: unknown) => digest(JSON.stringify(value));
function validate(planId: number, command: AgreementReconciliationCommand) {
 if(!Number.isSafeInteger(planId)||planId<=0||!command||Object.keys(command).some(key=>!["operationKey","expectedSourceHash","reason"].includes(key))
   ||typeof command.operationKey!=="string"||!/^[A-Za-z0-9._:-]{8,128}$/.test(command.operationKey)
   ||typeof command.expectedSourceHash!=="string"||!/^[a-f0-9]{64}$/.test(command.expectedSourceHash)
   ||typeof command.reason!=="string"||command.reason!==command.reason.trim()||command.reason.length<3||command.reason.length>300)
  fail("invalid","راجع بيانات تسوية الاتفاق.",400);
}
async function authorize(client: DbClient, session: SessionPayload) {
 const current=await revalidateSessionInTransaction(session,client);
 if(!current||current.role!=="admin")fail("unauthorized","تسوية الاتفاق تحتاج جلسة مدير سارية.",403);
}
async function transaction<T>(run: (client: DbClient)=>Promise<T>, readOnly=false): Promise<T> {
 await ensureSchema(); const client=await getPool().connect(); let destroy=false;
 try { await client.query(readOnly?"BEGIN ISOLATION LEVEL REPEATABLE READ":"BEGIN"); const value=await run(client); await client.query("COMMIT"); return value; }
 catch(error){try{await client.query("ROLLBACK");}catch{destroy=true;}throw error;}finally{client.release(destroy);}
}
async function installed(client: DbClient) {
 const {rows:[row]}=await client.query<{present:boolean}>("SELECT to_regclass('public.agreement_reconciliations') IS NOT NULL AS present");
 if(!row?.present)fail("agreement_reconciliation_unavailable","تسوية الاتفاق غير مفعّلة بعد؛ لم يتغير الحساب.",503);
}
type EventRow={id:string;plan_id:number;patient_id:number;actor_id:number;operation_key:string;request_hash:string;expected_source_hash:string;receipt:AgreementReconciliationReceipt;source_snapshot:Record<string,unknown>};
async function eventForPlan(client:DbClient,planId:number){return (await client.query<EventRow>("SELECT * FROM agreement_reconciliations WHERE plan_id=$1",[planId])).rows[0]??null;}
async function snapshot(client: DbClient, planId: number): Promise<{view:AgreementReconciliationView;proof:Record<string,unknown>}> {
 await installed(client);
 const plan=(await client.query<{id:number;patient_id:number;title:string;total_minor:string;base_currency:string;status:string;billing_mode:string;total_from_items:boolean;consent_at:Date|null;primary_doctor_id:number|null}>(
  "SELECT id,patient_id,title,total_minor::text,base_currency,status,billing_mode,total_from_items,consent_at,primary_doctor_id FROM treatment_plans WHERE id=$1",[planId])).rows[0];
 if(!plan)fail("missing","الخطة غير موجودة.",404);
 const currency=requireCurrency(plan.base_currency,"اتفاق",planId), agreedMinor=safe(plan.total_minor);
 const event=await eventForPlan(client,planId);
 const blockers:AgreementReconciliationView["blockers"]=[];
 const block=(code:string,message:string)=>blockers.push({code,message});
 if(!["active","completed"].includes(plan.status)||plan.total_from_items||!plan.consent_at)block("plan_requires_review","راجع حالة الخطة وموافقة المريض؛ الإكمال السريري لا يعني سداد الاتفاق.");
 if((await client.query("SELECT 1 FROM approved_agreement_principals WHERE plan_id=$1",[planId])).rows.length)block("already_approved","هذا الاتفاق له أصل معتمد؛ استخدم مصدره الحالي.");
 const mixedLineage=(await client.query(`SELECT i.id FROM plan_items i WHERE i.plan_id=$1 AND ${PLAN_ITEM_FINANCIAL_LINEAGE_SQL} ORDER BY i.id`,[planId])).rows;
 if(mixedLineage.length)block("mixed_financial_lineage","بنود الخطة مرتبطة بفواتير أو اتفاقات تاريخية أخرى؛ لا يُنشأ أصل إضافي قبل مطابقة جميع المصادر.");
 const schedules=(await client.query<{number:number;due_date:string;amount_minor:string}>("SELECT number,due_date::text,amount_minor::text FROM plan_installments WHERE plan_id=$1 ORDER BY number",[planId])).rows;
 const scheduleTotal=schedules.reduce((sum,row)=>safe(sum+safe(row.amount_minor)),0);
 if(!schedules.length||scheduleTotal!==agreedMinor)block("schedule_mismatch","جدول الاتفاق لا يطابق كامل قيمته.");
 const openings=(await client.query("SELECT currency,amount_minor::text FROM patient_opening_balances WHERE patient_id=$1 AND currency=$2 AND amount_minor<>0",[plan.patient_id,currency])).rows;
 if(openings.length)block("opening_overlap","يوجد رصيد افتتاحي بنفس العملة؛ يلزم إثبات عدم تداخل أصل الدين قبل التسوية.");
 const invoices=(await client.query<{id:number;patient_id:number;invoice_number:string;base_currency:string;status:string}>("SELECT id,patient_id,invoice_number,base_currency,status FROM invoices WHERE plan_id=$1 ORDER BY id",[planId])).rows;
 const sourceInvoices:AgreementReconciliationView["sourceInvoices"]=[], proofs:unknown[]=[];
 let billed=0,paid=0;
 for(const invoice of invoices){
  if(invoice.patient_id!==plan.patient_id||invoice.base_currency!==currency||invoice.status==="cancelled") {block("invoice_lineage_review","مصدر فاتورة الاتفاق ملغى أو غير مطابق؛ راجع السلسلة المالية.");continue;}
  const foreign=(await client.query("SELECT 1 FROM payments WHERE invoice_id=$1 AND (patient_id<>$2 OR currency<>$3 OR (plan_id IS NOT NULL AND plan_id<>$4)) LIMIT 1",[invoice.id,plan.patient_id,currency,planId])).rows;
  const corrections=(await client.query("SELECT 1 FROM invoice_corrections WHERE original_invoice_id=$1 OR corrected_invoice_id=$1 LIMIT 1",[invoice.id])).rows;
  const linked=(await client.query("SELECT 1 FROM invoice_items WHERE invoice_id=$1 AND (plan_item_id IS NOT NULL OR source_type IS NOT NULL) LIMIT 1",[invoice.id])).rows;
  if(foreign.length||corrections.length||linked.length){block("source_allocation_review","الفاتورة ليست قسطًا كلاسيكيًا بسيطًا مثبتًا بنفس العملة؛ راجع الربط والتحويلات أولًا.");continue;}
  const position=await readInvoiceSettlementPosition(client,{patientId:plan.patient_id,invoiceId:invoice.id,currency});
  if(!position.available||position.settledMinor<0||position.settledMinor>position.principalMinor){block("settlement_review","تسوية السندات تحتاج مراجعة؛ لم يُفترض تخصيص أو سعر صرف.");continue;}
  billed=safe(billed+position.principalMinor);paid=safe(paid+position.settledMinor);proofs.push(position.sourceSnapshot);
  sourceInvoices.push({invoiceId:invoice.id,invoiceNumber:invoice.invoice_number,principalMinor:position.principalMinor,settledMinor:position.settledMinor,remainingMinor:position.remainingMinor});
 }
 const loose=(await client.query("SELECT id,invoice_id,plan_id,currency,amount_minor::text,kind FROM payments WHERE patient_id=$1 AND (plan_id=$2 OR (invoice_id IS NULL AND opening_currency IS NULL)) AND (invoice_id IS NULL OR NOT(invoice_id=ANY($3::int[]))) ORDER BY id",[plan.patient_id,planId,invoices.map(i=>i.id)])).rows;
 if(loose.length)block("unallocated_receipt_review","يوجد سند غير منسوب صراحة لمصدر الاتفاق؛ لا تُحوّل الملاحظة إلى تخصيص مالي.");
 if(!event&&!invoices.length)block("not_classic_history","لا توجد فواتير أقساط مثبتة؛ استخدم اعتماد الاتفاق المعتاد بدل التسوية.");
 const today=clinicDateString(new Date(),CLINIC_TIME_ZONE);
 const lockedBefore=(await client.query<{value:string}>("SELECT value FROM settings WHERE key='finance.locked_before'")).rows[0]?.value?.trim()??"";
 if(!event&&lockedBefore&&today<lockedBefore)block("period_locked","تاريخ التسوية في فترة مقفلة؛ لا يُضاف أصل مستحق إلى فترة مقفلة.");
 let amounts:AgreementReconciliationView["amounts"]={agreedMinor,billedPrincipalMinor:null,unbilledPrincipalMinor:null,paidMinor:null,remainingMinor:null,dueNowMinor:null};
 try{amounts=reconcileAgreementAmounts({agreedMinor,billedPrincipalMinor:billed,paidMinor:paid,duePrincipalMinor:schedules.filter(r=>r.due_date<=today).reduce((sum,row)=>safe(sum+safe(row.amount_minor)),0)});}catch{block("principal_mismatch","الفواتير أو التسويات تتجاوز أصل الاتفاق؛ يلزم مراجعة مالية.");}
 let commission:AgreementReconciliationView["commission"]=null;
 const doctor=(await client.query<{id:number;name:string}>("SELECT id,name FROM parties WHERE id=$1 AND kind='doctor'",[plan.primary_doctor_id])).rows[0];
 const history=doctor?(await client.query<{id:number;percent:string;config:unknown;effective_from:Date}>("SELECT id,percent::text,config,effective_from FROM doctor_commission_history WHERE party_id=$1 AND effective_from<=CURRENT_TIMESTAMP ORDER BY effective_from DESC,id DESC LIMIT 1",[doctor.id])).rows[0]:null;
 const otherDoctors=(await client.query("SELECT doctor_id FROM invoice_items WHERE invoice_id=ANY($1::int[]) AND doctor_id IS DISTINCT FROM $2 UNION SELECT doctor_id FROM plan_items WHERE plan_id=$3 AND doctor_id IS NOT NULL AND doctor_id IS DISTINCT FROM $2",[invoices.map(i=>i.id),doctor?.id??null,planId])).rows;
 const overrides=doctor?(await client.query("SELECT id,percent,action,effective_from FROM commission_case_overrides WHERE doctor_id=$1 AND (plan_id=$2 OR case_id IN(SELECT case_id FROM plan_items WHERE plan_id=$2)) ORDER BY id",[doctor.id,planId])).rows:[];
 const lab=(await client.query("SELECT l.id,l.cost_minor::text,l.cost_currency FROM lab_orders l LEFT JOIN visits v ON v.id=l.visit_id WHERE l.patient_id=$1 AND l.status<>'cancelled' AND (v.invoice_id=ANY($2::int[]) OR v.invoice_id IS NULL) ORDER BY l.id",[plan.patient_id,invoices.map(i=>i.id)])).rows;
 if((amounts.unbilledPrincipalMinor??0)>0&&!event){
  if(!doctor||!history||otherDoctors.length||overrides.length)block("provider_commission_review","إسناد الطبيب أو سياسة العمولة غير موحدة ومثبتة؛ راجعها قبل إضافة أصل مستحق.");
  else {
   const percent=Number(history.percent);
   const config=history.config===null?null:parseDoctorCommissionConfig(history.config,percent);
   const policyAt=new Date().toISOString();
   const effective=config?.rateHistory.filter(row=>row.effectiveDate<=policyAt.slice(0,10)).sort((a,b)=>b.effectiveDate.localeCompare(a.effectiveDate))[0]??config;
   const generic=!effective||(effective.calculationMode==="percentage"&&!effective.customServiceRates?.length&&!Object.keys(effective.serviceRates??{}).length);
   const policy=resolvePolicyForShare({percent,config},policyAt,{});
   if(!generic)block("provider_commission_review","سياسة العمولة تعتمد على الخدمة أو مبلغ ثابت؛ لا تُطبّق النسبة الافتراضية على أصل اتفاق غير منسوب للخدمة.");
   else if(!Number.isFinite(percent)||percent<0||percent>100||policy.deductMaterials||(policy.deductLab&&lab.length))block("cost_commission_review","أثر تكاليف المختبر أو المواد على العمولة يحتاج مراجعة؛ لم تُقدّر التكلفة بصفر.");
   else commission={doctorId:doctor.id,doctorName:doctor.name,percent:policy.percent,incrementalAccruedMinor:safe(Math.round(amounts.unbilledPrincipalMinor!*policy.percent/100))};
  }
 }
 const proof={plan,mixedLineage,schedules,openings,invoices,proofs,loose,doctor,history,otherDoctors,overrides,lab,today,lockedBefore};
 if(blockers.length)amounts={agreedMinor,billedPrincipalMinor:null,unbilledPrincipalMinor:null,paidMinor:null,remainingMinor:null,dueNowMinor:null};
 const view:AgreementReconciliationView={status:event?"reconciled":blockers.length?"review_required":"preview",planId,patientId:plan.patient_id,currency,sourceHash:hash(proof),amounts,sourceInvoices,blockers,reconciliation:event?.receipt??null,commission,canConfirm:!event&&!blockers.length};
 return {view,proof};
}
export async function readAgreementReconciliation(planId:number,session:SessionPayload) {
 return transaction(async client=>{await authorize(client,session);const {view}=await snapshot(client,planId);return view;},true);
}

async function lockAttempt(client:DbClient,session:SessionPayload,command:AgreementReconciliationCommand) {
 await client.query("SELECT pg_advisory_xact_lock(hashtextextended('aqlan:agreement-reconcile:'||$1::text||':'||$2::text,0))",[session.userId,command.operationKey]);
}
async function attempt(client:DbClient,planId:number,command:AgreementReconciliationCommand,session:SessionPayload):Promise<AgreementReconciliationAttemptStatus> {
 const requestHash=digest(agreementReconciliationIntentText(planId,command));
 const saved=(await client.query<EventRow>("SELECT * FROM agreement_reconciliations WHERE actor_id=$1 AND operation_key=$2",[session.userId,command.operationKey])).rows[0];
 if(saved){
  if(saved.plan_id!==planId||saved.request_hash!==requestHash||saved.expected_source_hash!==command.expectedSourceHash)fail("operation_key_conflict","مفتاح الطلب محفوظ لمحاولة مختلفة.");
  if(saved.receipt.planId!==planId||saved.receipt.patientId!==saved.patient_id||saved.receipt.operationKey!==command.operationKey||saved.receipt.expectedSourceHash!==command.expectedSourceHash)fail("agreement_review_required","إقرار التسوية المحفوظ يحتاج مراجعة.");
  return {state:"committed",receipt:saved.receipt};
 }
 const rejected=(await client.query<{plan_id:number;patient_id:number;request_hash:string;expected_source_hash:string;observed_source_hash:string;rejected_at:Date}>("SELECT * FROM agreement_reconciliation_rejections WHERE actor_id=$1 AND operation_key=$2",[session.userId,command.operationKey])).rows[0];
 if(rejected){
  if(rejected.plan_id!==planId||rejected.request_hash!==requestHash||rejected.expected_source_hash!==command.expectedSourceHash)fail("operation_key_conflict","مفتاح الرفض المحفوظ يخص محاولة مختلفة.");
  return {state:"rejected",planId,patientId:rejected.patient_id,operationKey:command.operationKey,expectedSourceHash:command.expectedSourceHash,requestHash,observedSourceHash:rejected.observed_source_hash,rejectedAt:rejected.rejected_at.toISOString(),code:"agreement_source_changed"};
 }
 return {state:"unresolved"};
}
export async function readAgreementReconciliationAttemptStatus(planId:number,command:AgreementReconciliationCommand,session:SessionPayload):Promise<AgreementReconciliationAttemptStatus> {
 validate(planId,command);
 return transaction(async client=>{await authorize(client,session);await installed(client);await lockAttempt(client,session,command);const result=await attempt(client,planId,command,session);await authorize(client,session);return result;});
}
export async function saveAgreementReconciliation(planId:number,command:AgreementReconciliationCommand,session:SessionPayload):Promise<AgreementReconciliationResult> {
 validate(planId,command);
 const result=await transaction(async client=>{
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",[PURCHASE_RESET_FENCE]);
  await authorize(client,session);await installed(client);await lockAttempt(client,session,command);
  const prior=await attempt(client,planId,command,session);
  if(prior.state==="committed")return {status:"reconciled" as const,replayed:true,reconciliation:prior.receipt,view:null};
  if(prior.state==="rejected")return null;
  const owner=(await client.query<{patient_id:number}>("SELECT patient_id FROM treatment_plans WHERE id=$1",[planId])).rows[0];
  if(!owner)fail("missing","الخطة غير موجودة.",404);
  await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE",[owner.patient_id]);
  await lockDebtAccountForSchedule(client,owner.patient_id,true);
  await client.query("SELECT id FROM treatment_plans WHERE id=$1 FOR UPDATE",[planId]);
  await client.query("SELECT id FROM parties WHERE id=(SELECT primary_doctor_id FROM treatment_plans WHERE id=$1) FOR SHARE",[planId]);
  await client.query("LOCK TABLE doctor_commission_history, commission_case_overrides, settings IN SHARE MODE");
  const before=await snapshot(client,planId);
  // A competing key may win while this command waits. The losing exact command
  // gets immutable no-save proof, never a forever-unresolved generic conflict.
  if(before.view.sourceHash!==command.expectedSourceHash||before.view.reconciliation!==null||!before.view.canConfirm){
   await client.query(`INSERT INTO agreement_reconciliation_rejections(actor_id,operation_key,plan_id,patient_id,request_hash,expected_source_hash,observed_source_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[session.userId,command.operationKey,planId,owner.patient_id,digest(agreementReconciliationIntentText(planId,command)),command.expectedSourceHash,before.view.sourceHash]);
   await insertAuditRow(client,{action:"plan.agreement_reconciliation_refused",entity:"treatment_plans",entityId:planId,actor:session.username,actorRole:session.role,details:{operationKey:command.operationKey,expectedSourceHash:command.expectedSourceHash,observedSourceHash:before.view.sourceHash,reason:"source_changed_or_review_required",cashMovementMinor:0}});
   await authorize(client,session);return null;
  }
  const view=before.view,U=view.amounts.unbilledPrincipalMinor!;
  let deltaInvoiceId:number|null=null;
  if(U>0){
   if(!view.commission)fail("agreement_review_required","أثر العمولة غير مثبت.");
   const [created]=(await client.query<{id:number}>(`INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,plan_id,note,created_by)
    VALUES(${documentNumberSql("invoice")},$1,$2,0,$3,$4,$5,$6) RETURNING id`,[view.patientId,U,view.currency,planId,`تسوية الاتفاق — ${command.reason}`,session.username])).rows;
   deltaInvoiceId=created.id;
   await client.query("INSERT INTO invoice_items(invoice_id,doctor_id,description,quantity,unit_price_minor,total_minor) VALUES($1,$2,'أصل الاتفاق غير المفوتر — تسوية الاتفاق',1,$3,$3)",[deltaInvoiceId,view.commission.doctorId,U]);
  }
  const id=safe((await client.query<{id:string}>("SELECT nextval(pg_get_serial_sequence('agreement_reconciliations','id'))::text AS id")).rows[0].id);
  const receipt:AgreementReconciliationReceipt={id,planId,patientId:view.patientId,operationKey:command.operationKey,expectedSourceHash:command.expectedSourceHash,deltaInvoiceId,amounts:view.amounts,cashMovementMinor:0};
  await client.query(`INSERT INTO agreement_reconciliations(id,plan_id,patient_id,actor_id,operation_key,request_hash,expected_source_hash,currency,agreed_minor,billed_principal_minor,unbilled_principal_minor,delta_invoice_id,doctor_id,source_snapshot,receipt,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16)`,[id,planId,view.patientId,session.userId,command.operationKey,digest(agreementReconciliationIntentText(planId,command)),command.expectedSourceHash,view.currency,view.amounts.agreedMinor,view.amounts.billedPrincipalMinor,U,deltaInvoiceId,view.commission?.doctorId??null,JSON.stringify(before.proof),JSON.stringify(receipt),command.reason]);
  for(const source of view.sourceInvoices)await client.query("INSERT INTO agreement_reconciliation_sources(reconciliation_id,invoice_id,principal_minor) VALUES($1,$2,$3)",[id,source.invoiceId,source.principalMinor]);
  if(deltaInvoiceId!==null)await client.query("INSERT INTO agreement_reconciliation_sources(reconciliation_id,invoice_id,principal_minor) VALUES($1,$2,$3)",[id,deltaInvoiceId,U]);
  await insertAuditRow(client,{action:"plan.agreement_reconciliation",entity:"treatment_plans",entityId:planId,actor:session.username,actorRole:session.role,details:{...receipt,commission:view.commission,reason:command.reason,originalInvoicesPreserved:true,originalReceiptsPreserved:true}});
  await authorize(client,session);
  return {status:"reconciled" as const,replayed:false,reconciliation:receipt,view:null};
 });
 if(result===null)fail("agreement_source_changed","تغيّر المصدر أو يحتاج مراجعة؛ افحص حالة نفس المحاولة قبل تحديث المعاينة.");
 return result;
}

/** Explicit immutable membership projection; never reinterpret a delta as full principal. */
export async function readReconciledPlanPosition(client:DbClient,plan:{id:number;patientId:number;currency:import("./money").Currency},today:string):Promise<import("./plan-financial-position").PlanInvoiceFinancialPosition|null> {
 const present=(await client.query<{present:boolean}>("SELECT to_regclass('public.agreement_reconciliations') IS NOT NULL AS present")).rows[0]?.present;
 if(!present)return null;
 const event=await eventForPlan(client,plan.id);if(!event)return null;
 const header=(await client.query<{currency:string;agreed_minor:string;source_snapshot:{schedules:{number:number;due_date:string;amount_minor:string}[]}}>("SELECT currency,agreed_minor::text,source_snapshot FROM agreement_reconciliations WHERE id=$1",[event.id])).rows[0];
 if(event.patient_id!==plan.patientId||header.currency!==plan.currency)fail("agreement_review_required","هوية الاتفاق المسوّى غير مطابقة.");
 const members=(await client.query<{invoice_id:number;principal_minor:string}>("SELECT invoice_id,principal_minor::text FROM agreement_reconciliation_sources WHERE reconciliation_id=$1 ORDER BY invoice_id",[event.id])).rows;
 let principal=0,paid=0;
 for(const member of members){const position=await readInvoiceSettlementPosition(client,{patientId:plan.patientId,invoiceId:member.invoice_id,currency:plan.currency});
  if(!position.available||position.principalMinor!==safe(member.principal_minor)||position.settledMinor<0||position.creditMinor>0)fail("agreement_review_required","مصدر الاتفاق المسوّى يحتاج مراجعة.");
  principal=safe(principal+position.principalMinor);paid=safe(paid+position.settledMinor);
 }
 if(principal!==safe(header.agreed_minor))fail("agreement_review_required","مصادر الاتفاق لا تطابق كامل الأصل.");
 const {planProgress}=await import("./plans");
 const progress=planProgress({totalMinor:principal,status:"active",installments:header.source_snapshot.schedules.map(row=>({number:row.number,dueDate:row.due_date,amountMinor:safe(row.amount_minor)}))},paid,today);
 return {kind:"invoice_backed",invoiceIds:members.map(row=>row.invoice_id),paidMinor:paid,remainingMinor:progress.remainingMinor,progress,schedules:[],message:"اتفاق مسوّى متعدد المصادر؛ التحصيل من حساب المريض على فاتورة المصدر، وليس بإصدار قسط جديد."};
}
