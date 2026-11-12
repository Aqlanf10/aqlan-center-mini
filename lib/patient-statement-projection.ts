import type { Invoice, OpeningBalance, Payment } from "./db";
import { CURRENCIES, invoiceNet, patientBalancesByCurrency, settlePaymentMinor, settlementTargetCurrency, toCurrencyPaymentLikes, type Balance, type Currency, type DocumentCurrencyRef } from "./money";
import { clinicDateString } from "./schedule";
import { resolveClinicZone } from "./clinicZone";

const STATEMENT_TIME_ZONE = resolveClinicZone(process.env.CLINIC_TIME_ZONE);

/** Read-only evidence. None of these identifiers or audit fields leave this projection. */
export interface StatementEvidence {
  invoiceCorrections: { originalInvoiceId: number; correctedInvoiceId: number; createdAt: string }[];
  invoiceCancellations: { invoiceId: number; createdAt: string }[];
  paymentCorrections: { originalId: number; reversalId: number; replacementId: number | null; createdAt: string }[];
  openingHistory: { id: number; currency: Currency; beforeAmountMinor: number | null; beforeAsOfDate: string | null; afterAmountMinor: number | null; afterAsOfDate: string | null; createdAt: string }[];
  allocationEffectiveAt: Record<number, string>;
}
export const emptyStatementEvidence = (): StatementEvidence => ({ invoiceCorrections: [], invoiceCancellations: [], paymentCorrections: [], openingHistory: [], allocationEffectiveAt: {} });
export const EMPTY_STATEMENT_EVIDENCE: StatementEvidence = emptyStatementEvidence();
export interface StatementProjectionInput {
  patientId: number;
  ledger: { invoices: readonly Invoice[]; payments: readonly Payment[]; openings: readonly OpeningBalance[] };
  planCurrencies: ReadonlyMap<number, DocumentCurrencyRef>;
  evidence: StatementEvidence;
}
export class StatementProjectionError extends Error {
  constructor() { super("تعذّر التحقق من تفاصيل كشف الحساب. يلزم مراجعة البيانات قبل إصدار الكشف."); this.name = "StatementProjectionError"; }
}
export interface StatementInvoiceLine { description: string; quantity: number; unitPriceMinor: number; totalMinor: number; toothCode: number | null; surfaces: string | null }
export interface StatementInvoice {
  invoiceNumber: string; createdAt: string; totalMinor: number; discountMinor: number; netMinor: number;
  status: "open" | "paid"; baseCurrency: Currency; items: StatementInvoiceLine[];
}
export interface StatementPayment {
  receiptNumber: string; createdAt: string; amountMinor: number; currency: Currency; kind: "payment" | "refund"; label: string;
  baseAmountMinor: number; settlementMinor: number; settlementCurrency: Currency;
}
export interface StatementMovement { date: string; currency: Currency; description: string; debitMinor: number; creditMinor: number; balanceMinor: number }
export interface PatientStatementProjection {
  invoices: StatementInvoice[]; payments: StatementPayment[];
  openings: { currency: Currency; amountMinor: number; asOfDate: string }[];
  balances: Record<Currency, Balance>;
  period?: { from: string; to: string; opening: Record<Currency, number>; closing: Record<Currency, number>; movements: StatementMovement[] };
}
const dateOf = (value: string) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new StatementProjectionError();
  return clinicDateString(date, STATEMENT_TIME_ZONE);
};
const money = (value: number) => { if (!Number.isSafeInteger(value)) throw new StatementProjectionError(); return value; };
const nonnegative = (value: number) => { if (money(value) < 0) throw new StatementProjectionError(); return value; };
const blank = (): Record<Currency, number> => ({ YER: 0, SAR: 0, USD: 0 });
function validDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith("0000-")) return false;
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function validate(input: StatementProjectionInput) {
  const { ledger, evidence, patientId } = input;
  if (ledger.invoices.some(i => i.patientId !== patientId) || ledger.payments.some(p => p.patientId !== patientId) || ledger.openings.some(o => o.patientId !== patientId)) throw new StatementProjectionError();
  if (new Set(ledger.openings.map(o => o.currency)).size !== ledger.openings.length) throw new StatementProjectionError();
  for (const invoice of ledger.invoices) { nonnegative(invoice.totalMinor); nonnegative(invoice.discountMinor); }
  for (const opening of ledger.openings) money(opening.amountMinor);
  const invoices = new Map(ledger.invoices.map(i => [i.id, i]));
  const payments = new Map(ledger.payments.map(p => [p.id, p]));
  if (invoices.size !== ledger.invoices.length || payments.size !== ledger.payments.length) throw new StatementProjectionError();
  const successors = new Map<number, number>();
  const predecessors = new Set<number>();
  for (const edge of evidence.invoiceCorrections) {
    const original = invoices.get(edge.originalInvoiceId), next = invoices.get(edge.correctedInvoiceId);
    if (!original || !next || original.status !== "cancelled" || edge.originalInvoiceId === edge.correctedInvoiceId || successors.has(original.id) || predecessors.has(next.id)
      || dateOf(edge.createdAt) < dateOf(original.createdAt) || dateOf(edge.createdAt) < dateOf(next.createdAt)
      || dateOf(next.createdAt) < dateOf(original.createdAt)) throw new StatementProjectionError();
    successors.set(original.id, next.id); predecessors.add(next.id);
  }
  const invoiceEffectiveAt = new Map(evidence.invoiceCorrections.map(edge => [edge.correctedInvoiceId, dateOf(edge.createdAt)]));
  for (const edge of evidence.invoiceCorrections) {
    const originalEffectiveAt = invoiceEffectiveAt.get(edge.originalInvoiceId);
    if (originalEffectiveAt && dateOf(edge.createdAt) < originalEffectiveAt) throw new StatementProjectionError();
  }
  for (const id of successors.keys()) {
    let cursor: number | undefined = id;
    const visited = new Set<number>();
    while (cursor !== undefined) { if (visited.has(cursor)) throw new StatementProjectionError(); visited.add(cursor); cursor = successors.get(cursor); }
  }
  for (const event of evidence.invoiceCancellations) {
    const invoice = invoices.get(event.invoiceId);
    if (!invoice || invoice.status !== "cancelled" || dateOf(event.createdAt) < (invoiceEffectiveAt.get(invoice.id) ?? dateOf(invoice.createdAt))) throw new StatementProjectionError();
  }
  const reversalIds = new Set<number>(), replacementIds = new Set<number>();
  const receiptSuccessors = new Map<number, number | null>();
  for (const edge of evidence.paymentCorrections) {
    const original = payments.get(edge.originalId), reversal = payments.get(edge.reversalId), replacement = edge.replacementId === null ? null : payments.get(edge.replacementId);
    if (!original || !reversal || original.kind !== "payment" || reversal.kind !== "refund" || reversal.reversalOfId !== original.id || reversal.currency !== original.currency
      || reversal.invoiceId !== original.invoiceId || reversal.planId !== original.planId || reversal.openingCurrency !== original.openingCurrency
      || reversalIds.has(reversal.id) || receiptSuccessors.has(original.id) || (edge.replacementId !== null && (!replacement || replacement.kind !== "payment" || replacementIds.has(edge.replacementId) || replacement.id === original.id))
      || dateOf(edge.createdAt) !== dateOf(reversal.createdAt) || dateOf(edge.createdAt) < dateOf(original.createdAt)
      || (replacement && dateOf(replacement.createdAt) !== dateOf(edge.createdAt))) throw new StatementProjectionError();
    reversalIds.add(reversal.id); if (replacement) replacementIds.add(replacement.id);
    receiptSuccessors.set(original.id, replacement?.id ?? null);
  }
  for (const id of receiptSuccessors.keys()) {
    let cursor: number | null | undefined = id;
    const visited = new Set<number>();
    while (cursor != null) { if (visited.has(cursor)) throw new StatementProjectionError(); visited.add(cursor); cursor = receiptSuccessors.get(cursor); }
  }
  // Real refunds use the same reversal edge. Only an independently persisted correction event
  // classifies a refund as internal. Notes, amount similarity and chronology are never authority.
  const refunded = new Map<number, number>();
  for (const payment of ledger.payments) {
    nonnegative(payment.amountMinor); nonnegative(payment.baseAmountMinor);
    if (payment.reversalOfId != null) {
      const original = payments.get(payment.reversalOfId);
      if (!original || payment.kind !== "refund" || original.kind !== "payment" || payment.currency !== original.currency || payment.invoiceId !== original.invoiceId
        || payment.planId !== original.planId || payment.openingCurrency !== original.openingCurrency || dateOf(payment.createdAt) < dateOf(original.createdAt)) throw new StatementProjectionError();
      refunded.set(original.id, money((refunded.get(original.id) ?? 0) + payment.amountMinor));
      if (refunded.get(original.id)! > original.amountMinor) throw new StatementProjectionError();
    }
  }
}

