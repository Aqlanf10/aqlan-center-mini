import type { SessionPayload } from './auth';
import { CLINIC_TIME_ZONE, ensureSchema, getPool, getSettingsInTransaction, insertAuditRow, type DbClient } from './db';
import { DebtRepaymentError } from './debt-installments-db';
import { debtRequestHash } from './debt-source-proof';
import { evaluateWrongCurrencyAmounts, type CurrencyCorrectionSource } from './invoice-currency-intent';
import { parseUnpaidCurrencyAcknowledgement, parseUnpaidCurrencyRequest, UNPAID_CURRENCY_KIND,
  type UnpaidCurrencyAcknowledgement } from './invoice-unpaid-currency-contract';
import { readUnpaidCurrencyTransitions } from './invoice-unpaid-currency-evidence';
import { requireCurrency } from './money';
import { clinicDateString } from './schedule';
import { revalidateSessionInTransaction } from './session';

const bad = (message: string, code: DebtRepaymentError['code']='conflict'): never => { throw new DebtRepaymentError(code,message); };
async function authority(client: DbClient, session: SessionPayload) {
  const current=await revalidateSessionInTransaction(session,client);
  if (!current || current.role!=='admin') bad('تصحيح العملة يحتاج جلسة مدير سارية.','unauthorized');
}
type SourceSnapshot = {
  invoice: { id: number; patient_id: number; invoice_number: string; base_currency: string; total_minor: number; discount_minor: number; created_at: string; status: string; note: string | null };
  items: Array<{id:number;quantity:number;unit_price_minor:number;doctor_id:number|null}>;
  created_at_exact: string;
};
async function sourceInTransaction(client: DbClient, invoiceId: number, patientId: number) {
  const {rows:[source]}=await client.query<SourceSnapshot>(`SELECT to_jsonb(i) AS invoice,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM invoice_items x WHERE x.invoice_id=i.id) AS items,
    to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_exact
    FROM invoices i WHERE i.id=$1`,[invoiceId]);
  if (!source || source.invoice.patient_id!==patientId) bad('الفاتورة غير موجودة لهذا المريض.','missing');
  if (source.invoice.status!=='open' || !source.items?.length || source.items.length>200
    || source.invoice.note && /(replac|correct|تصحيح|بديل)/i.test(source.invoice.note)) bad('يلزم أصل فاتورة مستقل بلا تصحيح سابق.');
  await client.query('SELECT u0_assert_empty($1)',[invoiceId]);
  const {rows:[past]}=await client.query<{present:boolean}>(`SELECT EXISTS(SELECT 1 FROM invoice_corrections WHERE original_invoice_id=$1 OR corrected_invoice_id=$1)
    OR EXISTS(SELECT 1 FROM invoice_settlement_reclassifications WHERE $1=ANY(source_invoice_ids))
    OR EXISTS(SELECT 1 FROM invoice_unpaid_currency_claims WHERE source_id=$1 OR target_id=$1) AS present`,[invoiceId]);
  if (past.present) bad('الفاتورة لها تصحيح أو دليل عملة سابق؛ هذا المسار للأصل فقط.');
  const sourceHash=debtRequestHash({purpose:'invoice-unpaid-currency-source-v1',invoice:source.invoice,items:source.items});
  const amounts: CurrencyCorrectionSource={patientId,invoiceId,sourceHash,currency:requireCurrency(source.invoice.base_currency,'فاتورة',invoiceId),
    totalMinor:source.invoice.total_minor,discountMinor:source.invoice.discount_minor,
    lines:source.items.map(i=>({itemId:i.id,quantity:i.quantity,unitPriceMinor:i.unit_price_minor}))};
  return {source,amounts,sourceHash};
}
async function periodAndCommission(client: DbClient, source: SourceSnapshot) {
  const settings=await getSettingsInTransaction(client);
  const date=clinicDateString(new Date(source.created_at_exact),CLINIC_TIME_ZONE);
  const {rows:[clock]}=await client.query<{now:string}>('SELECT clock_timestamp()::text AS now');
  const today=clinicDateString(new Date(clock.now),CLINIC_TIME_ZONE);
  const cutoff=settings['finance.locked_before']?.trim();
  if (cutoff && (date<cutoff || today<cutoff)) bad('الفاتورة أو تاريخ التصحيح في فترة مقفلة.');
  const doctors=[...new Set(source.items.flatMap(i=>i.doctor_id===null?[]:[i.doctor_id]))];
  if (doctors.length) {
    const {rows:[held]}=await client.query<{blocked:boolean}>(`SELECT EXISTS(SELECT 1 FROM expenses WHERE category='commission' AND party_id=ANY($1::int[]))
      OR EXISTS(SELECT 1 FROM hr_payroll_items WHERE status<>'reversed' AND commissions_minor<>0) AS blocked`,[doctors]);
    if (held.blocked) bad('توجد عمولات مصروفة أو معتمدة؛ يلزم تعديل عمولة صريح أولاً.');
  }
}
/** Candidate preview only; no endpoint imports it before complete integration.
 * The hash binds all stored source facts, but is never execution authority. */
