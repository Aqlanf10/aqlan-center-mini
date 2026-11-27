import { CLINIC_TIME_ZONE, ledgerBalancesByCurrency, patientStatementSnapshot } from "./db";
import { planLedgerSummary } from "./plans";
import { CURRENCIES, CLINIC_BASE_CURRENCY } from "./money";
import { clinicDateString } from "./schedule";

// One ledger snapshot owns every amount shown together. Explicit fields keep
// clinical items, photos, free text, staff names and drawer data off the wire.
export async function readReceptionPatientAccount(id: number, includeInvoiceWorkspace = false) {
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const { ledger, plans, planCurrencies, historicalAgreements, reception } =
    await patientStatementSnapshot(id, today, { historicalAgreements: true, reception: true });
  if (!reception || !historicalAgreements) throw new Error("Incomplete account snapshot");
  if ([...ledger.invoices, ...ledger.payments, ...plans].some(row => row.patientId !== id))
    throw new Error("Unexpected account owner");
  const buckets = ledgerBalancesByCurrency(id, ledger, planCurrencies);
  const balances = CURRENCIES.map(currency => {
    const dueMinor = buckets[currency].dueMinor;
    const row = reception.due.currencies.find(item => item.currency === currency);
    if (dueMinor !== (row?.currentBalanceMinor ?? 0)) throw new Error("Inconsistent balance");
    return { currency, dueMinor, paidMinor: buckets[currency].collectedMinor,
      scheduledDueMinor: row?.dueNowMinor ?? (row ? null : 0),
      otherMinor: row?.otherRemainingMinor ?? 0 };
  });
  const invoices = ledger.invoices.map(i => ({ id:i.id, number:i.invoiceNumber, status:i.status,
    currency:i.baseCurrency, netMinor:i.totalMinor-i.discountMinor, createdAt:i.createdAt }));
  const agreements = plans.filter(p => p.agreementApproved || p.debtSource || p.installments.length || p.consentAt).map(p => {
    const verified = p.approvedAgreement?.available !== false && p.invoiceFinancial?.kind !== "review_required";
    const current = p.progress;
    const dueNowMinor = !verified ? null : p.approvedAgreement?.dueNowMinor ??
      (p.installments.length ? Math.min(current.remainingMinor, Math.max(0,current.dueToDateMinor-current.paidMinor)) : null);
    return { id:p.id, currency:p.baseCurrency, totalMinor:current.totalMinor, paidMinor:verified ? current.paidMinor : null,
      remainingMinor:verified ? current.remainingMinor : null, dueNowMinor, status:p.status,
      approval: p.approvedAgreement ?? null,
      mayApprove: p.status === "active" && !!p.consentAt && !p.items.some(item => item.legacyAgreementId) && !p.approvedAgreement,
      principalMinor: p.totalMinor,
      collectible:verified && p.status === "active" && (p.debtSource === "classic_installments" || p.debtSource === "approved_agreement" || (!p.invoiceFinancial && !p.approvedAgreement && p.installments.length > 0)) };
  });
  const receipts = ledger.payments.map(p => ({id:p.id, number:p.receiptNumber, currency:p.currency, amountMinor:p.amountMinor,
    kind:p.kind, createdAt:p.createdAt, invoiceId:p.invoiceId, planId:p.planId}));
  const protectedInvoices = new Set(reception.due.currencies.flatMap(row => row.sources.map(source => source.invoiceId)));
  const protectedOpenings = new Set(reception.due.currencies.flatMap(row => row.sources
    .filter(s => s.kind !== "legacy_opening").map(s => s.openingCurrency)));
  const targets = {
    invoices: invoices.filter(i => i.status === "open" && !protectedInvoices.has(i.id)).map(({id,currency})=>({id,currency})),
    plans: agreements.filter(a => a.collectible).map(({id,currency,dueNowMinor})=>({id,currency,dueNowMinor})),
    openings: reception.openings.filter(o => o.remainingMinor > 0 && !protectedOpenings.has(o.currency)).map(o=>o.currency),
  };
  const history = historicalAgreements.map(({kind,id,currency,agreedMinor,previouslyPaidMinor,remainingMinor,historicalAsOf}) =>
    ({kind,id,currency,agreedMinor,previouslyPaidMinor,remainingMinor,historicalAsOf}));
  const schedules = reception.due.currencies.flatMap(row => row.sources.filter(s => s.kind === "repayment_schedule")
    .map(s => ({id:s.authorityId,currency:s.currency,dueNowMinor:row.status==="verified" ? s.dueNowMinor : null})));
  const openings = ledger.openings.map(({currency, amountMinor, asOfDate}) => ({currency, amountMinor, asOfDate}));
  const invoiceWorkspace = includeInvoiceWorkspace ? {
    balances: buckets, balance: buckets[CLINIC_BASE_CURRENCY], baseCurrency: CLINIC_BASE_CURRENCY,
    invoices: ledger.invoices.map(({ id, patientId, invoiceNumber, status, totalMinor, discountMinor, baseCurrency, createdAt, items }) => ({
      id, patientId, invoiceNumber, status, totalMinor, discountMinor, baseCurrency, createdAt, note: null,
      items: items.map(({ id, description, quantity, unitPriceMinor, totalMinor }) => ({ id, description, quantity, unitPriceMinor, totalMinor })),
    })),
    payments: ledger.payments.map(({ id, receiptNumber, invoiceId, planId, openingCurrency, kind, amountMinor, currency, exchangeRate, baseAmountMinor, method, createdAt, reversalOfId }) => ({
      id, receiptNumber, invoiceId, planId, openingCurrency, kind, amountMinor, currency, exchangeRate, baseAmountMinor, method, createdAt, reversalOfId, note: null,
    })),
    plans: plans.map(plan => ({ ...planLedgerSummary(plan), title: `اتفاق #${plan.id}` })),
    openings: openings.map(row => ({ ...row, patientId: id, note: null })),
  } : undefined;
  return { id, balances, invoices, agreements, receipts, history, schedules, targets, openings, invoiceWorkspace, legacyOpeningPositions: reception.openings };
}