/** Historical state is reconstructed from persisted events, never today's cancellation flags alone. */
export function statementLedgerAt(input: StatementProjectionInput, to?: string) {
  const { ledger, evidence } = input;
  const cancellations = new Map<number, string>();
  for (const event of evidence.invoiceCancellations) cancellations.set(event.invoiceId, dateOf(event.createdAt));
  for (const event of evidence.invoiceCorrections) cancellations.set(event.originalInvoiceId, dateOf(event.createdAt));
  // Same-currency correction writers intentionally retain the original document
  // date. A replacement only existed after its independently recorded correction.
  const effectiveAt = new Map(evidence.invoiceCorrections.map(event => [event.correctedInvoiceId, dateOf(event.createdAt)]));
  const invoices = ledger.invoices.filter(i => !to || (effectiveAt.get(i.id) ?? dateOf(i.createdAt)) <= to).map(invoice => {
    if (!to || invoice.status !== "cancelled") return invoice;
    const cancelled = cancellations.get(invoice.id);
    // An imported cancelled document without a dated event cannot support a historical claim.
    if (!cancelled) throw new StatementProjectionError();
    return cancelled > to ? { ...invoice, status: "open" as const } : invoice;
  });
  const payments = ledger.payments.filter(p => !to || dateOf(p.createdAt) <= to).map(payment => {
    if (!to || !payment.settlementAllocation) return payment;
    const effectiveAt = evidence.allocationEffectiveAt[payment.id];
    if (!effectiveAt) throw new StatementProjectionError();
    return dateOf(effectiveAt) > to ? { ...payment, settlementAllocation: undefined } : payment;
  });
  const openings: { currency: Currency; amountMinor: number; asOfDate: string }[] = [];
  for (const currency of CURRENCIES) {
    const current = ledger.openings.find(o => o.currency === currency);
    if (!to) { if (current) openings.push(current); continue; }
    const history = evidence.openingHistory.filter(o => o.currency === currency).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
    const last = history.filter(h => dateOf(h.createdAt) <= to).at(-1);
    if (last) {
      if (last.afterAmountMinor !== null && last.afterAsOfDate && last.afterAsOfDate <= to) openings.push({ currency, amountMinor: last.afterAmountMinor, asOfDate: last.afterAsOfDate });
    } else if (history.length) {
      const first = history[0];
      if (first.beforeAmountMinor !== null && first.beforeAsOfDate && first.beforeAsOfDate <= to) openings.push({ currency, amountMinor: first.beforeAmountMinor, asOfDate: first.beforeAsOfDate });
    } else if (current && current.asOfDate <= to) {
      if (dateOf(current.updatedAt) > to) throw new StatementProjectionError();
      openings.push(current);
    }
  }
  return { invoices, payments, openings };
}

