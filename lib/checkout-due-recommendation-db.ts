import { CLINIC_TIME_ZONE, type DbClient } from "./db";
import { approvedAgreementPosition } from "./approved-agreements";
import { readDebtRepayments } from "./debt-installments-db";
import { debtAccountDue } from "./debt-account-position";
import { listLegacyBalanceArrangements } from "./legacy-balance-arrangements-db";
import { legacyCheckoutDueNow } from "./checkout-legacy-due";
import { readInvoiceSettlementPosition } from "./invoice-settlement-position";
import { CURRENCIES, requireCurrency, settlePaymentMinor, type Currency } from "./money";
import { buildCheckoutDueRecommendation, type CheckoutDueSource } from "./checkout-due-recommendation";

/** Compose only canonical source readers on the caller's repeatable-read,
 * read-only transaction. No pool acquisition, schema bootstrap, mutation, or
 * payment target inference is permitted here. The route must supply the exact
 * selected visit invoice from that same snapshot. */
export async function readCheckoutDueRecommendationInSnapshot(client: DbClient, input: {
  patientId: number; visitInvoiceId: number | null; today: string;
}) {
  if (!Number.isSafeInteger(input.patientId) || input.patientId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(input.today)) throw new Error("Invalid checkout source request");
  const sources: CheckoutDueSource[] = [];
  const approvals = (await client.query<{ plan_id: number }>("SELECT plan_id FROM approved_agreement_principals WHERE patient_id=$1 ORDER BY plan_id", [input.patientId])).rows;
  for (const approval of approvals) {
    const position = await approvedAgreementPosition(approval.plan_id, input.today, client);
    if (!position) throw new Error("Missing checkout approval source");
    sources.push({ kind: "approved_agreement", authorityId: approval.plan_id, currency: position.currency,
      invoiceId: position.invoiceId, openingCurrency: position.openingCurrency, remainingMinor: position.remainingMinor,
      dueNowMinor: position.available ? position.dueNowMinor : null, available: position.available });
  }
  for (const schedule of await readDebtRepayments(client, input.patientId, input.today)) {
    // An old revision's cancellation is not a second live authority or debt.
    if (schedule.status !== "active") continue;
    const available = schedule.available && !schedule.requiresReview;
    const dueNowMinor = !available ? null : schedule.terms.mode === "full" ? schedule.remainingMinor
      : schedule.progress === null ? null : schedule.progress.rows.filter(row => row.dueDate <= input.today)
        .reduce((sum, row) => sum + row.remainingMinor, 0);
    sources.push({ kind: "repayment_schedule", authorityId: schedule.id, currency: schedule.target.currency,
      invoiceId: schedule.target.invoiceId, openingCurrency: schedule.target.openingCurrency,
      remainingMinor: schedule.remainingMinor, dueNowMinor, available: available && dueNowMinor !== null });
  }
  const arrangements = await listLegacyBalanceArrangements(input.patientId, input.today, false, client);
  if (arrangements.some(row => !row.progress.completed)) {
    // "Today" is the recommendation's current clinic date, not the historical
    // selected visit date. Use recorded settlement, never current FX settings.
    const payments = (await client.query<{ id: number; opening_currency: string; currency: string; kind: string; amount_minor: string; base_amount_minor: string }>(
      `SELECT id,opening_currency,currency,kind,amount_minor::text,base_amount_minor::text FROM payments
       WHERE patient_id=$1 AND opening_currency IS NOT NULL AND (created_at AT TIME ZONE $2)::date=$3::date ORDER BY id`,
      [input.patientId, CLINIC_TIME_ZONE, input.today])).rows;
    const paidToday = new Map<Currency, number>();
    for (const payment of payments) {
      if (payment.kind !== "payment" && payment.kind !== "refund") throw new Error("Invalid opening receipt kind");
      const currency = requireCurrency(payment.opening_currency, "رصيد المغادرة", input.patientId);
      const settled = settlePaymentMinor({ id: payment.id, currency: requireCurrency(payment.currency, "سند المغادرة", payment.id),
        amountMinor: Number(payment.amount_minor), baseAmountMinor: Number(payment.base_amount_minor) }, currency);
      const next = (paidToday.get(currency) ?? 0) + (payment.kind === "refund" ? -settled : settled);
      if (!Number.isSafeInteger(next)) throw new Error("Invalid checkout opening settlement");
      paidToday.set(currency, next);
    }
    for (const row of arrangements.filter(row => !row.progress.completed)) {
      const dueNowMinor = legacyCheckoutDueNow({ cadence: row.cadence, installmentMinor: row.installmentMinor,
        remainingMinor: row.progress.arrangementRemainingMinor, overdueMinor: row.progress.overdueMinor,
        paidTodayMinor: paidToday.get(row.currency) ?? 0, firstDueDate: row.firstDueDate, today: input.today });
      sources.push({ kind: "legacy_opening", authorityId: row.id, currency: row.currency, invoiceId: null,
        openingCurrency: row.currency, remainingMinor: row.progress.currentOpeningDueMinor,
        dueNowMinor, available: dueNowMinor !== null });
    }
  }
  if (input.visitInvoiceId !== null) {
    const invoice = (await client.query<{ base_currency: string }>("SELECT base_currency FROM invoices WHERE id=$1 AND patient_id=$2", [input.visitInvoiceId, input.patientId])).rows[0];
    if (!invoice) throw new Error("Missing selected visit invoice");
    const currency = requireCurrency(invoice.base_currency, "فاتورة المغادرة", input.visitInvoiceId);
    const position = await readInvoiceSettlementPosition(client, { patientId: input.patientId, invoiceId: input.visitInvoiceId, currency });
    sources.push({ kind: "visit_invoice", authorityId: position.invoiceId, currency, invoiceId: position.invoiceId,
      openingCurrency: null, remainingMinor: position.remainingMinor, dueNowMinor: position.remainingMinor, available: position.available });
  }
  const current: Partial<Record<Currency, number>> = {};
  for (const currency of CURRENCIES) current[currency] = (await debtAccountDue(client, input.patientId, currency)).due;
  return buildCheckoutDueRecommendation({ patientId: input.patientId, visitInvoiceId: input.visitInvoiceId, current, sources });
}
