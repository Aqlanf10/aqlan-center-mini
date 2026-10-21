import {readInvoiceSettlementPosition} from "./invoice-settlement-position";
import {clinicDateString} from "./schedule";
import {CLINIC_TIME_ZONE} from "./db";
import { ensureSchema, getPool, getPayment, getSettingsInTransaction, insertAuditRow, writeDebtCollectionReceipt, type DbClient } from "./db";
import { canHandleMoney } from "./roles";
import { revalidateSessionInTransaction } from "./session";
import type { SessionPayload } from "./auth";
import { assertDebtSession, DebtRepaymentError, debtRequestHash, readDebtPosition, type DebtTarget } from "./debt-installments-db";
import { lockDebtAccountForSchedule, debtAccountDue } from "./debt-account-position";
import { attributeInstallment } from "./plans";
import { documentNumberSql } from "./document-numbers";
import { CLINIC_BASE_CURRENCY, isCurrency, settlePaymentMinor, toBaseAmount, type Currency } from "./money";
import { rateFromSettings } from "./settings";
import { debtRevisionSourceMatches } from "./debt-source-proof";

export type AgreementSource = { kind: "new" } | { kind: "invoice"; invoiceId: number } | { kind: "opening"; historicalPaidMinor: number };
export interface ApprovedAgreement {
  plan_id:number; patient_id:number; currency:Currency; total_minor:string; historical_paid_minor:string;
  invoice_id:number|null; opening_currency:Currency|null; source_kind:string;
  terms: { installments: {dueDate:string;amountMinor:number}[]; title:string }; source_snapshot:Record<string,unknown>;
  request_hash:string; idempotency_key:string;
}
const fail = (message:string):never => {throw new DebtRepaymentError("invalid",message);};
const validKey=(key:string)=>/^[A-Za-z0-9._:-]{8,128}$/.test(key);
const positive=(n:number)=>Number.isSafeInteger(n)&&n>0;
export async function readApprovedAgreement(reader:Pick<DbClient,"query">,planId:number) {
  return (await reader.query<ApprovedAgreement>("SELECT * FROM approved_agreement_principals WHERE plan_id=$1",[planId])).rows[0] ?? null;
}
/** Full-principal agreements remain collectible after an append-only refund.
 * Validate the canonical settlement position first; retain every approval-time
 * receipt and all source facts. Debt schedule revision policy stays unchanged. */