function at(input: StatementProjectionInput, to?: string): PatientStatementProjection {
  const ledger = statementLedgerAt(input, to);
  // Resolve against the whole immutable invoice set: receipts may retain an old invoice target.
  const refs = new Map(input.ledger.invoices.map(i => [i.id, { patientId: i.patientId, currency: i.baseCurrency }]));
  const likes = toCurrencyPaymentLikes(input.patientId, ledger.payments, refs, input.planCurrencies);
  const mapped = new Map(ledger.payments.map((p, index) => [p.id, likes[index]]));
  const opening = blank();
  for (const o of ledger.openings) opening[o.currency] = money(opening[o.currency] + o.amountMinor);
  const balances = patientBalancesByCurrency(ledger.invoices, likes, opening);
  const internal = new Set(input.evidence.paymentCorrections.filter(e => !to || dateOf(e.createdAt) <= to).map(e => e.reversalId));
  const corrections = new Map<number, Payment[]>();
  for (const payment of ledger.payments) if (internal.has(payment.id) && payment.reversalOfId != null) {
    const list = corrections.get(payment.reversalOfId) ?? []; list.push(payment); corrections.set(payment.reversalOfId, list);
  }
  const payments: StatementPayment[] = [];
  for (const payment of ledger.payments) {
    if (internal.has(payment.id)) continue;
    const like = mapped.get(payment.id)!;
    const target = settlementTargetCurrency(like, like.invoiceCurrency);
    let amountMinor = payment.amountMinor, baseAmountMinor = payment.baseAmountMinor, settlementMinor = settlePaymentMinor(like, target);
    for (const reversal of corrections.get(payment.id) ?? []) {
      const reversed = mapped.get(reversal.id)!;
      if (settlementTargetCurrency(reversed, reversed.invoiceCurrency) !== target) throw new StatementProjectionError();
      amountMinor -= reversal.amountMinor; baseAmountMinor -= reversal.baseAmountMinor; settlementMinor -= settlePaymentMinor(reversed, target);
    }
    nonnegative(amountMinor); nonnegative(baseAmountMinor); nonnegative(settlementMinor);
    if (amountMinor === 0 && baseAmountMinor === 0 && settlementMinor === 0) continue;
    payments.push({ receiptNumber: payment.receiptNumber, createdAt: payment.createdAt, amountMinor, baseAmountMinor, currency: payment.currency,
      kind: payment.kind, label: payment.kind === "refund" ? "استرداد" : "دفعة", settlementMinor, settlementCurrency: target });
  }
  const invoices = ledger.invoices.filter(i => i.status !== "cancelled").map(i => ({ invoiceNumber: i.invoiceNumber, createdAt: i.createdAt,
    totalMinor: i.totalMinor, discountMinor: i.discountMinor, netMinor: invoiceNet(i), baseCurrency: i.baseCurrency, status: (to ? "open" : i.status) as "open" | "paid",
    items: i.items.map(item => ({ description: item.description, quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, totalMinor: item.totalMinor,
      toothCode: item.toothCode ?? null, surfaces: item.surfaces ?? null })) }));
  // Assert the redacted rows reproduce every canonical bucket, including cross-currency settlement.
  for (const currency of CURRENCIES) {
    const billed = invoices.filter(i => i.baseCurrency === currency).reduce((sum, i) => money(sum + i.netMinor), 0);
    const collected = payments.filter(p => p.settlementCurrency === currency).reduce((sum, p) => money(sum + (p.kind === "refund" ? -p.settlementMinor : p.settlementMinor)), 0);
    if (billed !== balances[currency].billedMinor || collected !== balances[currency].collectedMinor) throw new StatementProjectionError();
  }
  return { invoices, payments, openings: ledger.openings.map(o => ({ currency: o.currency, amountMinor: o.amountMinor, asOfDate: o.asOfDate })), balances };
}

