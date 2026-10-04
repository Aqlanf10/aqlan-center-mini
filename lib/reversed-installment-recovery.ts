import {
  CLINIC_BASE_CURRENCY, invoiceNet, isCurrency, parseAmount, settlePaymentMinor,
  type Currency,
} from "./money";

/** Opt-in only: never change the meaning/fingerprint of an ordinary receipt. */
export const REVERSED_INSTALLMENT_RECOVERY_PURPOSE = "reversed-installment-recovery" as const;

type InvoiceStatus = "open" | "paid" | "cancelled";
export interface RecoveryInvoiceSnapshot {
  id: number; patientId: number; planId: number | null; status: InvoiceStatus;
  totalMinor: number; discountMinor: number; baseCurrency: Currency;
}
export interface RecoveryPlanSnapshot {
  id: number; patientId: number; baseCurrency: Currency;
  status: "active" | "completed" | "cancelled";
}
export interface RecoveryPaymentSnapshot {
  id: number; patientId: number; invoiceId: number | null; planId: number | null;
  openingCurrency: Currency | null; kind: "payment" | "refund"; reversalOfId: number | null;
  amountMinor: number; currency: Currency; baseAmountMinor: number; baseCurrency: Currency;
  exchangeRate: number;
}
export interface RecoveryCreationAuditSnapshot {
  id: number; action: string; entity: string | null; entityId: string | null; details: unknown;
}
/** Server-only adapter input. Never accept this snapshot/proof from the client.
 * `complete` means one complete, consistently read set of ALL invoice-linked rows,
 * all referenced origins and every reversal of those receipt origins (even when its
 * invoice/patient/plan target diverges), plus relevant creation audits. No pagination,
 * missing reversal closure, truncation or swallowed query errors may set it true.
 * A projection does not acquire locks or authorize a write; the writer must reacquire
 * canonical locks, re-read the complete evidence and evaluate again before posting.
 */
export interface RecoverySnapshot {
  complete: boolean;
  invoice: RecoveryInvoiceSnapshot;
  plan: RecoveryPlanSnapshot | null;
  payments: readonly RecoveryPaymentSnapshot[];
  creationAudits: readonly RecoveryCreationAuditSnapshot[];
  account: { patientId: number; currency: Currency; dueMinor: number };
}
export type RecoveryReviewReason =
  | "incomplete_snapshot" | "invalid_snapshot" | "ownership_mismatch" | "currency_mismatch"
  | "invalid_payment" | "invalid_refund_lineage" | "refund_exceeds_origin" | "unsupported_settlement"
  | "missing_creation_provenance" | "ambiguous_creation_provenance" | "creation_provenance_mismatch"
  | "origin_principal_mismatch" | "historical_plan_attribution_gap" | "unsafe_money_sum";
export type RecoveryProjection =
  | { kind: "excluded"; reason: "cancelled_invoice" | "not_plan_invoice" | "zero_principal" | "no_reversal" | "settled" }
  | { kind: "review_required"; reason: RecoveryReviewReason }
  | {
    kind: "recoverable"; purpose: typeof REVERSED_INSTALLMENT_RECOVERY_PURPOSE;
    patientId: number; invoiceId: number; planId: number; originPaymentId: number; creationAuditId: number;
    currency: Currency; rawInvoiceStatus: Exclude<InvoiceStatus, "cancelled">;
    principalMinor: number; linkedNetPaidMinor: number; remainingMinor: number;
    actualAccountDueMinor: number; suggestedCashMinor: number; accountCreditReview: boolean;
    reversalPaymentIds: number[];
  };

const positiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
const nonnegativeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const review = (reason: RecoveryReviewReason): RecoveryProjection => ({ kind: "review_required", reason });

/** Bounded, conservative read projection. Audit is provenance evidence only;
 * principal/settlement always come from canonical invoices/payments + money helpers.
 * No SQL, status rewrite, note parsing, FX settings, receipt reassignment or mutation.
 */
