import type { DbClient } from "./db";
import {
  patientBalancesByCurrency, requireCurrency, toCurrencyPaymentLikes, type OpeningByCurrency,
} from "./money";
import {
  projectReversedInstallmentRecovery, type RecoveryCreationAuditSnapshot, type RecoveryInvoiceSnapshot,
  type RecoveryPaymentSnapshot, type RecoveryPlanSnapshot, type RecoveryProjection, type RecoverySnapshot,
} from "./reversed-installment-recovery";

type Executor = Pick<DbClient, "query">;
export interface RecoveryDocumentState {
  invoiceId: number; planId: number | null; snapshot: RecoverySnapshot; projection: RecoveryProjection;
}
export interface PatientInstallmentRecoveryRead {
  recoveries: Extract<RecoveryProjection, { kind: "recoverable" }>[];
  reviews: { invoiceId: number; planId: number | null; reason: string }[];
}

/** Complete private evidence on the caller's connection. Reader callers use one
 * repeatable-read transaction; writers call after the canonical financial locks.
 * No pagination, fail-open fallback, mutation or alternate balance calculation.
 */
export async function readRecoveryDocumentStates(client: Executor, patientId: number): Promise<RecoveryDocumentState[]> {
  const { rows: invoiceRows } = await client.query<{
    id: number; patient_id: number; plan_id: number | null; status: RecoveryInvoiceSnapshot["status"];
    total_minor: string; discount_minor: string; base_currency: string;
  }>(`SELECT id, patient_id, plan_id, status, total_minor::text, discount_minor::text, base_currency
        FROM invoices WHERE patient_id = $1 ORDER BY id`, [patientId]);
  if (!invoiceRows.some((invoice) => invoice.plan_id !== null && invoice.status !== "cancelled")) return [];
  const invoices: RecoveryInvoiceSnapshot[] = invoiceRows.map((invoice) => ({
    id: invoice.id, patientId: invoice.patient_id, planId: invoice.plan_id, status: invoice.status,
    totalMinor: Number(invoice.total_minor), discountMinor: Number(invoice.discount_minor),
    baseCurrency: requireCurrency(invoice.base_currency, "فاتورة استعادة قسط", invoice.id),
  }));
  const { rows: planRows } = await client.query<{
    id: number; patient_id: number; base_currency: string; status: RecoveryPlanSnapshot["status"];
  }>(`SELECT id, patient_id, base_currency, status FROM treatment_plans WHERE patient_id = $1 ORDER BY id`, [patientId]);
  const plans = new Map<number, RecoveryPlanSnapshot>(planRows.map((plan) => [plan.id, {
    id: plan.id, patientId: plan.patient_id, status: plan.status,
    baseCurrency: requireCurrency(plan.base_currency, "خطة استعادة قسط", plan.id),
  }]));
  // UNION deduplicates IDs and terminates even if unsupported historical links cycle.
  // Include incoming/outgoing reversal edges even when their stored target diverges.
  const { rows: paymentRows } = await client.query<{
    id: number; patient_id: number; invoice_id: number | null; plan_id: number | null;
    opening_currency: string | null; kind: RecoveryPaymentSnapshot["kind"]; reversal_of_id: number | null;
    amount_minor: string; currency: string; base_amount_minor: string; base_currency: string; exchange_rate: string;
  }>(`WITH RECURSIVE related(id) AS (
        SELECT id FROM payments WHERE patient_id = $1 OR invoice_id = ANY($2::int[])
        UNION
        SELECT p.id FROM payments p
          JOIN payments linked ON (p.id = linked.reversal_of_id OR p.reversal_of_id = linked.id)
          JOIN related r ON linked.id = r.id
      )
      SELECT p.id, p.patient_id, p.invoice_id, p.plan_id, p.opening_currency, p.kind, p.reversal_of_id,
             p.amount_minor::text, p.currency, p.base_amount_minor::text, p.base_currency, p.exchange_rate::text
        FROM payments p JOIN related r ON p.id = r.id ORDER BY p.id`, [patientId, invoices.map((invoice) => invoice.id)]);
  const payments: RecoveryPaymentSnapshot[] = paymentRows.map((payment) => ({
    id: payment.id, patientId: payment.patient_id, invoiceId: payment.invoice_id, planId: payment.plan_id,
    openingCurrency: payment.opening_currency === null ? null : requireCurrency(payment.opening_currency, "سند استعادة قسط", payment.id),
    kind: payment.kind, reversalOfId: payment.reversal_of_id, amountMinor: Number(payment.amount_minor),
    currency: requireCurrency(payment.currency, "سند استعادة قسط", payment.id),
    baseAmountMinor: Number(payment.base_amount_minor),
    baseCurrency: requireCurrency(payment.base_currency, "أساس سند استعادة قسط", payment.id), exchangeRate: Number(payment.exchange_rate),
  }));
  const { rows: openingRows } = await client.query<{ currency: string; amount_minor: string }>(
    `SELECT currency, amount_minor::text FROM patient_opening_balances WHERE patient_id = $1`, [patientId]);
  const openings: OpeningByCurrency = {};
  for (const opening of openingRows) {
    const currency = requireCurrency(opening.currency, "رصيد استعادة قسط", patientId);
    const amount = Number(opening.amount_minor);
    if (!Number.isSafeInteger(amount)) throw new Error("رصيد افتتاحي خارج النطاق الآمن.");
    openings[currency] = (openings[currency] ?? 0) + amount;
  }
  const balances = patientBalancesByCurrency(invoices, toCurrencyPaymentLikes(
    patientId, payments.filter((payment) => payment.patientId === patientId),
    new Map(invoices.map((invoice) => [invoice.id, { patientId: invoice.patientId, currency: invoice.baseCurrency }])),
    new Map([...plans.values()].map((plan) => [plan.id, { patientId: plan.patientId, currency: plan.baseCurrency }])),
  ), openings);
  const { rows: auditRows } = await client.query<{
    id: string; action: string; entity: string | null; entity_id: string | null; details: unknown;
  }>(`SELECT id::text, action, entity, entity_id, details FROM audit_log
       WHERE action = 'payment.create' AND entity = 'payment'
         AND details->>'فاتورة_القسط' = ANY($1::text[]) ORDER BY id`, [invoices.map((invoice) => String(invoice.id))]);
  const audits: RecoveryCreationAuditSnapshot[] = auditRows.map((audit) => ({
    // audit_log uses BIGSERIAL; pg intentionally returns int8 as text. The pure
    // projection still refuses nonpositive/unsafe IDs rather than rounding evidence.
    id: Number(audit.id), action: audit.action, entity: audit.entity, entityId: audit.entity_id, details: audit.details,
  }));
  const byId = new Map(payments.map((payment) => [payment.id, payment]));
  const reversedBy = new Map<number, number[]>();
  for (const payment of payments) if (payment.reversalOfId !== null) {
    const children = reversedBy.get(payment.reversalOfId) ?? [];
    children.push(payment.id); reversedBy.set(payment.reversalOfId, children);
  }
  return invoices.filter((invoice) => invoice.planId !== null).map((invoice) => {
    const linked = new Set(payments.filter((payment) => payment.invoiceId === invoice.id).map((payment) => payment.id));
    const pending = [...linked];
    while (pending.length) {
      const id = pending.pop()!;
      const originId = byId.get(id)?.reversalOfId;
      const related = [...(reversedBy.get(id) ?? []), ...(originId !== null && originId !== undefined ? [originId] : [])];
      for (const relatedId of related) if (!linked.has(relatedId) && byId.has(relatedId)) {
        linked.add(relatedId); pending.push(relatedId);
      }
    }
    const snapshot: RecoverySnapshot = {
      complete: true, invoice, plan: plans.get(invoice.planId!) ?? null,
      payments: payments.filter((payment) => linked.has(payment.id)), creationAudits: audits,
      account: { patientId, currency: invoice.baseCurrency, dueMinor: balances[invoice.baseCurrency].dueMinor },
    };
    return { invoiceId: invoice.id, planId: invoice.planId, snapshot, projection: projectReversedInstallmentRecovery(snapshot) };
  });
}