export async function readUnpaidCurrencyCorrection(invoiceId: number, patientId: number, session: SessionPayload) {
  if (!Number.isSafeInteger(invoiceId)||invoiceId<=0||!Number.isSafeInteger(patientId)||patientId<=0) bad('هوية الفاتورة غير صالحة.','invalid');
  // Logically read-only, but PostgreSQL requires READ WRITE for the canonical
  // users FOR SHARE authority fence. Hold it from revalidation through COMMIT.
  // No schema initialization or source row locks belong in this preview.
  const client=await getPool().connect(); let destroy=false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE');
    await authority(client,session);
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const current=await sourceInTransaction(client,invoiceId,patientId); await periodAndCommission(client,current.source);
    await authority(client,session);
    await client.query('COMMIT'); return {evidenceKind:'unpaid_root_v1' as const,...current.amounts,sourceCreatedAt:current.source.created_at_exact};
  } catch(error) {try{await client.query('ROLLBACK');}catch{destroy=true;} throw error;} finally {client.release(destroy);}
}

/** Isolated atomic U0 path. Never calls the legacy correction helper: that
 * helper takes plan/clinical locks and intentionally has different semantics.
 * No plan, clinical, repayment, cash, receipt or historical FX mutation occurs.
 * Registration/HTTP/UI activation remains a separate reviewed integration gate. */