function approvedSourceMatches(current:Record<string,unknown>,saved:Record<string,unknown>) {
  if(!Array.isArray(current.payments)||!Array.isArray(saved.payments))return debtRevisionSourceMatches(current,saved);
  const after=new Map(current.payments.map((row:{id:number})=>[row.id,row]));
  if(!saved.payments.every((row:{id:number})=>after.has(row.id)&&debtRequestHash(row)===debtRequestHash(after.get(row.id))))return false;
  return debtRevisionSourceMatches({...current,payments:saved.payments},saved);
}
function target(a:ApprovedAgreement):DebtTarget {return {patientId:a.patient_id,currency:a.currency,invoiceId:a.invoice_id,openingCurrency:a.opening_currency};}
async function transaction<T>(run:(client:DbClient)=>Promise<T>, readOnly=false) {
  await ensureSchema();const client=await getPool().connect();let destroy=false;
  try {await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");const result=await run(client);await client.query("COMMIT");return result;}
  catch(error){try{await client.query("ROLLBACK");}catch{destroy=true;}throw error;}
  finally{client.release(destroy);}
}

/** Explicit approval or explicit whole-source reconciliation. Never infer a
 * historical source from patient totals, matching amounts, or a plan title. */
export async function approveAgreement(input:{planId:number;expectedTotalMinor:number;currency:Currency;source:AgreementSource;
  reason:string;idempotencyKey:string;session:SessionPayload}) {
  if(!positive(input.planId)||!positive(input.expectedTotalMinor)||!isCurrency(input.currency)||!validKey(input.idempotencyKey)
    ||typeof input.reason!=="string"||input.reason.trim().length<3||input.reason.trim().length>300)fail("راجع بيانات اعتماد الالتزام.");
  if(!input.source||!["new","invoice","opening"].includes(input.source.kind))fail("اختر مصدر أصل الدين صراحةً.");
  if(input.source.kind==="invoice"&&!positive(input.source.invoiceId))fail("اختر الفاتورة القائمة.");
  if(input.source.kind==="opening"&&(!Number.isSafeInteger(input.source.historicalPaidMinor)||input.source.historicalPaidMinor<0
    ||input.source.historicalPaidMinor>=input.expectedTotalMinor))fail("راجع المدفوع التاريخي والمتبقي الافتتاحي.");
  const hash=debtRequestHash({purpose:"approve-agreement-v1",...input,session:{id:input.session.userId,username:input.session.username}});
  return transaction(async client=>{
    await assertDebtSession(client,input.session);
    if(input.source.kind!=="new"&&(await revalidateSessionInTransaction(input.session,client))?.role!=="admin")throw new DebtRepaymentError("unauthorized","مطابقة أصل قديم للإدارة فقط.");
    const replay=async()=>{
      const prior=(await client.query<ApprovedAgreement>("SELECT * FROM approved_agreement_principals WHERE idempotency_key=$1 OR plan_id=$2",[input.idempotencyKey,input.planId])).rows[0];
      if(prior&&prior.request_hash!==hash)throw new DebtRepaymentError("conflict","الاتفاق معتمد أو مفتاح الطلب مستعمل؛ راجع المصدر دون إثبات دين ثانٍ.");
      return prior;
    };
    const prior=await replay();if(prior)return {agreement:prior,replayed:true};
    const owner=(await client.query<{patient_id:number}>("SELECT patient_id FROM treatment_plans WHERE id=$1",[input.planId])).rows[0];
    if(!owner)throw new DebtRepaymentError("missing","الخطة غير موجودة.");
    await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE",[owner.patient_id]);
    await lockDebtAccountForSchedule(client,owner.patient_id,true);
    const again=await replay();if(again)return {agreement:again,replayed:true};
    const p=(await client.query<{patient_id:number;total_minor:string;base_currency:Currency;status:string;consent_at:Date|null;title:string;primary_doctor_id:number|null}>(
      "SELECT patient_id,total_minor::text,base_currency,status,consent_at,title,primary_doctor_id FROM treatment_plans WHERE id=$1 FOR UPDATE",[input.planId])).rows[0];
    if(!p||p.patient_id!==owner.patient_id||p.status!=="active"||!p.consent_at||Number(p.total_minor)!==input.expectedTotalMinor||p.base_currency!==input.currency)
      throw new DebtRepaymentError("stale","تغيّرت الخطة أو لم تُسجّل موافقة المريض؛ أعد مراجعة القيمة والعملة.");
    const items=(await client.query<{id:number;doctor_id:number|null;service_id:number|null;service_name:string;value_minor:string;historical:boolean}>(
      `SELECT i.id,d.id AS doctor_id,i.service_id,i.service_name,(i.quantity::bigint*i.unit_price_minor)::text AS value_minor,
        (i.origin_invoice_id IS NOT NULL OR i.billed_invoice_id IS NOT NULL OR EXISTS(SELECT 1 FROM legacy_treatment_agreements la WHERE la.plan_item_id=i.id)) AS historical
       FROM plan_items i LEFT JOIN parties d ON d.id=i.doctor_id AND d.kind='doctor' WHERE i.plan_id=$1 AND i.status<>'cancelled' ORDER BY i.id`,[input.planId])).rows;
    let invoiceId:number|null=null;let openingCurrency:Currency|null=null;let historicalPaid=0;
    if(input.source.kind==="new") {
      const history=(await client.query(`SELECT 1 FROM invoices WHERE plan_id=$1 UNION ALL SELECT 1 FROM payments WHERE plan_id=$1
        UNION ALL SELECT 1 FROM patient_opening_balances WHERE patient_id=$2 AND currency=$3 LIMIT 1`,[input.planId,p.patient_id,p.base_currency])).rows;
      const clinicalHistory=(await client.query(`SELECT 1 FROM plan_items pi
        WHERE pi.plan_id=$1 AND (
          EXISTS(SELECT 1 FROM invoice_items ii LEFT JOIN visit_procedures vp
            ON ii.source_type='visit_procedure' AND ii.source_id=vp.id
            WHERE ii.plan_item_id=pi.id OR (ii.source_type='plan_item' AND ii.source_id=pi.id) OR vp.plan_item_id=pi.id)
          OR EXISTS(SELECT 1 FROM treatment_sessions ts JOIN visits v ON v.id=ts.visit_id
            WHERE ts.plan_item_id=pi.id AND (v.invoice_id IS NOT NULL OR EXISTS(SELECT 1 FROM payments p WHERE p.invoice_id=v.invoice_id)))
        ) LIMIT 1`,[input.planId])).rows;
      if(history.length||clinicalHistory.length||items.some(i=>i.historical))fail("للخطة أو العملة أصل سابق؛ استخدم مطابقة المصدر أو المراجعة المالية. لم يُضف دين.");
      invoiceId=(await client.query<{id:number}>(`INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,plan_id,note,created_by)
        VALUES(${documentNumberSql("invoice")},$1,$2,0,$3,$4,$5,$6) RETURNING id`,[p.patient_id,p.total_minor,p.base_currency,input.planId,input.reason,input.session.username])).rows[0].id;
      const primary=(await client.query<{id:number}>("SELECT id FROM parties WHERE id=$1 AND kind='doctor'",[p.primary_doctor_id])).rows[0]?.id??null;
      for(const line of attributeInstallment(Number(p.total_minor),items.map(i=>({doctorId:i.doctor_id,serviceId:i.service_id,serviceName:i.service_name,valueMinor:Number(i.value_minor)})),primary)) {
        await client.query(`INSERT INTO invoice_items(invoice_id,service_id,doctor_id,description,quantity,unit_price_minor,total_minor)
          VALUES($1,$2,$3,$4,1,$5,$5)`,[invoiceId,line.serviceId,line.doctorId,`${p.title} — اعتماد الالتزام${line.serviceName?` — ${line.serviceName}`:""}`,line.amountMinor]);
      }
    } else if(input.source.kind==="invoice") {
      invoiceId=input.source.invoiceId;
      const invoice=(await client.query<{plan_id:number|null}>("SELECT plan_id FROM invoices WHERE id=$1 AND patient_id=$2 AND base_currency=$3 AND total_minor-discount_minor=$4 AND status<>'cancelled'",[invoiceId,p.patient_id,p.base_currency,p.total_minor])).rows[0];
      if(!invoice||invoice.plan_id!==null&&invoice.plan_id!==input.planId)fail("الفاتورة ليست أصلًا كاملًا مطابقًا لهذه الخطة.");
      // A null invoice header is not proof of unowned clinical work. Signing
      // records ownership on lines/procedures, and corrections retain ancestors.
      // Keep standalone historical invoices eligible, but never override an
      // authoritative association with another agreement or treatment plan.
      const conflictingOwner=(await client.query(`WITH RECURSIVE lineage(id) AS (
        SELECT $2::int UNION SELECT c.original_invoice_id FROM invoice_corrections c JOIN lineage l ON l.id=c.corrected_invoice_id
      ), owners(plan_id) AS (
        SELECT i.plan_id FROM invoices i JOIN lineage l ON l.id=i.id
        UNION ALL SELECT a.plan_id FROM approved_agreement_principals a JOIN lineage l ON l.id=a.invoice_id
        UNION ALL SELECT p.plan_id FROM payments p JOIN lineage l ON l.id=p.invoice_id
        UNION ALL SELECT pi.plan_id FROM plan_items pi WHERE pi.origin_invoice_id IN(SELECT id FROM lineage) OR pi.billed_invoice_id IN(SELECT id FROM lineage)
        UNION ALL SELECT pi.plan_id FROM invoice_items ii JOIN lineage l ON l.id=ii.invoice_id
          JOIN plan_items pi ON pi.id=ii.plan_item_id OR (ii.source_type='plan_item' AND pi.id=ii.source_id)
        UNION ALL SELECT pi.plan_id FROM invoice_items ii JOIN lineage l ON l.id=ii.invoice_id
          JOIN visit_procedures vp ON ii.source_type='visit_procedure' AND vp.id=ii.source_id JOIN plan_items pi ON pi.id=vp.plan_item_id
        UNION ALL SELECT pi.plan_id FROM visits v JOIN lineage l ON l.id=v.invoice_id
          JOIN visit_procedures vp ON vp.visit_id=v.id JOIN plan_items pi ON pi.id=vp.plan_item_id
        UNION ALL SELECT pi.plan_id FROM visits v JOIN lineage l ON l.id=v.invoice_id
          JOIN treatment_sessions ts ON ts.visit_id=v.id JOIN plan_items pi ON pi.id=ts.plan_item_id
      ) SELECT 1 FROM owners WHERE plan_id<>$1
      UNION ALL SELECT 1 FROM invoice_items ii JOIN lineage l ON l.id=ii.invoice_id
        WHERE (ii.source_type='plan_item' AND NOT EXISTS(SELECT 1 FROM plan_items pi WHERE pi.id=ii.source_id))
           OR (ii.source_type='visit_procedure' AND NOT EXISTS(SELECT 1 FROM visit_procedures vp WHERE vp.id=ii.source_id))
      LIMIT 1`,[input.planId,invoiceId])).rows;
      if(conflictingOwner.length)fail("الفاتورة مرتبطة بخطة أخرى أو مرجع علاجي غير واضح؛ يلزم مراجعة ملكية المصدر دون اعتماد جديد.");
      const extra=(await client.query("SELECT 1 FROM invoices WHERE plan_id=$1 AND id<>$2 UNION ALL SELECT 1 FROM payments WHERE plan_id=$1 AND (invoice_id IS NULL OR invoice_id<>$2) LIMIT 1",[input.planId,invoiceId])).rows;
      if(extra.length)fail("توجد مصادر أو دفعات أخرى للخطة؛ يلزم مطابقة مالية متعددة المصادر.");
    } else {openingCurrency=p.base_currency;historicalPaid=input.source.historicalPaidMinor;
      const history=(await client.query("SELECT 1 FROM invoices WHERE plan_id=$1 UNION ALL SELECT 1 FROM payments WHERE plan_id=$1 LIMIT 1",[input.planId])).rows;
      if(history.length)fail("توجد فواتير أو دفعات مرتبطة بالخطة؛ لا تدمجها تلقائيًا مع الافتتاحي.");
    }
    const position=await readDebtPosition(client,{patientId:p.patient_id,currency:p.base_currency,invoiceId,openingCurrency},true);
    if(!position.available||position.principalMinor!==Number(p.total_minor)-historicalPaid)fail("أصل المصدر لا يطابق الالتزام والمدفوع التاريخي؛ لم يُغيّر أي رصيد.");
    const installments=(await client.query<{dueDate:string;amountMinor:string}>(`SELECT due_date::text AS "dueDate",amount_minor::text AS "amountMinor" FROM plan_installments WHERE plan_id=$1 ORDER BY number`,[input.planId])).rows.map(i=>({dueDate:i.dueDate,amountMinor:Number(i.amountMinor)}));
    if(installments.length&&installments.reduce((sum,i)=>sum+i.amountMinor,0)!==Number(p.total_minor))fail("جدول الخطة لا يطابق كامل الالتزام؛ راجعه قبل الاعتماد.");
    await client.query(`INSERT INTO approved_agreement_principals(plan_id,patient_id,currency,total_minor,historical_paid_minor,invoice_id,opening_currency,source_kind,terms,source_snapshot,reason,idempotency_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14)`,[input.planId,p.patient_id,p.base_currency,p.total_minor,historicalPaid,invoiceId,openingCurrency,input.source.kind,
      JSON.stringify({title:p.title,itemIds:items.map(i=>i.id),installments}),JSON.stringify(position.sourceSnapshot),input.reason.trim(),input.idempotencyKey,hash,input.session.username]);
    await insertAuditRow(client,{action:"plan.financial_approval",entity:"treatment_plans",entityId:input.planId,actor:input.session.username,actorRole:input.session.role,
      details:{source:input.source,totalMinor:Number(p.total_minor),currency:p.base_currency,invoiceId,openingCurrency,historicalPaidMinor:historicalPaid,reason:input.reason}});
    await assertDebtSession(client,input.session);
    return {agreement:(await readApprovedAgreement(client,input.planId))!,replayed:false};
  });
}

export async function approvedAgreementPosition(planId:number,today:string, reader?:DbClient):Promise<{
  planId:number;currency:Currency;totalMinor:number;paidMinor:number;remainingMinor:number;dueNowMinor:number;
  invoiceId:number|null;openingCurrency:Currency|null;sourceKind:string;available:boolean;
}|null> {
  if(!reader)return transaction(client=>approvedAgreementPosition(planId,today,client),true);
  const a=await readApprovedAgreement(reader,planId);if(!a)return null;
  const position=await readDebtPosition(reader,target(a));
  // The immutable approval remains historical principal. Only explicit, dated
  // difference documents raise today's agreement. No old receipt is reassigned.
  const installed=(await reader.query<{present:boolean}>(
    "SELECT to_regclass('public.agreement_delta_amendments') IS NOT NULL AS present")).rows[0]?.present;
  const deltas=installed ? (await reader.query<{delta_invoice_id:number;delta_minor:string;patient_id:number}>(
    "SELECT delta_invoice_id,delta_minor::text,patient_id FROM agreement_delta_amendments WHERE plan_id=$1 ORDER BY id",[planId])).rows : [];
  let deltaTotal=0,deltaSettled=0,deltaAvailable=true;
  for(const event of deltas){
    if(event.patient_id!==a.patient_id||a.invoice_id===null)throw new Error("Unverifiable agreement amendment");
    const doc=await readInvoiceSettlementPosition(reader,{patientId:a.patient_id,invoiceId:event.delta_invoice_id,currency:a.currency});
    if(!doc.available||doc.principalMinor!==Number(event.delta_minor))deltaAvailable=false;
    deltaTotal+=Number(event.delta_minor);
    deltaSettled+=doc.settledMinor;
  }
  const currentTotal=Number(a.total_minor)+deltaTotal;
  const paid=Number(a.historical_paid_minor)+position.settledMinor+deltaSettled;
  const remaining=Math.max(0,currentTotal-paid);
  if(![deltaTotal,deltaSettled,currentTotal,paid,remaining].every(Number.isSafeInteger))
    throw new Error("Agreement amendment totals exceed safe monetary units");
  const originalDue=a.terms.installments.length?a.terms.installments.filter(i=>i.dueDate<=today).reduce((s,i)=>s+i.amountMinor,0):Number(a.total_minor);
  const dueNow=Math.min(remaining,Math.max(0,originalDue+deltaTotal-paid));
  return {planId,currency:a.currency,totalMinor:currentTotal,paidMinor:paid,remainingMinor:remaining,
    dueNowMinor:dueNow,invoiceId:a.invoice_id,openingCurrency:a.opening_currency,sourceKind:a.source_kind,
    available:position.available&&deltaAvailable&&approvedSourceMatches(position.sourceSnapshot,a.source_snapshot)};
}

async function assertCollectionSession(client:DbClient,session:SessionPayload) {
  const current=await revalidateSessionInTransaction(session,client);
  if(!current||!canHandleMoney(current.role))throw new DebtRepaymentError("unauthorized","انتهت الجلسة أو تغيّرت صلاحية التحصيل.");
}
export async function collectApprovedAgreement(input:{planId:number;amountMinor:number;currency:Currency;method:"cash"|"transfer";note:string|null;idempotencyKey:string;session:SessionPayload}) {
  if(!positive(input.planId)||!positive(input.amountMinor)||!isCurrency(input.currency)||!validKey(input.idempotencyKey)||!["cash","transfer"].includes(input.method))fail("راجع بيانات التحصيل.");
  const hash=debtRequestHash({purpose:"approved-agreement-collection-v1",...input,session:{id:input.session.userId,username:input.session.username}});
  const receipt=await transaction(async client=>{
    await assertCollectionSession(client,input.session);
    const replay=async()=>{const p=(await client.query<{id:number;idempotency_request_hash:string}>("SELECT id,idempotency_request_hash FROM payments WHERE idempotency_key=$1",[input.idempotencyKey])).rows[0];
      if(p&&p.idempotency_request_hash!==hash)throw new DebtRepaymentError("conflict","مفتاح التحصيل مستعمل بطلب مختلف.");return p;};
    const groupReplay=async()=>{
      const row=(await client.query<{request_hash:string;actor_id:number;plan_id:number;patient_id:number;payment_ids:number[];result_snapshot:Record<string,unknown>}>(
        "SELECT request_hash,actor_id,plan_id,patient_id,payment_ids,result_snapshot FROM agreement_delta_collection_receipts WHERE idempotency_key=$1",
        [input.idempotencyKey])).rows[0];
      if(!row)return null;
      if(row.request_hash!==hash||row.actor_id!==input.session.userId||row.plan_id!==input.planId
        ||!Array.isArray(row.payment_ids)||!row.payment_ids.length
        ||!row.payment_ids.every(positive))
        throw new DebtRepaymentError("conflict","مفتاح تحصيل الفرق لا يطابق المحاولة السابقة.");
      return {paymentId:row.payment_ids[0],paymentIds:row.payment_ids,replayed:true};
    };
    const grouped=await groupReplay();if(grouped)return grouped;
    const prior=await replay();if(prior)return {paymentId:prior.id,replayed:true};
    const a=await readApprovedAgreement(client,input.planId);if(!a)throw new DebtRepaymentError("missing","لم يُعتمد أصل مالي لهذه الخطة.");
    await client.query("SELECT id FROM patients WHERE id=$1 FOR KEY SHARE",[a.patient_id]);
    await lockDebtAccountForSchedule(client,a.patient_id);
    const groupedAfterLock=await groupReplay();if(groupedAfterLock)return groupedAfterLock;
    const waited=await replay();if(waited)return {paymentId:waited.id,replayed:true};
    const position=await readDebtPosition(client,target(a),true);
    if(!position.available||!approvedSourceMatches(position.sourceSnapshot,a.source_snapshot))throw new DebtRepaymentError("stale","تغير مصدر الأصل؛ يلزم مراجعة مالية قبل التحصيل.");
    if(input.currency!==a.currency&&a.currency!==CLINIC_BASE_CURRENCY)fail("حصّل الاتفاق بعملته؛ لا يوجد تحويل مسجل بين هاتين العملتين.");
    const rate=rateFromSettings(await getSettingsInTransaction(client,{requireStoredExchangeRates:true}),input.currency,CLINIC_BASE_CURRENCY);
    if(rate===null||!Number.isFinite(rate)||rate<=0)return fail("اضبط سعر الصرف المعتمد قبل التحصيل.");
    const base=toBaseAmount(input.amountMinor,input.currency,CLINIC_BASE_CURRENCY,rate);
    const settlement=settlePaymentMinor({amountMinor:input.amountMinor,currency:input.currency,baseAmountMinor:base},a.currency);
    const account=await debtAccountDue(client,a.patient_id,a.currency);
    const amendments=(await client.query<{delta_invoice_id:number;delta_minor:string}>(
      "SELECT delta_invoice_id,delta_minor::text FROM agreement_delta_amendments WHERE plan_id=$1 ORDER BY id",[input.planId])).rows;
    const allowedRemaining=amendments.length
      ? (await approvedAgreementPosition(input.planId,clinicDateString(new Date(),CLINIC_TIME_ZONE),client))
      : null;
    if(amendments.length&&!allowedRemaining?.available)
      throw new DebtRepaymentError("stale","تغير مصدر الاتفاق بعد الترقية؛ أعد مراجعة كشف الحساب.");
    if(!positive(settlement)||settlement>(allowedRemaining?.remainingMinor??position.remainingMinor)
       ||settlement>account.due)fail("المبلغ يتجاوز متبقي المصدر أو الحساب.");
    if(amendments.length){
      // This first supported amendment flow accepts native agreement currency
      // only: one external FX receipt cannot be safely split and replayed.
      if(input.currency!==a.currency || a.invoice_id===null)
        fail("حصّل اتفاق الترقية بعملة الاتفاق وبمصدر فاتورة مثبت.");
      const current=await approvedAgreementPosition(input.planId,clinicDateString(new Date(),CLINIC_TIME_ZONE),client);
      if(!current?.available)throw new DebtRepaymentError("stale","مصادر الترقية تغيرت؛ يلزم تحديث الاتفاق.");
      if(settlement>current.remainingMinor)fail("المبلغ يتجاوز متبقي الاتفاق المعدّل.");
      const segments=[{invoiceId:a.invoice_id,remainingMinor:position.remainingMinor}];
      for(const amendment of amendments){
        const delta=await readInvoiceSettlementPosition(client,{
          patientId:a.patient_id,invoiceId:amendment.delta_invoice_id,currency:a.currency});
        if(!delta.available||delta.principalMinor!==Number(amendment.delta_minor))
          throw new DebtRepaymentError("stale","فرق التعديل لا يطابق مصدره.");
        segments.push({invoiceId:amendment.delta_invoice_id,remainingMinor:delta.remainingMinor});
      }
      if(segments.reduce((n,x)=>n+x.remainingMinor,0)!==current.remainingMinor)
        throw new DebtRepaymentError("conflict","التزام الخطة ومصادر الفواتير غير متطابقة.");
      const created:{invoiceId:number;paymentId:number;amountMinor:number}[]=[];
      let unallocated=settlement;
      for(const segment of segments){
        const portion=Math.min(unallocated,segment.remainingMinor);
        if(!portion)continue;
        // Child receipts have disjoint durable keys and each uses the same
        // canonical receipt/cashbox writer. The outer transaction owns all.
        const childKey=`agreement-delta:${hash.slice(0,38)}:${segment.invoiceId}`;
        const child=await writeDebtCollectionReceipt(client,{
          patientId:a.patient_id,invoiceId:segment.invoiceId,openingCurrency:null,
          amountMinor:portion,currency:input.currency,exchangeRate:rate,
          method:input.method,note:input.note,createdBy:input.session.username,
          idempotencyKey:childKey,requestHash:debtRequestHash({
            hash,invoiceId:segment.invoiceId,portion})});
        if(child.kind==="reason")throw new DebtRepaymentError("stale",`تعذر توزيع التحصيل: ${child.reason}`);
        if(typeof child.paymentId!=="number"||!positive(child.paymentId))
          throw new DebtRepaymentError("conflict","تعذر إثبات سند توزيع التحصيل.");
        created.push({invoiceId:segment.invoiceId,paymentId:child.paymentId,amountMinor:portion});
        unallocated-=portion;
      }
      if(unallocated!==0||created.length===0)
        throw new DebtRepaymentError("conflict","تعذر توزيع التحصيل كاملًا دون تجاوز المصدر.");
      const paymentIds=created.map(row=>row.paymentId);
      const snapshot={planId:input.planId,patientId:a.patient_id,currency:a.currency,
        amountMinor:settlement,allocations:created,paymentIds};
      await client.query(`INSERT INTO agreement_delta_collection_receipts
         (idempotency_key,request_hash,actor_id,plan_id,patient_id,payment_ids,result_snapshot)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[
        input.idempotencyKey,hash,input.session.userId,input.planId,a.patient_id,paymentIds,JSON.stringify(snapshot)]);
      for(const row of created){
        await insertAuditRow(client,{action:"plan.approved_collection",entity:"payment",entityId:row.paymentId,
          actor:input.session.username,actorRole:input.session.role,
          details:{planId:input.planId,invoiceId:row.invoiceId,settlementMinor:row.amountMinor,
            logicalCollectionKey:input.idempotencyKey,deltaCollection:true}});
      }
      await assertCollectionSession(client,input.session);
      return {paymentId:paymentIds[0],paymentIds,replayed:false};
    }
    const result=await writeDebtCollectionReceipt(client,{patientId:a.patient_id,invoiceId:a.invoice_id,openingCurrency:a.opening_currency,
      amountMinor:input.amountMinor,currency:input.currency,exchangeRate:rate,method:input.method,note:input.note,createdBy:input.session.username,idempotencyKey:input.idempotencyKey,requestHash:hash});
    if(result.kind==="reason")throw new DebtRepaymentError("stale",`تعذر التحصيل: ${result.reason}`);
    await insertAuditRow(client,{action:"plan.approved_collection",entity:"payment",entityId:result.paymentId,actor:input.session.username,actorRole:input.session.role,
      details:{planId:input.planId,invoiceId:a.invoice_id,openingCurrency:a.opening_currency,settlementMinor:settlement,remainingMinor:position.remainingMinor-settlement}});
    await assertCollectionSession(client,input.session);
    return {paymentId:result.paymentId,replayed:result.kind==="replay"};
  });
  return {...receipt,payment:await getPayment(receipt.paymentId)};
}

/** Invoked after the canonical shift lock, before any settlement-target lock.
 * All receipt writers (including correction/recovery adapters) share this fence.
 * Unapproved sources retain their existing policy. */
export async function fenceApprovedReceiptSource(client:DbClient,patientId:number,invoiceId:number|null,openingCurrency:Currency|null) {
  const approval=(await client.query<ApprovedAgreement>(`SELECT * FROM approved_agreement_principals
    WHERE patient_id=$1 AND (invoice_id=$2 OR ($2::int IS NULL AND opening_currency=$3))`,[patientId,invoiceId,openingCurrency])).rows[0];
  if(approval)await lockDebtAccountForSchedule(client,patientId);
  return approval??null;
}
export async function assertApprovedReceiptLimit(client:DbClient,a:ApprovedAgreement,amountMinor:number,currency:Currency,baseAmountMinor:number,key:string|null) {
  if(!key||!validKey(key))fail("التحصيل من أصل معتمد يتطلب مفتاح إعادة ثابتًا.");
  const position=await readDebtPosition(client,target(a),true);
  if(!position.available||!approvedSourceMatches(position.sourceSnapshot,a.source_snapshot))throw new DebtRepaymentError("stale","تغير مصدر الاتفاق؛ يلزم مراجعة مالية.");
  const settlement=settlePaymentMinor({amountMinor,currency,baseAmountMinor},a.currency);
  if(!positive(settlement)||settlement>position.remainingMinor||settlement>(await debtAccountDue(client,a.patient_id,a.currency)).due)fail("المبلغ يتجاوز متبقي المصدر أو الحساب.");
}
