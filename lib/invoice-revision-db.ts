import { linkedLabWorkForInvoiceInTransaction, aliasCorrectedInvoiceLabWorkInTransaction } from "./lab-invoice-source-links";
import type { InvoiceCurrencyScopeReason } from "./invoice-currency-scope";
import {currencyCorrectionTargets,prepareInvoiceCurrencyChange,writeInvoiceCurrencyEvidence,InvoiceCurrencyScopeError} from "./invoice-currency-plan";
import {invoiceQuantityAllowed} from "./invoice-clinical-linkage";
import {invoiceIdentityCatalog,validateInvoiceIdentityAmendments} from "./invoice-identity-amendments";
import type { SessionPayload } from "./auth";
import { CLINIC_TIME_ZONE, correctInvoiceInTransaction, ensureSchema, getInvoice, getPool, getSettingsInTransaction,
  insertAuditRow, lockPlanItemsBilledBy, recomputePlanTotal, type DbClient } from "./db";
import { debtAccountDue, lockDebtAccountForSchedule } from "./debt-account-position";
import { DebtRepaymentError, debtRequestHash, readDebtPosition, writeDebtRepaymentInTransaction } from "./debt-installments-db";
import { validateDebtRepaymentTerms } from "./debt-installments";
import { planInvoiceRevision } from "./invoice-correction";
import { parseAmount, type Currency } from "./money";
import { clinicDateString } from "./schedule";
import { revalidateSessionInTransaction } from "./session";
import { INVOICE_APPROVED_WORK_SQL } from "./invoice-correction-coverage";

interface RevisionWork {
  id:number;plan_id:number;service_id:number|null;doctor_id:number|null;category:string|null;quantity:number;unit_price_minor:string;
  tooth_code:number|null;surfaces:string|null;case_id:number|null;case_site:string|null;status:string;clinical_locked:boolean;legacy:boolean;
}