export async function correctUnpaidInvoiceCurrency(value: unknown, session: SessionPayload) {
  const request=parseUnpaidCurrencyRequest(value);
  if (session.role!=='admin') bad('تصحيح العملة للمدير وحده.','unauthorized');
  const requestHash=debtRequestHash({purpose:'invoice-unpaid-currency-command-v1',request,
    actor:{userId:session.userId,username:session.username,role:session.role}});
  const expected={request,requestHash,actorUserId:session.userId,createdBy:session.username};
  await ensureSchema(); const client=await getPool().connect(); let destroy=false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); await client.query("SET LOCAL TIME ZONE 'UTC'");
    await authority(client,session);
    // Serialize this exact new command, without acquiring an unrelated account
    // exclusive lock or reinterpreting an old v1 key/payload.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('invoice-unpaid-currency:'||$1,0))",[request.idempotencyKey]);
    const {rows:[prior]}=await client.query<{request_hash:string;currency_evidence_kind:string;receipt:unknown}>(`SELECT c.request_hash,c.currency_evidence_kind,r.receipt
      FROM invoice_corrections c LEFT JOIN invoice_correction_receipts r ON r.correction_id=c.id WHERE c.idempotency_key=$1`,[request.idempotencyKey]);
    if (prior) {
      if (prior.request_hash!==requestHash || prior.currency_evidence_kind!=='unpaid_root_v1') bad('مفتاح التصحيح مستخدم بطلب آخر.');
      const acknowledgement=parseUnpaidCurrencyAcknowledgement(prior.receipt,expected);
      const documents=await readUnpaidCurrencyTransitions(client,[request.patientId]);
      if (!documents.some(d=>d.correctionId===acknowledgement.correctionId)) bad('دليل التصحيح غير مكتمل.');
      await authority(client,session); await client.query('COMMIT'); return {acknowledgement,replayed:true};
    }
    // Preserve existing global commission/shift order, but do not take the
    // old broad patient NO KEY UPDATE/account/schedule or plan/visit locks.
    await client.query('LOCK TABLE expenses,hr_payroll_runs,hr_payroll_items IN SHARE MODE');
    await client.query('SELECT id FROM patients WHERE id=$1 FOR KEY SHARE',[request.patientId]);
    await client.query("SELECT id FROM cashier_shifts WHERE status='open' ORDER BY id FOR UPDATE");
    await client.query('LOCK TABLE settings IN SHARE MODE');
    await client.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE',[request.invoiceId]);
    const current=await sourceInTransaction(client,request.invoiceId,request.patientId);
    if (current.sourceHash!==request.expectedSourceHash) bad('تغيرت الفاتورة؛ حدّث المعاينة قبل طلب جديد.','stale');
    await periodAndCommission(client,current.source);
    const amounts=evaluateWrongCurrencyAmounts(current.amounts,request.intent);
    if (amounts.targetDiscountMinor>0 && request.discountReason.trim().length<3) bad('اكتب سبب الخصم.','invalid');
    const intent={mode:amounts.mode,lines:amounts.lines.map(i=>({itemId:i.itemId,unitPriceMinor:String(i.targetUnitPriceMinor)})),discountMinor:String(amounts.targetDiscountMinor)};
    const {rows:[issued]}=await client.query<{target_id:number;target_snapshot:SourceSnapshot['invoice'];item_pairs:Array<{original:number;corrected:number}>;effective_at:string}>(`INSERT INTO invoice_unpaid_currency_claims(
      source_id,target_currency,intent,source_snapshot,item_snapshot,action_at,transaction_id,created_by,reason,target_id,target_snapshot,target_items,item_pairs)
      VALUES($1,$2,$3,'{}','[]',clock_timestamp(),pg_current_xact_id(),$4,$5,0,'{}','[]','[]')
      RETURNING target_id,target_snapshot,item_pairs,to_char(action_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS effective_at`,
      [request.invoiceId,amounts.toCurrency,JSON.stringify(intent),session.username,amounts.reason]);
    await client.query("UPDATE invoices SET status='cancelled' WHERE id=$1",[request.invoiceId]);
    const {rows:[correction]}=await client.query<{id:number}>(`INSERT INTO invoice_corrections(patient_id,currency,original_currency,original_invoice_id,corrected_invoice_id,
      idempotency_key,request_hash,reason,created_by,created_at,currency_evidence_kind)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unpaid_root_v1') RETURNING id`,
      [request.patientId,amounts.toCurrency,amounts.fromCurrency,request.invoiceId,issued.target_id,request.idempotencyKey,requestHash,amounts.reason,session.username,issued.effective_at]);
    for (const pair of issued.item_pairs) await client.query(`INSERT INTO invoice_correction_lines(correction_id,original_item_id,corrected_item_id,approved_work)
      VALUES($1,$2,$3,'{}')`,[correction.id,pair.original,pair.corrected]);
    const acknowledgement:UnpaidCurrencyAcknowledgement={version:1,kind:UNPAID_CURRENCY_KIND,evidenceKind:'unpaid_root_v1',correctionId:correction.id,
      patientId:request.patientId,currency:amounts.toCurrency,originalCurrency:amounts.fromCurrency,idempotencyKey:request.idempotencyKey,requestHash,
      createdBy:session.username,actorUserId:session.userId,effectiveAt:issued.effective_at,amountMode:amounts.mode,settledMinor:0,
      sourcePrincipalMinor:amounts.sourceNetMinor,targetPrincipalMinor:amounts.targetNetMinor,
      original:{id:request.invoiceId,patientId:request.patientId,baseCurrency:amounts.fromCurrency,invoiceNumber:current.source.invoice.invoice_number,createdAt:current.source.created_at_exact},
      corrected:{id:issued.target_id,patientId:request.patientId,baseCurrency:amounts.toCurrency,invoiceNumber:issued.target_snapshot.invoice_number,createdAt:issued.effective_at}};
    parseUnpaidCurrencyAcknowledgement(acknowledgement,expected);
    await client.query('INSERT INTO invoice_correction_receipts(correction_id,receipt) VALUES($1,$2)',[correction.id,JSON.stringify(acknowledgement)]);
    await client.query(`INSERT INTO invoice_unpaid_currency_transitions(correction_id,source_id,target_id,target_snapshot,target_items)
      VALUES($1,$2,$3,'{}','[]')`,[correction.id,request.invoiceId,issued.target_id]);
    await insertAuditRow(client,{action:'invoice.correct',entity:'invoice',entityId:request.invoiceId,entityLabel:current.source.invoice.invoice_number,
      actor:session.username,actorRole:session.role,details:{kind:UNPAID_CURRENCY_KIND,evidenceKind:'unpaid_root_v1',correctionId:correction.id,
        replacementId:issued.target_id,sourceCurrency:amounts.fromCurrency,targetCurrency:amounts.toCurrency,amountMode:amounts.mode,
        sourcePrincipalMinor:amounts.sourceNetMinor,targetPrincipalMinor:amounts.targetNetMinor,settledMinor:0,
        reason:amounts.reason,discountReason:request.discountReason,effectiveAt:issued.effective_at}});
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    const documents=await readUnpaidCurrencyTransitions(client,[request.patientId]);
    if (!documents.some(d=>d.correctionId===correction.id)) bad('تعذر التحقق من دليل تصحيح العملة.');
    await authority(client,session); await client.query('COMMIT'); return {acknowledgement,replayed:false};
  } catch(error) {try{await client.query('ROLLBACK');}catch{destroy=true;} throw error;} finally {client.release(destroy);}
}
