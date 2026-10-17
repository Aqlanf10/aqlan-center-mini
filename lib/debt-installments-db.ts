import {debtRequestHash,debtRevisionSourceMatches} from "./debt-source-proof";
export {debtRequestHash} from "./debt-source-proof";
import { ensureSchema, getPool, insertAuditRow, type DbClient } from "./db";
import type { SessionPayload } from "./auth";
import { revalidateSessionInTransaction } from "./session";
import { requireCurrency, settlePaymentMinor, type Currency } from "./money";
import { debtInstallmentProgress, validateDebtRepaymentTerms, type DebtRepaymentTerms } from "./debt-installments";
import { debtAccountDue, lockDebtAccountForSchedule } from "./debt-account-position";
import {readInvoiceSettlementPosition,InvoiceSettlementError} from "./invoice-settlement-position";

export type DebtTarget = { patientId: number; currency: Currency; invoiceId: number | null; openingCurrency: Currency | null };
export class DebtRepaymentError extends Error {
  constructor(readonly code: "invalid" | "stale" | "conflict" | "unauthorized" | "missing", message: string) { super(message); }
}
const safe = (value: string | number) => { const number = Number(value); if (!Number.isSafeInteger(number)) throw new DebtRepaymentError("invalid","المبلغ خارج النطاق الآمن."); return number; };

export async function assertDebtSession(client: DbClient, session: SessionPayload): Promise<void> {
  const current = await revalidateSessionInTransaction(session,client);
  if (!current || !["admin","reception"].includes(current.role)) throw new DebtRepaymentError("unauthorized","انتهت الجلسة أو تغيّرت صلاحية إدارة الاتفاق؛ سجّل الدخول من جديد.");
}
export function validDebtTarget(target: DebtTarget): boolean {
  return Number.isSafeInteger(target.patientId) && target.patientId > 0
    && ["YER","SAR","USD"].includes(target.currency)
    && (target.invoiceId !== null ? Number.isSafeInteger(target.invoiceId) && target.invoiceId > 0 && target.openingCurrency === null
      : target.openingCurrency === target.currency);
}

/** Writer callers lock this exact target after their earlier canonical locks.
 * Plain readers use a repeatable-read snapshot; no payment is inferred from debt. */
export async function readDebtPosition(client: DbClient, target: DebtTarget, lock = false) {
  if (!validDebtTarget(target)) throw new DebtRepaymentError("invalid","اختر فاتورة أو رصيدًا سابقًا واحدًا بعملته.");
  let snapshot: Record<string, unknown>; let principal: number; let available = true;
  if (target.invoiceId !== null) {
    let position;
    try{position=await readInvoiceSettlementPosition(client,{patientId:target.patientId,invoiceId:target.invoiceId,currency:target.currency},lock);}
    catch(error){if(error instanceof InvoiceSettlementError)throw new DebtRepaymentError(error.code,error.message);throw error;}
    return {...target,principalMinor:position.principalMinor,settledMinor:position.settledMinor,remainingMinor:position.remainingMinor,available:position.available,
      settlementProofHash:position.proofHash,sourceSnapshot:position.sourceSnapshot,sourceHash:debtRequestHash(position.sourceSnapshot)};
  } else {
    const { rows: [row] } = await client.query<{ amount_minor: string; as_of_date: string; updated_at: string }>(
      `SELECT amount_minor::text,as_of_date::text,updated_at::text FROM patient_opening_balances WHERE patient_id=$1 AND currency=$2 ${lock ? "FOR NO KEY UPDATE" : ""}`,[target.patientId,target.currency]);
    available = Boolean(row); principal = row ? safe(row.amount_minor) : 0;
    snapshot = { patientId:target.patientId,currency:target.currency,opening:row ?? null };
  }
  const { rows: payments } = await client.query<{ id: number; patient_id: number; amount_minor: string; base_amount_minor: string; currency: string; kind: string }>(
    "SELECT id,patient_id,amount_minor::text,base_amount_minor::text,currency,kind FROM payments WHERE patient_id=$1 AND opening_currency=$2 ORDER BY id",[target.patientId,target.currency]);
  let settledMinor = 0;
  for (const payment of payments) {
    if (payment.patient_id !== target.patientId || !["payment","refund"].includes(payment.kind)) throw new DebtRepaymentError("invalid","ربط السند يحتاج مراجعة مالية.");
    settledMinor = safe(settledMinor + (payment.kind === "refund" ? -1 : 1)*settlePaymentMinor({ id:payment.id,amountMinor:safe(payment.amount_minor),baseAmountMinor:safe(payment.base_amount_minor),currency:requireCurrency(payment.currency,"سند الاتفاق",payment.id) },target.currency));
  }
  return { ...target,principalMinor:principal,settledMinor,remainingMinor:Math.max(0,principal-settledMinor),available,settlementProofHash:undefined,sourceSnapshot:snapshot,sourceHash:debtRequestHash(snapshot) };
}