function bad(message: string, code: DebtRepaymentError["code"] = "invalid"): never { throw new DebtRepaymentError(code, message); }
async function authority(client: DbClient, session: SessionPayload) {
  const current = await revalidateSessionInTransaction(session, client);
  if (!current || current.role !== "admin") bad("تصحيح الفاتورة يحتاج جلسة مدير سارية؛ سجّل الدخول من جديد.", "unauthorized");
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

async function contextInTx(client: DbClient, invoiceId: number) {
  const invoice = await getInvoice(invoiceId, client);
  if (!invoice) bad("الفاتورة غير موجودة.", "missing");
  const target = { patientId: invoice.patientId, currency: invoice.baseCurrency, invoiceId, openingCurrency: null };
  const position = await readDebtPosition(client, target);
  const { rows: work } = await client.query<RevisionWork>(
    `SELECT i.id,i.plan_id,i.service_id,i.doctor_id,i.category,i.quantity,i.unit_price_minor::text,i.tooth_code,i.surfaces,i.case_id,c.site AS case_site,i.status,
      (i.status<>'planned' OR i.started_at IS NOT NULL OR i.sessions_completed>0
        OR EXISTS (SELECT 1 FROM visit_procedures p WHERE p.plan_item_id=i.id)
        OR EXISTS (SELECT 1 FROM treatment_sessions s WHERE s.plan_item_id=i.id AND (s.status<>'planned' OR s.visit_id IS NOT NULL OR s.completed_at IS NOT NULL))
        OR EXISTS (SELECT 1 FROM endo_treatments e WHERE e.case_id=i.case_id OR e.crown_plan_item_id=i.id)
        OR c.ortho_case_id IS NOT NULL OR COALESCE(c.status<>'active',FALSE) OR length(btrim(COALESCE(c.problem,'')))>0
        OR EXISTS (SELECT 1 FROM visits v WHERE v.case_id=i.case_id)
        OR length(btrim(COALESCE(c.outcome,'')))>0
        OR EXISTS (SELECT 1 FROM patient_problems p WHERE p.case_id=i.case_id OR p.plan_item_id=i.id)
        OR EXISTS (SELECT 1 FROM patient_referrals r WHERE r.case_id=i.case_id OR r.blocks_case_id=i.case_id OR r.plan_item_id=i.id)
        OR EXISTS (SELECT 1 FROM plan_item_dependencies d WHERE d.item_id=i.id OR d.requires_item_id=i.id)
        OR (SELECT count(*) FROM plan_items shared WHERE shared.case_id=i.case_id)>1
        OR EXISTS (SELECT 1 FROM commission_case_overrides o WHERE o.case_id=i.case_id OR o.plan_id=i.plan_id)) AS clinical_locked,
      EXISTS (SELECT 1 FROM legacy_treatment_agreements a WHERE a.plan_item_id=i.id) AS legacy
     FROM plan_items i LEFT JOIN clinical_cases c ON c.id=i.case_id
     WHERE i.id IN (SELECT plan_item_id FROM invoice_items WHERE invoice_id=$1) ORDER BY i.id`, [invoiceId]);
  const labLinks = await linkedLabWorkForInvoiceInTransaction(client,{patientId:invoice.patientId,invoiceId});
  for(const item of work) if(labLinks.planItemIds.includes(item.id)) item.clinical_locked=true;
  const { rows: [schedule] } = await client.query<{ id: number; version: number; status: string; terms: unknown }>(
    `SELECT a.id,r.version,r.status,r.terms FROM debt_repayment_arrangements a JOIN LATERAL
      (SELECT version,status,terms FROM debt_repayment_revisions WHERE arrangement_id=a.id ORDER BY version DESC LIMIT 1) r ON TRUE
      WHERE a.patient_id=$1 AND a.invoice_id=$2`, [invoice.patientId,invoice.id]);
  const accountDueMinor = (await debtAccountDue(client,invoice.patientId,invoice.baseCurrency)).due;
  const identityCatalog=await invoiceIdentityCatalog(client);
  const {rows:[bound]}=await client.query<{bound:boolean}>("SELECT EXISTS(SELECT 1 FROM invoice_items WHERE invoice_id=$1 AND (source_type IS NOT NULL OR source_id IS NOT NULL) AND source_type IS DISTINCT FROM 'plan_item') AS bound",[invoiceId]);
  const identityAmendmentAvailable=Array.isArray(position.sourceSnapshot.payments)&&position.sourceSnapshot.payments.length===0&&!bound.bound;
  // Every distinct target is checked independently. YER -> SAR may carry recorded SAR
  // receipts; any other direction is offered only for a lineage with no receipt at all.
  const options:{currency:Currency;settledMinor:number;accountDueMinor:number}[]=[];
  const receiptCounts=new Map<Currency,number>();
  let refusal:{message:string;reasonCodes?:InvoiceCurrencyScopeReason[]}|null=null;
  for(const target of currencyCorrectionTargets(invoice.baseCurrency)){
    try{const planned=await prepareInvoiceCurrencyChange(client,invoice,0,target);
      options.push({currency:target,settledMinor:planned.settledMinor,accountDueMinor:(await debtAccountDue(client,invoice.patientId,target)).due});
      receiptCounts.set(target,planned.receiptCount);
    }catch(error){refusal??={...(error instanceof InvoiceCurrencyScopeError?{reasonCodes:error.reasonCodes}:{}),message:error instanceof Error?error.message:"تعذر إثبات تسوية العملة."};}
  }
  const first=options[0];
  const currencyCorrection={available:options.length>0,targetCurrency:first?.currency??currencyCorrectionTargets(invoice.baseCurrency)[0],
    targets:options.map(option=>option.currency),options,settledMinor:first?.settledMinor??0,accountDueMinor:first?.accountDueMinor??0,
    message:!first?refusal?.message??"تعذر إثبات تسوية العملة."
      :first.settledMinor>0?"تُنقل تسوية السندات السعودية المثبتة دون حركة نقدية."
      :(receiptCounts.get(first.currency)??0)>0?"صافي تسوية السندات المسجّلة على الفاتورة صفر؛ تصدر فاتورة بديلة بالعملة المختارة بالمبالغ التي تكتبها، دون حركة نقدية ودون تحويل بسعر صرف."
      :"لا يوجد سند على الفاتورة؛ تصدر فاتورة بديلة بالعملة المختارة بالمبالغ التي تكتبها، دون تحويل بسعر صرف.",
    ...(!first&&refusal?.reasonCodes?{reasonCodes:refusal.reasonCodes}:{})};
  const facts = { currencyCorrection, invoice, work,identityCatalog,identityAmendmentAvailable, settledMinor: position.settledMinor, remainingMinor: position.remainingMinor,
    accountDueMinor,settlementProofHash:position.settlementProofHash, repaymentVersion: schedule?.version ?? 0, repaymentTerms: schedule?.status === "active" ? schedule.terms : { mode: "full", installments: [] } };
  return { ...facts, sourceHash: debtRequestHash(facts), schedule, target };
}

export async function readInvoiceRevision(invoiceId: number, session: SessionPayload) {
  await ensureSchema(); const client = await getPool().connect(); let destroy=false;
  try {
    // Current authority is checked before the strictly read-only snapshot.
    await authority(client,session); await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await contextInTx(client,invoiceId); await client.query("COMMIT"); return result;
  } catch (error) { try{await client.query("ROLLBACK");}catch{destroy=true;} throw error; } finally { client.release(destroy); }
}

/** One transaction owns replacement, settlement lineage, dated repayment terms
 * and the exact immutable acknowledgement. It creates no payment or refund. */
export async function reviseInvoice(invoiceId: number, source: Record<string, unknown>, session: SessionPayload) {
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0 || session.role !== "admin") bad("تصحيح الفاتورة للمدير وحده.", "unauthorized");
  if (Object.keys(source).some(key => !["idempotencyKey","expectedSourceHash","reason","lines","discount","discountReason","repaymentTerms","expectedRemainingMinor","currency"].includes(key))) bad("حقول التصحيح غير مدعومة.");
  if (typeof source.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(source.idempotencyKey)
    || typeof source.expectedSourceHash !== "string" || !/^[a-f0-9]{64}$/.test(source.expectedSourceHash)
    || typeof source.reason !== "string" || source.reason.trim().length < 3 || source.reason.trim().length > 300) bad("راجع مفتاح الطلب والنسخة وسبب التصحيح.");
  const reason = source.reason.trim(), key = source.idempotencyKey;
  const hash = debtRequestHash({ purpose: "invoice-revision-v1", invoiceId, source, actor: { userId: session.userId, username: session.username, role: session.role } });
  await ensureSchema(); const client = await getPool().connect(); let destroy=false;
  try {
    await client.query("BEGIN"); await authority(client,session);
    const replay = async () => {
      const { rows: [row] } = await client.query<{ request_hash: string; original_invoice_id: number; created_by: string; receipt: Record<string, unknown> | null }>(
        `SELECT c.request_hash,c.original_invoice_id,c.created_by,r.receipt FROM invoice_corrections c
          LEFT JOIN invoice_correction_receipts r ON r.correction_id=c.id WHERE c.idempotency_key=$1`, [key]);
      if (!row) return null;
      if (row.request_hash !== hash || row.original_invoice_id !== invoiceId || row.created_by !== session.username) bad("مفتاح التصحيح مستعمل بطلب مختلف.", "conflict");
      if (!row.receipt) bad("إقرار التصحيح غير مكتمل؛ راجع العملية بالمفتاح نفسه.", "conflict");
      return row.receipt;
    };
    const early = await replay();
    if (early) { await authority(client,session); await client.query("COMMIT"); return { ...early, replayed: true }; }
    const { rows: [owner] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM invoices WHERE id=$1", [invoiceId]);
    if (!owner) bad("الفاتورة غير موجودة.", "missing");
    // Payroll/commission writers can need shift locks; fence them before holding
    // patient, receipt or shift locks to avoid reversing their lock order.
    // Calculation writes its run before reading commissions and inserting items.
    // Fence that first write too, including a run with no items yet.
    if(typeof source.currency==="string")await client.query("LOCK TABLE expenses,hr_payroll_runs,hr_payroll_items IN SHARE MODE");
    await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [owner.patient_id]);
    // Event foreign keys need receipt KEY SHARE locks. Refunds/corrections lock
    // their original receipt before shift, so acquire these compatible read-only
    // fences in the same order, never implicitly through an FK after shift.
    const receiptFenceSql=`WITH RECURSIVE lineage(id) AS (SELECT $1::int UNION
      SELECT c.original_invoice_id FROM invoice_corrections c JOIN lineage l ON c.corrected_invoice_id=l.id)
      SELECT p.id FROM payments p WHERE p.invoice_id IN(SELECT id FROM lineage) AND p.patient_id=$2 ORDER BY p.id`;
    const receiptFence=typeof source.currency==="string"?(await client.query<{id:number}>(receiptFenceSql+" FOR KEY SHARE OF p",[invoiceId,owner.patient_id])).rows:null;
    await client.query("SELECT id FROM cashier_shifts WHERE status='open' ORDER BY id FOR UPDATE");
    // A new receipt may commit between the receipt scan and shift acquisition.
    // Never take its receipt lock after shift: require a fresh preview instead.
    if(receiptFence){const current=(await client.query<{id:number}>(receiptFenceSql,[invoiceId,owner.patient_id])).rows;
      if(JSON.stringify(current)!==JSON.stringify(receiptFence))bad("تغيّرت السندات أثناء تثبيت التصحيح؛ حدّث المعاينة.","stale");}
    // The canonical correction relinks these exact visits. Fence them before
    // plans/invoices so checkout cannot hold visit and wait on our invoice.
    await client.query("SELECT id FROM visits WHERE invoice_id=$1 ORDER BY id FOR UPDATE",[invoiceId]);
    await lockPlanItemsBilledBy(client,invoiceId);
    // Case-only assessments can be saved without a visit or a patient fence.
    // Hold their identity while checking whether work shape may be corrected.
    await client.query(`SELECT c.id FROM clinical_cases c WHERE c.id IN
      (SELECT i.case_id FROM plan_items i JOIN invoice_items ii ON ii.plan_item_id=i.id WHERE ii.invoice_id=$1)
      ORDER BY c.id FOR UPDATE`,[invoiceId]);
    await lockDebtAccountForSchedule(client,owner.patient_id);
    const waited = await replay();
    if (waited) { await authority(client,session); await client.query("COMMIT"); return { ...waited, replayed: true }; }
    const before = await contextInTx(client,invoiceId);
    if (before.invoice.status === "cancelled") bad("الفاتورة استبدلت أو ألغيت؛ افتح النسخة الحالية.", "conflict");
    if (before.sourceHash !== source.expectedSourceHash) bad("تغيّرت الفاتورة أو المدفوعات أو الأقساط؛ حدّث معاينة الفرق.", "stale");
    await client.query("LOCK TABLE settings IN SHARE MODE");
    const settings = await getSettingsInTransaction(client);
    const date = clinicDateString(new Date(before.invoice.createdAt),CLINIC_TIME_ZONE);
    if (settings["finance.locked_before"]?.trim() && date < settings["finance.locked_before"].trim()) bad("الفاتورة في فترة مقفلة؛ يلزم تصحيح معتمد في فترة مفتوحة.", "conflict");
    if (!Array.isArray(source.lines) || source.lines.length > 200 || !source.lines.every(record)) bad("بنود التصحيح غير صالحة.");
    const currency=source.currency===undefined?before.invoice.baseCurrency:source.currency;
    if(currency!=="YER"&&currency!=="SAR"&&currency!=="USD")bad("انتقال العملة غير مدعوم.");
    const changingCurrency=currency!==before.invoice.baseCurrency;
    const currencyPlan=changingCurrency?await prepareInvoiceCurrencyChange(client,before.invoice,0,currency):null;
    const settledMinor=currencyPlan?.settledMinor??before.settledMinor;
    if(changingCurrency&&(source.lines.length!==before.invoice.items.length||source.lines.some(line=>before.invoice.items.find(item=>item.id===line.itemId)?.quantity!==line.quantity)))bad("عند تصحيح العملة يجب إبقاء جميع بنود العلاج وكمياتها.");
    const lines = source.lines.map(line => {
      if (Object.keys(line).some(key => !["itemId","quantity","unitPrice","serviceId","doctorId","toothCode","surfaces"].includes(key))) bad("حقول بند التصحيح غير مدعومة.");
      const unitPriceMinor = typeof line.unitPrice === "string" ? parseAmount(line.unitPrice,currency as "YER"|"SAR"|"USD") : null;
      if (unitPriceMinor === null || typeof line.itemId !== "number" || typeof line.quantity !== "number") bad("السعر والكمية وهوية البند مطلوبة.");
      return { itemId: line.itemId, quantity: line.quantity, unitPriceMinor };
    });
    const labLinks = await linkedLabWorkForInvoiceInTransaction(client,{patientId:owner.patient_id,invoiceId,lock:true});
    const amendments=await validateInvoiceIdentityAmendments(client,before.invoice,source.lines,before.work,before.identityAmendmentAvailable);
    for(const itemId of labLinks.invoiceItemIds){
      const original=before.invoice.items.find(item=>item.id===itemId);
      const retained=lines.find(item=>item.itemId===itemId);
      if(!original||!retained||retained.quantity!==original.quantity||amendments.has(itemId)) bad("بند مرتبط بوصفة مختبر؛ التصحيح المالي لا يغيّر هويته أو كميته ولا يحذفه.","conflict");
    }
    if(changingCurrency&&amendments.size)bad("تصحيح العملة لا يغيّر هوية العلاج أو الطبيب أو السن؛ استخدم مسار تصحيح العلاج المستقل.");
    const discountMinor = typeof source.discount === "string" ? parseAmount(source.discount,currency as "YER"|"SAR"|"USD") : null;
    if (discountMinor === null) bad("الخصم غير صالح.");
    const discountReason = typeof source.discountReason === "string" ? source.discountReason.trim() : "";
    if (discountMinor > 0 && (discountReason.length < 3 || discountReason.length > 300)) bad("اكتب سبب الخصم.");
    const planned = planInvoiceRevision(before.invoice.items,lines,discountMinor); if (!planned.ok) bad(planned.message);
    const netMinor = planned.totalMinor - planned.discountMinor;
    const remainingMinor = Math.max(0,netMinor-settledMinor);
    const terms = validateDebtRepaymentTerms(source.repaymentTerms,remainingMinor); if (!terms.ok) bad(terms.message);
    if (source.expectedRemainingMinor !== remainingMinor) bad("توزيع الأقساط لا يطابق المتبقي بعد التصحيح.", "stale");
    const afterDueMinor = changingCurrency?(await debtAccountDue(client,owner.patient_id,currency)).due+netMinor-settledMinor:before.accountDueMinor + netMinor - (before.invoice.totalMinor-before.invoice.discountMinor);
    if (remainingMinor > Math.max(0,afterDueMinor)) bad("توجد تسويات أخرى على الحساب؛ راجع تخصيص السندات قبل جدولة تحصيل إضافي.", "conflict");
    for (const work of before.work) {
      const original = before.invoice.items.find(item=>item.planItemId===work.id);
      if (!original || work.legacy) bad("البند مرتبط باتفاق تاريخي؛ صحّح وثيقته التاريخية من مسارها.","conflict");
      const line = lines.find(item=>item.itemId===original.id);
      if(line&&line.quantity!==work.quantity&&!invoiceQuantityAllowed(work.category,line.quantity))bad("سعر هذه الخدمة يغطي النطاق مرة واحدة؛ لا تُضاعف قيمة الفك أو الحالة بالكمية.","conflict");
      if ((!line || line.quantity !== work.quantity) && work.clinical_locked) bad("للبند عمل أو مسودة سريرية محفوظة؛ لا يُحذف ولا تتغيّر كميته. أبقِ هويته وصحّح المبلغ كتسوية مالية.","conflict");
      if (line && original.financialReviewRequired) bad("الرابط المالي لهذا العلاج يحتاج مراجعة قبل التصحيح؛ لم تتغيّر السجلات السريرية.","conflict");
    }
    if (before.schedule?.status === "active") {
      await writeDebtRepaymentInTransaction(client,{target:before.target,terms:{mode:"full",installments:[]},expectedVersion:before.repaymentVersion,
        expectedRemainingMinor:before.remainingMinor,cancel:true,reason,idempotencyKey:`invoice-revision:${hash}:old-terms`,session});
    }
    const result = await correctInvoiceInTransaction(client,{invoiceId,lines,reason,actor:session.username,actorRole:session.role},{discountMinor,amendments,...(changingCurrency?{currency}: {})});
    if (!result.ok) bad(result.message,result.reason === "not_found" ? "missing" : "conflict");
    // Require one exact inserted identity for every retained source line before
    // using the handoff. The pair set is internal, not part of the saved receipt.
    const retainedIds = new Set(lines.map(line => line.itemId));
    if (!Array.isArray(result.itemPairs) || result.itemPairs.length !== retainedIds.size
      || result.itemPairs.some(pair => !pair || !retainedIds.has(pair.originalItemId)
        || !Number.isSafeInteger(pair.correctedItemId) || pair.correctedItemId <= 0)
      || new Set(result.itemPairs.map(pair => pair.originalItemId)).size !== retainedIds.size
      || new Set(result.itemPairs.map(pair => pair.correctedItemId)).size !== retainedIds.size) {
      bad("رابط بنود التصحيح غير مكتمل؛ لم يُحفظ التصحيح.", "conflict");
    }
    if(!session.userId && labLinks.sources.length) bad("جلسة غير صالحة لربط وصفة المختبر.","unauthorized");
    if(session.userId) await aliasCorrectedInvoiceLabWorkInTransaction(client,{patientId:owner.patient_id,originalInvoiceId:invoiceId,correctedInvoiceId:result.correctedId,actorUserId:session.userId,itemPairs:result.itemPairs});
    const correctedItems = new Map(result.itemPairs.map(pair => [pair.originalItemId, pair.correctedItemId]));
    const { rows: [revision] } = await client.query<{ id: number }>(
      `INSERT INTO invoice_corrections(patient_id,currency,original_invoice_id,corrected_invoice_id,idempotency_key,request_hash,reason,created_by,original_currency)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [owner.patient_id,currency,invoiceId,result.correctedId,key,hash,reason,session.username,changingCurrency?before.invoice.baseCurrency:null]);
    const reclassificationId=currencyPlan?await writeInvoiceCurrencyEvidence(client,revision.id,owner.patient_id,currencyPlan.lineageInvoiceIds,
      {sourceCurrency:before.invoice.baseCurrency,targetCurrency:currency}):null;
    if(currencyPlan?.planIds.length)await client.query("UPDATE treatment_plans SET base_currency=$2 WHERE id=ANY($1::int[])",[currencyPlan.planIds,currency]);
    const affectedPlans = new Set<number>();
    for (const work of before.work) {
      const original = before.invoice.items.find(item=>item.planItemId===work.id)!;
      const line = lines.find(item=>item.itemId===original.id);
      if (line) {
        const identity=amendments.get(original.id);
        if(identity){
          await client.query("UPDATE plan_items SET service_id=$2,doctor_id=$3,service_name=$4,category=$5,tooth_code=$6,surfaces=$7 WHERE id=$1",
            [work.id,identity.serviceId,identity.doctorId,identity.description,identity.category,identity.toothCode,identity.surfaces]);
          // Financial identity correction may update the clinical site, never the
          // current care owner established through responsibility settings.
          if(work.case_id!==null)await client.query("UPDATE clinical_cases SET site=$2 WHERE id=$1",[work.case_id,identity.caseSite]);
        }
        await client.query("UPDATE plan_items SET quantity=$2,unit_price_minor=$3,billed_invoice_id=$4,billing_status='billed' WHERE id=$1",
          [work.id,line.quantity,line.unitPriceMinor,result.correctedId]);
        const mapped = await client.query(`INSERT INTO invoice_correction_lines(correction_id,original_item_id,corrected_item_id,plan_item_id,approved_work)
          SELECT $1,$2,ii.id,i.id,${INVOICE_APPROVED_WORK_SQL} FROM plan_items i JOIN invoice_items ii ON ii.plan_item_id=i.id
          WHERE i.id=$3 AND ii.invoice_id=$4 AND ii.id=$5`,[revision.id,original.id,work.id,result.correctedId,correctedItems.get(original.id)]);
        if (mapped.rowCount !== 1) bad("رابط بند العلاج لا يطابق بند الفاتورة المصححة؛ لم يُحفظ التصحيح.", "conflict");
      } else {
        await client.query("UPDATE plan_items SET status='cancelled' WHERE id=$1",[work.id]);
      }
      affectedPlans.add(work.plan_id);
    }
    for (const planId of affectedPlans) await recomputePlanTotal(client,planId);
    // Paid status follows actual immutable settlement, including original receipts.
    await client.query("UPDATE invoices SET status=$2 WHERE id=$1", [result.correctedId,remainingMinor === 0 ? "paid" : "open"]);
    const repayment = remainingMinor > 0 ? await writeDebtRepaymentInTransaction(client,{
      target:{...before.target,currency:currency as "YER"|"SAR"|"USD",invoiceId:result.correctedId},terms:terms.value,expectedVersion:0,expectedRemainingMinor:remainingMinor,
      reason,idempotencyKey:`invoice-revision:${hash}:new-terms`,session }) : null;
    const corrected = await getInvoice(result.correctedId,client), original = {...before.invoice,status:"cancelled" as const};
    const receipt = { ...(reclassificationId?{reclassificationId,originalCurrency:before.invoice.baseCurrency}:{}), original, corrected, patientId:owner.patient_id,currency,idempotencyKey:key,createdBy:session.username,
      beforeMinor:before.invoice.totalMinor-before.invoice.discountMinor,afterMinor:netMinor,settledMinor,remainingMinor,
      creditMinor:Math.max(0,settledMinor-netMinor),accountCreditMinor:Math.max(0,-afterDueMinor),accountDueMinor:afterDueMinor,repayment };
    await client.query("INSERT INTO invoice_correction_receipts(correction_id,receipt) VALUES($1,$2::jsonb)",[revision.id,JSON.stringify(receipt)]);
    await insertAuditRow(client,{action:"invoice.correct",entity:"invoice",entityId:invoiceId,actor:session.username,actorRole:session.role,
      details:{correctionId:revision.id,correctedInvoiceId:result.correctedId,reason,discountReason,settledMinor,remainingMinor,
        creditMinor:receipt.creditMinor,identityAmendments:[...amendments].map(([itemId,after])=>({itemId,before:before.invoice.items.find(item=>item.id===itemId),after})),repayment,receiptsPreserved:true,cashMovement:0,idempotencyKey:key}});
    await authority(client,session); await client.query("COMMIT"); return { ...receipt, replayed:false };
  } catch (error) { try{await client.query("ROLLBACK");}catch{destroy=true;} throw error; } finally { client.release(destroy); }
}