export function projectReversedInstallmentRecovery(snapshot: RecoverySnapshot): RecoveryProjection {
  if (!snapshot.complete) return review("incomplete_snapshot");
  const { invoice, plan, account } = snapshot;
  if (!positiveInteger(invoice.id) || !positiveInteger(invoice.patientId)
    || !["open", "paid", "cancelled"].includes(invoice.status)
    || !nonnegativeInteger(invoice.totalMinor) || !nonnegativeInteger(invoice.discountMinor)
    || !isCurrency(invoice.baseCurrency) || !Number.isSafeInteger(account.dueMinor)
    || !positiveInteger(account.patientId) || !isCurrency(account.currency)) return review("invalid_snapshot");
  if (invoice.status === "cancelled") return { kind: "excluded", reason: "cancelled_invoice" };
  if (invoice.planId === null) return { kind: "excluded", reason: "not_plan_invoice" };
  if (!positiveInteger(invoice.planId) || !plan || !positiveInteger(plan.id)
    || !["active", "completed", "cancelled"].includes(plan.status)) return review("invalid_snapshot");
  if (plan.id !== invoice.planId || plan.patientId !== invoice.patientId || account.patientId !== invoice.patientId) {
    return review("ownership_mismatch");
  }
  if (!isCurrency(plan.baseCurrency) || plan.baseCurrency !== invoice.baseCurrency || account.currency !== invoice.baseCurrency) {
    return review("currency_mismatch");
  }
  const principalMinor = invoiceNet(invoice);
  if (principalMinor === 0) return { kind: "excluded", reason: "zero_principal" };
  const byId = new Map<number, RecoveryPaymentSnapshot>();
  let attributionGap = false;
  let linkedNetPaidMinor = 0;
  for (const payment of snapshot.payments) {
    if (!positiveInteger(payment.id) || byId.has(payment.id) || !positiveInteger(payment.amountMinor)
      || !nonnegativeInteger(payment.baseAmountMinor) || !isCurrency(payment.currency)
      || payment.baseCurrency !== CLINIC_BASE_CURRENCY || !Number.isFinite(payment.exchangeRate) || payment.exchangeRate <= 0
      || !["payment", "refund"].includes(payment.kind) || payment.openingCurrency !== null
      || (payment.kind === "payment" && payment.reversalOfId !== null)
      || (payment.kind === "refund" && !positiveInteger(payment.reversalOfId ?? 0))) return review("invalid_payment");
    if (payment.patientId !== invoice.patientId || payment.invoiceId !== invoice.id) return review("ownership_mismatch");
    if (payment.planId !== null && payment.planId !== plan.id) return review("ownership_mismatch");
    if (payment.planId === null) attributionGap = true;
    // Stored base amount is authoritative. NUMERIC(18,6) rounds stored FX;
    // recomputing from that rounded rate can change a legitimate historical amount.
    let settled: number;
    try { settled = settlePaymentMinor(payment, invoice.baseCurrency); }
    catch { return review("unsupported_settlement"); }
    linkedNetPaidMinor += payment.kind === "refund" ? -settled : settled;
    if (!Number.isSafeInteger(linkedNetPaidMinor)) return review("unsafe_money_sum");
    byId.set(payment.id, payment);
  }
  const refundedByOrigin = new Map<number, number>();
  const refunds = snapshot.payments.filter((payment) => payment.kind === "refund");
  for (const refund of refunds) {
    const origin = byId.get(refund.reversalOfId!);
    if (!origin || origin.kind !== "payment" || refund.id === origin.id
      || refund.patientId !== origin.patientId || refund.invoiceId !== origin.invoiceId
      || refund.planId !== origin.planId || refund.currency !== origin.currency
      || refund.baseCurrency !== origin.baseCurrency || refund.exchangeRate !== origin.exchangeRate) {
      return review("invalid_refund_lineage");
    }
    const refunded = (refundedByOrigin.get(origin.id) ?? 0) + refund.amountMinor;
    if (!Number.isSafeInteger(refunded)) return review("unsafe_money_sum");
    if (refunded > origin.amountMinor) return review("refund_exceeds_origin");
    refundedByOrigin.set(origin.id, refunded);
  }
  if (!refunds.length) return { kind: "excluded", reason: "no_reversal" };

  // An original installment creation audit has a structured, transaction-owned link.
  // A replacement invoice's note or copied plan_id is never provenance.
  const candidates = snapshot.creationAudits.filter((audit) =>
    audit.action === "payment.create" && audit.entity === "payment"
    && record(audit.details) && audit.details["فاتورة_القسط"] === invoice.id,
  );
  if (!candidates.length) return review("missing_creation_provenance");
  if (candidates.length !== 1) return review("ambiguous_creation_provenance");
  const audit = candidates[0];
  const details = audit.details as Record<string, unknown>;
  // Strict audit/snapshot matching is deliberately conservative. Valid historical
  // rates with >6 decimals can differ from NUMERIC(18,6) persistence and require
  // review; this is not proof of corruption, nor permission to approximate lineage.
  const origin = snapshot.payments.find((payment) => String(payment.id) === audit.entityId);
  if (!positiveInteger(audit.id) || !origin || origin.kind !== "payment" || origin.planId !== plan.id
    || details["المريض"] !== invoice.patientId || details["الخطة"] !== plan.id
    || details["المبلغ"] !== origin.amountMinor || details["العملة"] !== origin.currency
    || details["سعر_الصرف"] !== origin.exchangeRate || details["المكافئ"] !== origin.baseAmountMinor
    || typeof details["قسط"] !== "number" || !positiveInteger(details["قسط"])) {
    return review("creation_provenance_mismatch");
  }
  if (settlePaymentMinor(origin, invoice.baseCurrency) !== principalMinor || invoice.discountMinor !== 0) {
    return review("origin_principal_mismatch");
  }
  // At least one reversal must belong to the original creation receipt, not merely
  // to a later, unrelated invoice-only payment on a manually marked document.
  if (!refundedByOrigin.has(origin.id)) return { kind: "excluded", reason: "no_reversal" };
  if (attributionGap) return review("historical_plan_attribution_gap");
  if (linkedNetPaidMinor < 0) return review("unsafe_money_sum");
  const remainingMinor = principalMinor - linkedNetPaidMinor;
  if (!Number.isSafeInteger(remainingMinor)) return review("unsafe_money_sum");
  if (remainingMinor <= 0) return { kind: "excluded", reason: "settled" };
  return {
    kind: "recoverable", purpose: REVERSED_INSTALLMENT_RECOVERY_PURPOSE,
    patientId: invoice.patientId, invoiceId: invoice.id, planId: plan.id,
    originPaymentId: origin.id, creationAuditId: audit.id, currency: invoice.baseCurrency,
    rawInvoiceStatus: invoice.status, principalMinor, linkedNetPaidMinor, remainingMinor,
    actualAccountDueMinor: account.dueMinor,
    suggestedCashMinor: Math.min(remainingMinor, Math.max(0, account.dueMinor)),
    accountCreditReview: account.dueMinor < remainingMinor,
    reversalPaymentIds: refunds.map((payment) => payment.id).sort((a, b) => a - b),
  };
}