/** A guard must not reinterpret unrelated manual/replacement invoice debt.
 * A structured creation marker or a receipt/refund pair carrying BOTH canonical
 * targets signals an issued-installment history; absence of full proof then needs
 * review. Ordinary invoice-only (null-plan) receipts/refunds do not create this signal.
 */
export function hasInstallmentReversalSignal(state: RecoveryDocumentState): boolean {
  const { invoice, payments, creationAudits } = state.snapshot;
  // Suspicion uses the complete closure, not the refund's claimed targets. A
  // divergent/null refund invoice is exactly one of the histories needing review.
  const reversalSignals = payments.filter((payment) => payment.kind === "refund" || payment.reversalOfId !== null);
  if (!reversalSignals.length || invoice.planId === null) return false;
  if (creationAudits.some((audit) => audit.action === "payment.create" && audit.entity === "payment"
    && audit.details !== null && typeof audit.details === "object" && !Array.isArray(audit.details)
    && (audit.details as Record<string, unknown>)["فاتورة_القسط"] === invoice.id)) return true;
  return reversalSignals.some((refund) => payments.some((origin) => origin.id === refund.reversalOfId && origin.kind === "payment"
      && origin.patientId === invoice.patientId && origin.invoiceId === invoice.id && origin.planId === invoice.planId));
}

export function publicRecoveryRead(states: readonly RecoveryDocumentState[]): PatientInstallmentRecoveryRead {
  return {
    recoveries: states.flatMap((state) => state.projection.kind === "recoverable" ? [state.projection] : []),
    reviews: states.flatMap((state) => state.projection.kind === "review_required" && hasInstallmentReversalSignal(state)
      ? [{ invoiceId: state.invoiceId, planId: state.planId, reason: state.projection.reason }] : []),
  };
}
