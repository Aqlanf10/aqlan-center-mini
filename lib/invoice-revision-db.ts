import type { SessionPayload } from "./auth";
import { CLINIC_TIME_ZONE, correctInvoiceInTransaction, ensureSchema, getInvoice, getPool, getSettingsInTransaction,
  insertAuditRow, lockPlanItemsBilledBy, recomputePlanTotal, type DbClient } from "./db";
import { debtAccountDue, lockDebtAccountForSchedule } from "./debt-account-position";
import { DebtRepaymentError, debtRequestHash, readDebtPosition, writeDebtRepaymentInTransaction } from "./debt-installments-db";
import { validateDebtRepaymentTerms } from "./debt-installments";
import { planInvoiceRevision } from "./invoice-correction";
import { parseAmount } from "./money";
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
        OR EXISTS (SELECT 1 FROM visits v WHERE v.case_id=i.case_id)) AS clinical_locked,
      EXISTS (SELECT 1 FROM legacy_treatment_agreements a WHERE a.plan_item_id=i.id) AS legacy
     FROM plan_items i LEFT JOIN clinical_cases c ON c.id=i.case_id
     WHERE i.id IN (SELECT plan_item_id FROM invoice_items WHERE invoice_id=$1) ORDER BY i.id`, [invoiceId]);
  const { rows: [schedule] } = await client.query<{ id: number; version: number; status: string; terms: unknown }>(
    `SELECT a.id,r.version,r.status,r.terms FROM debt_repayment_arrangements a JOIN LATERAL
      (SELECT version,status,terms FROM debt_repayment_revisions WHERE arrangement_id=a.id ORDER BY version DESC LIMIT 1) r ON TRUE
      WHERE a.patient_id=$1 AND a.invoice_id=$2`, [invoice.patientId,invoice.id]);
  const accountDueMinor = (await debtAccountDue(client,invoice.patientId,invoice.baseCurrency)).due;
  const facts = { invoice, work, settledMinor: position.settledMinor, remainingMinor: position.remainingMinor,
    accountDueMinor,settlementProofHash:position.settlementProofHash, repaymentVersion: schedule?.version ?? 0, repaymentTerms: schedule?.status === "active" ? schedule.terms : { mode: "full", installments: [] } };
  return { ...facts, sourceHash: debtRequestHash(facts), schedule, target };
}

export async function readInvoiceRevision(invoiceId: number, session: SessionPayload) {
  await ensureSchema(); const client = await getPool().connect();
  try {
    // Current authority is checked before the strictly read-only snapshot.
    await authority(client,session); await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await contextInTx(client,invoiceId); await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

/** One transaction owns replacement, settlement lineage, dated repayment terms
 * and the exact immutable acknowledgement. It creates no payment or refund. */
export async function reviseInvoice(invoiceId: number, source: Record<string, unknown>, session: SessionPayload) {
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0 || session.role !== "admin") bad("تصحيح الفاتورة للمدير وحده.", "unauthorized");
  if (Object.keys(source).some(key => !["idempotencyKey","expectedSourceHash","reason","lines","discount","discountReason","repaymentTerms","expectedRemainingMinor"].includes(key))) bad("حقول التصحيح غير مدعومة.");
  if (typeof source.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(source.idempotencyKey)
    || typeof source.expectedSourceHash !== "string" || !/^[a-f0-9]{64}$/.test(source.expectedSourceHash)
    || typeof source.reason !== "string" || source.reason.trim().length < 3 || source.reason.trim().length > 300) bad("راجع مفتاح الطلب والنسخة وسبب التصحيح.");
  const reason = source.reason.trim(), key = source.idempotencyKey;
  const hash = debtRequestHash({ purpose: "invoice-revision-v1", invoiceId, source, actor: { userId: session.userId, username: session.username, role: session.role } });
  await ensureSchema(); const client = await getPool().connect();
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
    await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [owner.patient_id]);
    // Cash writers take shift before invoice/plan locks. We never take a receipt
    // row lock or alter a closed shift; existing cash remains immutable.
    await client.query("SELECT id FROM cashier_shifts WHERE status='open' ORDER BY id FOR UPDATE");
    await lockPlanItemsBilledBy(client,invoiceId);
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
    const lines = source.lines.map(line => {
      if (Object.keys(line).some(key => !["itemId","quantity","unitPrice"].includes(key))) bad("حقول بند التصحيح غير مدعومة.");
      const unitPriceMinor = typeof line.unitPrice === "string" ? parseAmount(line.unitPrice,before.invoice.baseCurrency) : null;
      if (unitPriceMinor === null || typeof line.itemId !== "number" || typeof line.quantity !== "number") bad("السعر والكمية وهوية البند مطلوبة.");
      return { itemId: line.itemId, quantity: line.quantity, unitPriceMinor };
    });
    const discountMinor = typeof source.discount === "string" ? parseAmount(source.discount,before.invoice.baseCurrency) : null;
    if (discountMinor === null) bad("الخصم غير صالح.");
    const discountReason = typeof source.discountReason === "string" ? source.discountReason.trim() : "";
    if (discountMinor > 0 && (discountReason.length < 3 || discountReason.length > 300)) bad("اكتب سبب الخصم.");
    const planned = planInvoiceRevision(before.invoice.items,lines,discountMinor); if (!planned.ok) bad(planned.message);
    const netMinor = planned.totalMinor - planned.discountMinor;
    const remainingMinor = Math.max(0,netMinor-before.settledMinor);
    const terms = validateDebtRepaymentTerms(source.repaymentTerms,remainingMinor); if (!terms.ok) bad(terms.message);
    if (source.expectedRemainingMinor !== remainingMinor) bad("توزيع الأقساط لا يطابق المتبقي بعد التصحيح.", "stale");
    const afterDueMinor = before.accountDueMinor + netMinor - (before.invoice.totalMinor-before.invoice.discountMinor);
    if (remainingMinor > Math.max(0,afterDueMinor)) bad("توجد تسويات أخرى على الحساب؛ راجع تخصيص السندات قبل جدولة تحصيل إضافي.", "conflict");
    for (const work of before.work) {
      const original = before.invoice.items.find(item=>item.planItemId===work.id);
      if (!original || work.legacy) bad("البند مرتبط باتفاق تاريخي؛ صحّح وثيقته التاريخية من مسارها.","conflict");
      const line = lines.find(item=>item.itemId===original.id);
      if ((!line || line.quantity !== work.quantity) && work.clinical_locked) bad("للبند عمل أو مسودة سريرية محفوظة؛ لا يُحذف ولا تتغيّر كميته. أبقِ هويته وصحّح المبلغ كتسوية مالية.","conflict");
      if (line && original.financialReviewRequired) bad("الرابط المالي لهذا العلاج يحتاج مراجعة قبل التصحيح؛ لم تتغيّر السجلات السريرية.","conflict");
    }
    if (before.schedule?.status === "active") {
      await writeDebtRepaymentInTransaction(client,{target:before.target,terms:{mode:"full",installments:[]},expectedVersion:before.repaymentVersion,
        expectedRemainingMinor:before.remainingMinor,cancel:true,reason,idempotencyKey:`invoice-revision:${hash}:old-terms`,session});
    }
    const result = await correctInvoiceInTransaction(client,{invoiceId,lines,reason,actor:session.username,actorRole:session.role},{discountMinor});
    if (!result.ok) bad(result.message,result.reason === "not_found" ? "missing" : "conflict");
    const { rows: [revision] } = await client.query<{ id: number }>(
      `INSERT INTO invoice_corrections(patient_id,currency,original_invoice_id,corrected_invoice_id,idempotency_key,request_hash,reason,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [owner.patient_id,before.invoice.baseCurrency,invoiceId,result.correctedId,key,hash,reason,session.username]);
    const affectedPlans = new Set<number>();
    for (const work of before.work) {
      const original = before.invoice.items.find(item=>item.planItemId===work.id)!;
      const line = lines.find(item=>item.itemId===original.id);
      if (line) {
        await client.query("UPDATE plan_items SET quantity=$2,unit_price_minor=$3,billed_invoice_id=$4,billing_status='billed' WHERE id=$1",
          [work.id,line.quantity,line.unitPriceMinor,result.correctedId]);
        await client.query(`INSERT INTO invoice_correction_lines(correction_id,original_item_id,corrected_item_id,plan_item_id,approved_work)
          SELECT $1,$2,ii.id,i.id,${INVOICE_APPROVED_WORK_SQL} FROM plan_items i JOIN invoice_items ii ON ii.plan_item_id=i.id
          WHERE i.id=$3 AND ii.invoice_id=$4`,[revision.id,original.id,work.id,result.correctedId]);
      } else {
        await client.query("UPDATE plan_items SET status='cancelled' WHERE id=$1",[work.id]);
      }
      affectedPlans.add(work.plan_id);
    }
    for (const planId of affectedPlans) await recomputePlanTotal(client,planId);
    // Paid status follows actual immutable settlement, including original receipts.
    await client.query("UPDATE invoices SET status=$2 WHERE id=$1", [result.correctedId,remainingMinor === 0 ? "paid" : "open"]);
    const repayment = remainingMinor > 0 ? await writeDebtRepaymentInTransaction(client,{
      target:{...before.target,invoiceId:result.correctedId},terms:terms.value,expectedVersion:0,expectedRemainingMinor:remainingMinor,
      reason,idempotencyKey:`invoice-revision:${hash}:new-terms`,session }) : null;
    const corrected = await getInvoice(result.correctedId,client), original = await getInvoice(invoiceId,client);
    const receipt = { original, corrected, patientId:owner.patient_id,currency:before.invoice.baseCurrency,idempotencyKey:key,createdBy:session.username,
      beforeMinor:before.invoice.totalMinor-before.invoice.discountMinor,afterMinor:netMinor,settledMinor:before.settledMinor,remainingMinor,
      creditMinor:Math.max(0,before.settledMinor-netMinor),accountCreditMinor:Math.max(0,-afterDueMinor),accountDueMinor:afterDueMinor,repayment };
    await client.query("INSERT INTO invoice_correction_receipts(correction_id,receipt) VALUES($1,$2::jsonb)",[revision.id,JSON.stringify(receipt)]);
    await insertAuditRow(client,{action:"invoice.correct",entity:"invoice",entityId:invoiceId,actor:session.username,actorRole:session.role,
      details:{correctionId:revision.id,correctedInvoiceId:result.correctedId,reason,discountReason,settledMinor:before.settledMinor,remainingMinor,
        creditMinor:receipt.creditMinor,repayment,receiptsPreserved:true,cashMovement:0,idempotencyKey:key}});
    await authority(client,session); await client.query("COMMIT"); return { ...receipt, replayed:false };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}