type Revision = { id: number; arrangement_id: number; version: number; status: "active" | "cancelled";
  principal_minor: string; settled_snapshot_minor: string; source_snapshot: Record<string,unknown>; terms: DebtRepaymentTerms;
  reason: string; idempotency_key: string; request_hash: string; created_by: string; created_at: Date };
const latestRevision = async (client: DbClient, id: number) => (await client.query<Revision>(
  "SELECT * FROM debt_repayment_revisions WHERE arrangement_id=$1 ORDER BY version DESC LIMIT 1",[id])).rows[0];

export type DebtRepaymentWrite = { target: DebtTarget; terms: unknown; expectedVersion: number; expectedRemainingMinor: number;
  expectedSourceHash?: string; reason: string; idempotencyKey: string; cancel?: boolean; session: SessionPayload };

/** Caller owns BEGIN/COMMIT. Target lock precedes arrangement/version locks.
 * New invoice/historical composition may omit expectedSourceHash because it owns
 * the newly posted debt in this transaction; standalone HTTP edits must supply it. */
export async function writeDebtRepaymentInTransaction(client: DbClient, input: DebtRepaymentWrite) {
  await assertDebtSession(client,input.session);
  if (!validDebtTarget(input.target) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
    || !Number.isSafeInteger(input.expectedRemainingMinor) || input.expectedRemainingMinor < 0
    || !/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey) || input.reason.trim().length < 3 || input.reason.trim().length > 300)
    throw new DebtRepaymentError("invalid","بيانات ترتيب السداد غير صالحة؛ راجع السبب والمبلغ والنسخة.");
  const hash = debtRequestHash({ ...input,session:{ id:input.session.userId,username:input.session.username,role:input.session.role } });
  const replay = async () => {
    const { rows: [prior] } = await client.query<Revision>("SELECT * FROM debt_repayment_revisions WHERE idempotency_key=$1",[input.idempotencyKey]);
    if (!prior) return null;
    if (prior.request_hash !== hash || prior.created_by !== input.session.username) throw new DebtRepaymentError("conflict","مفتاح الإعادة مستعمل بترتيب مختلف.");
    await assertDebtSession(client,input.session);
    return { arrangementId:prior.arrangement_id,version:prior.version,revisionId:prior.id,replayed:true,
      receipt:{target:input.target,terms:prior.terms,status:prior.status,idempotencyKey:prior.idempotency_key,createdBy:prior.created_by} };
  };
  const previous = await replay(); if (previous) return previous;
  const position = await readDebtPosition(client,input.target,true);
  const afterWait = await replay(); if (afterWait) return afterWait;
  if (!input.cancel && !position.available) throw new DebtRepaymentError("missing","مصدر الدين ملغى أو غير موجود؛ لا يمكن جدولة تحصيله.");
  if (!input.cancel && position.remainingMinor > Math.max(0,(await debtAccountDue(client,input.target.patientId,input.target.currency)).due))
    throw new DebtRepaymentError("stale","متبقي المصدر أكبر من المستحق الفعلي للحساب بسبب تسويات أخرى؛ راجع تخصيص السندات قبل جدولة التحصيل.");
  if (position.remainingMinor !== input.expectedRemainingMinor || input.expectedSourceHash && input.expectedSourceHash !== position.sourceHash)
    throw new DebtRepaymentError("stale","تغيّر الدين أو تحصيله؛ حدّث الحساب وأعد توزيع المتبقي.");
  const { rows: existing } = await client.query<{ id: number }>(`SELECT id FROM debt_repayment_arrangements WHERE patient_id=$1
    AND invoice_id IS NOT DISTINCT FROM $2 AND opening_currency IS NOT DISTINCT FROM $3 FOR UPDATE`,[input.target.patientId,input.target.invoiceId,input.target.openingCurrency]);
  let id = existing[0]?.id;
  const current = id ? await latestRevision(client,id) : undefined;
  if ((current?.version ?? 0) !== input.expectedVersion || input.cancel && !current) throw new DebtRepaymentError("stale","تغيّر جدول السداد؛ افتح النسخة الحالية قبل التعديل.");
  const terms = validateDebtRepaymentTerms(input.cancel ? { mode:"full",installments:[] } : input.terms,position.remainingMinor);
  if (!terms.ok) throw new DebtRepaymentError("invalid",terms.message);
  if (!input.cancel && input.target.openingCurrency !== null && (await client.query("SELECT id FROM legacy_balance_arrangements WHERE patient_id=$1 AND currency=$2 AND cancelled_at IS NULL",[input.target.patientId,input.target.currency])).rows.length)
    throw new DebtRepaymentError("conflict","يوجد ترتيب سابق لهذا الرصيد؛ ألغِه بعد المراجعة قبل إنشاء جدول جديد.");
  if (!id) {
    // Opening buckets with an older active recurring arrangement cannot acquire
    // a competing schedule silently. Cancel that arrangement explicitly first.
    id = (await client.query<{ id: number }>(`INSERT INTO debt_repayment_arrangements(patient_id,currency,invoice_id,opening_currency,created_by)
      VALUES($1,$2,$3,$4,$5) RETURNING id`,[input.target.patientId,input.target.currency,input.target.invoiceId,input.target.openingCurrency,input.session.username])).rows[0].id;
  }
  const { rows: [revision] } = await client.query<{ id: number; version: number }>(`INSERT INTO debt_repayment_revisions
    (arrangement_id,version,status,principal_minor,settled_snapshot_minor,source_snapshot,terms,reason,idempotency_key,request_hash,created_by)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11) RETURNING id,version`,
    [id,(current?.version ?? 0)+1,input.cancel ? "cancelled" : "active",position.remainingMinor,position.settledMinor,JSON.stringify(position.sourceSnapshot),JSON.stringify(terms.value),input.reason.trim(),input.idempotencyKey,hash,input.session.username]);
  await insertAuditRow(client,{ action:input.cancel ? "debt_repayment.cancel" : current ? "debt_repayment.revise" : "debt_repayment.create",entity:"patient",entityId:input.target.patientId,
    actor:input.session.username,actorRole:input.session.role,details:{ arrangementId:id,revisionId:revision.id,version:revision.version,target:input.target,remainingMinor:position.remainingMinor,terms:terms.value,reason:input.reason.trim() } });
  await assertDebtSession(client,input.session);
  return { arrangementId:id,version:revision.version,revisionId:revision.id,replayed:false,
    receipt:{target:input.target,terms:terms.value,status:input.cancel ? "cancelled" : "active",idempotencyKey:input.idempotencyKey,createdBy:input.session.username} };
}