/** Patient-facing only. Never feed these compressed rows back into financial writers or audit views. */
export function projectPatientStatement(input: StatementProjectionInput, options: { from?: string; to?: string } = {}): PatientStatementProjection {
  if ((options.to && !validDate(options.to)) || (options.from && (!validDate(options.from) || !options.to || options.from > options.to))) throw new StatementProjectionError();
  validate(input);
  const result = at(input, options.to);
  if (!options.from || !options.to) return result;
  const before = new Date(`${options.from}T12:00:00Z`); before.setUTCDate(before.getUTCDate() - 1);
  const start = at(input, before.toISOString().slice(0, 10));
  const opening = blank(), closing = blank();
  for (const currency of CURRENCIES) { opening[currency] = start.balances[currency].dueMinor; closing[currency] = result.balances[currency].dueMinor; }
  const dates = new Set<string>();
  const addDate = (day: string) => { if (day >= options.from! && day <= options.to!) dates.add(day); };
  const add = (value: string) => addDate(dateOf(value));
  input.ledger.invoices.forEach(i => add(i.createdAt)); input.ledger.payments.forEach(p => add(p.createdAt));
  // Stored accounting dates are already clinic calendar dates, not UTC instants.
  input.ledger.openings.forEach(o => addDate(o.asOfDate));
  input.evidence.invoiceCorrections.forEach(e => add(e.createdAt)); input.evidence.invoiceCancellations.forEach(e => add(e.createdAt));
  input.evidence.openingHistory.forEach(e => {
    add(e.createdAt);
    if (e.beforeAsOfDate) addDate(e.beforeAsOfDate);
    if (e.afterAsOfDate) addDate(e.afterAsOfDate);
  });
  Object.values(input.evidence.allocationEffectiveAt).forEach(add);
  const movements: StatementMovement[] = [];
  let previous = start;
  // A dated net movement describes patient money without emitting correction IDs or cancellation chains.
  for (const date of [...dates].sort()) {
    const next = at(input, date);
    for (const currency of CURRENCIES) {
      const a = previous.balances[currency], b = next.balances[currency];
      let running = a.dueMinor;
      const refunds = next.payments.filter(payment => payment.kind === "refund" && payment.settlementCurrency === currency && dateOf(payment.createdAt) === date);
      const refunded = refunds.reduce((sum, payment) => money(sum + payment.settlementMinor), 0);
      const values: [string, number][] = [["رصيد سابق", b.openingMinor - a.openingMinor], ["قيمة العلاج", b.billedMinor - a.billedMinor],
        ["صافي المدفوعات", a.collectedMinor - b.collectedMinor - refunded],
        ...refunds.map(payment => [`استرداد — ${payment.receiptNumber}`, payment.settlementMinor] as [string, number])];
      for (const [description, delta] of values) if (delta !== 0) {
        running = money(running + delta);
        movements.push({ date, currency, description, debitMinor: Math.max(0, delta), creditMinor: Math.max(0, -delta), balanceMinor: running });
      }
      if (running !== b.dueMinor) throw new StatementProjectionError();
    }
    previous = next;
  }
  for (const currency of CURRENCIES) if (previous.balances[currency].dueMinor !== closing[currency]) throw new StatementProjectionError();
  return { ...result, period: { from: options.from, to: options.to, opening, closing, movements } };
}