export interface RecoveryIntent {
  purpose: typeof REVERSED_INSTALLMENT_RECOVERY_PURPOSE;
  patientId: number; invoiceId: number; amountMinor: number; currency: Currency;
  method: "cash" | "transfer"; note: string | null;
}
export type RecoveryIntentResult =
  | { kind: "ordinary" }
  | { kind: "invalid"; reason: "invalid_purpose" | "invalid_key" | "invalid_target" | "server_owned_field" | "invalid_amount" | "invalid_method" }
  | { kind: "recovery"; intent: RecoveryIntent; idempotencyKey: string };

/** Parse only the explicit new mode. Absence of purpose leaves ordinary routing untouched. */
export function parseRecoveryIntent(body: unknown, rawKey: string | null): RecoveryIntentResult {
  if (!record(body) || body.purpose === undefined) return { kind: "ordinary" };
  if (body.purpose !== REVERSED_INSTALLMENT_RECOVERY_PURPOSE) return { kind: "invalid", reason: "invalid_purpose" };
  const key = rawKey?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return { kind: "invalid", reason: "invalid_key" };
  // Neither association nor stored FX/evidence can be chosen by the browser.
  for (const field of ["planId", "openingCurrency", "reversalOfId", "originPaymentId", "creationAuditId", "exchangeRate", "baseCurrency", "baseAmountMinor"]) {
    if (body[field] !== undefined && body[field] !== null) return { kind: "invalid", reason: "server_owned_field" };
  }
  const requestId = (value: unknown): number => {
    if (typeof value === "number") return value;
    return typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  };
  const patientId = requestId(body.patientId);
  const invoiceId = requestId(body.invoiceId);
  if (!positiveInteger(patientId) || !positiveInteger(invoiceId) || (body.kind !== undefined && body.kind !== "payment")) {
    return { kind: "invalid", reason: "invalid_target" };
  }
  if (!isCurrency(body.currency) || (typeof body.amount !== "string" && typeof body.amount !== "number")) {
    return { kind: "invalid", reason: "invalid_amount" };
  }
  const amountMinor = parseAmount(String(body.amount), body.currency);
  if (amountMinor === null || amountMinor <= 0) return { kind: "invalid", reason: "invalid_amount" };
  if (body.method !== undefined && body.method !== "cash" && body.method !== "transfer") {
    return { kind: "invalid", reason: "invalid_method" };
  }
  return { kind: "recovery", idempotencyKey: key, intent: {
    purpose: REVERSED_INSTALLMENT_RECOVERY_PURPOSE, patientId, invoiceId, amountMinor, currency: body.currency,
    method: body.method === "transfer" ? "transfer" : "cash",
    note: typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 300) : null,
  } };
}

/** Hash this canonical caller intent only inside the server-owned transaction.
 * Its explicit version never collides semantically with ordinary v1/installment hashes.
 * FX is intentionally absent: a successful retry uses the stored receipt snapshot
 * before reading changed settings or mutable eligibility. The writer must verify
 * the stored receipt and its atomic recovery audit agree before returning a replay.
 */
export function recoveryIntentFingerprintSource(intent: RecoveryIntent, actor: string): string {
  return JSON.stringify({
    v: "reversed-installment-recovery-1", actor, purpose: intent.purpose,
    patientId: intent.patientId, invoiceId: intent.invoiceId, amountMinor: intent.amountMinor,
    currency: intent.currency, method: intent.method, note: intent.note,
  });
}