export async function saveDebtRepayment(input: DebtRepaymentWrite) {
  await ensureSchema(); const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Serializes creation of an absent target reference and follows invoice management order.
    await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE",[input.target.patientId]);
    await lockDebtAccountForSchedule(client,input.target.patientId);
    const result = await writeDebtRepaymentInTransaction(client,input); await client.query("COMMIT"); return result;
  } catch(error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function readDebtRepayments(client: DbClient, patientId: number, today: string) {
  const { rows } = await client.query<{ id: number; currency: Currency; invoice_id: number | null; opening_currency: Currency | null }>("SELECT * FROM debt_repayment_arrangements WHERE patient_id=$1 ORDER BY id",[patientId]);
  const result = [];
  for (const row of rows) {
    const revision = await latestRevision(client,row.id); if (!revision) throw new DebtRepaymentError("invalid","ترتيب سداد بلا نسخة موثقة.");
    const position = await readDebtPosition(client,{ patientId,currency:row.currency,invoiceId:row.invoice_id,openingCurrency:row.opening_currency });
    const accountDueMinor=(await debtAccountDue(client,patientId,row.currency)).due;
    const progress = revision.terms.mode === "installments" ? debtInstallmentProgress({ principalMinor:safe(revision.principal_minor),currentRemainingMinor:position.remainingMinor,
      netSettledSinceRevisionMinor:safe(position.settledMinor-safe(revision.settled_snapshot_minor)),installments:revision.terms.installments,today }) : null;
    const { rows: history } = await client.query("SELECT version,status,terms,principal_minor::text,reason,created_by,created_at::text FROM debt_repayment_revisions WHERE arrangement_id=$1 ORDER BY version",[row.id]);
    result.push({ id:row.id,target:{ patientId,currency:row.currency,invoiceId:row.invoice_id,openingCurrency:row.opening_currency },version:revision.version,status:revision.status,
      terms:revision.terms,remainingMinor:position.remainingMinor,collectedMinor:position.settledMinor,principalMinor:position.principalMinor,sourceHash:position.sourceHash,
      revisionPrincipalMinor:safe(revision.principal_minor),available:position.available,
      accountDueMinor,collectibleMinor:Math.max(0,Math.min(position.remainingMinor,accountDueMinor)),
      requiresReview:!position.available || position.remainingMinor>Math.max(0,accountDueMinor) || !debtRevisionSourceMatches(position.sourceSnapshot,revision.source_snapshot) || Boolean(progress?.requiresRevision),progress,history });
  }
  return result;
}
/** Includes unscheduled existing debt so arranging payment never needs a new bill. */
export async function debtRepaymentWorkspace(patientId:number,today:string) {
  await ensureSchema();const client=await getPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const arrangements=await readDebtRepayments(client,patientId,today);
    const invoices=(await client.query<{id:number;invoice_number:string;base_currency:string}>("SELECT id,invoice_number,base_currency FROM invoices WHERE patient_id=$1 AND status<>'cancelled' ORDER BY id",[patientId])).rows;
    const openings=(await client.query<{currency:string}>("SELECT currency FROM patient_opening_balances WHERE patient_id=$1 ORDER BY currency",[patientId])).rows;
    const targets=[];
    for (const target of [
      ...invoices.map(row=>({patientId,currency:requireCurrency(row.base_currency,"فاتورة",row.id),invoiceId:row.id,openingCurrency:null,label:`فاتورة ${row.invoice_number}`})),
      ...openings.map(row=>({patientId,currency:requireCurrency(row.currency,"رصيد",patientId),invoiceId:null,openingCurrency:requireCurrency(row.currency,"رصيد",patientId),label:`رصيد سابق ${row.currency}`})),
    ]) {
      const position=await readDebtPosition(client,target);
      const existing=arrangements.find(row=>row.target.invoiceId===target.invoiceId&&row.target.openingCurrency===target.openingCurrency);
      const accountDueMinor=(await debtAccountDue(client,patientId,target.currency)).due;
      const legacyActive=target.openingCurrency!==null&&(await client.query("SELECT id FROM legacy_balance_arrangements WHERE patient_id=$1 AND currency=$2 AND cancelled_at IS NULL",[patientId,target.currency])).rows.length>0;
      if(position.remainingMinor>0||existing)targets.push({target:{patientId:target.patientId,currency:target.currency,invoiceId:target.invoiceId,openingCurrency:target.openingCurrency},label:target.label,
        remainingMinor:position.remainingMinor,collectedMinor:position.settledMinor,principalMinor:position.principalMinor,sourceHash:position.sourceHash,accountDueMinor,legacyActive,
        arrangementId:existing?.id??null,version:existing?.version??0});
    }
    await client.query("COMMIT");return {arrangements,targets};
  } catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
}
export async function listDebtRepayments(patientId: number, today: string) {
  await ensureSchema(); const client=await getPool().connect();
  try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); const result=await readDebtRepayments(client,patientId,today); await client.query("COMMIT"); return result; }
  catch(error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

/** Original immutable terms, even if a later revision/cancellation exists. */
export async function invoiceDebtRepaymentReceipt(patientId:number,invoiceId:number) {
  const {rows:[row]}=await getPool().query<{id:number;arrangement_id:number;version:number;terms:DebtRepaymentTerms}>(
    `SELECT r.id,r.arrangement_id,r.version,r.terms FROM debt_repayment_revisions r
     JOIN debt_repayment_arrangements a ON a.id=r.arrangement_id
     WHERE a.patient_id=$1 AND a.invoice_id=$2 AND r.idempotency_key=$3`,[patientId,invoiceId,`invoice:${invoiceId}:repayment`]);
  return row ? {arrangementId:row.arrangement_id,revisionId:row.id,version:row.version,terms:row.terms} : null;
}
