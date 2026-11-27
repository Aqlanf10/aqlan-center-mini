import { CLINIC_TIME_ZONE, patientStatementSnapshot } from "./db";
import { buildPatientLedgerPayload } from "./patient-ledger-payload";
import { listLegacyBalanceArrangements, listLegacyOpeningPositions } from "./legacy-balance-arrangements-db";
import { CURRENCIES, CLINIC_BASE_CURRENCY } from "./money";
import { clinicDateString } from "./schedule";

/**
 * Safe front-desk financial snapshot for Reception (§15):
 * Exposes ONLY the individual patient's balance, invoices (net amounts without clinical notes/doctors),
 * agreements/installments, receipts, and collection targets — NEVER clinic totals, expenses, commissions, or clinical notes.
 */
export async function readReceptionPatientAccount(id: number, includeInvoiceWorkspace = false) {
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const [{ ledger, plans, historicalAgreements }, legacyOpeningPositions, legacyArrangements] = await Promise.all([
    patientStatementSnapshot(id, today, { historicalAgreements: "tolerant" }),
    listLegacyOpeningPositions(id),
    listLegacyBalanceArrangements(id, today),
  ]);
  if ([...ledger.invoices, ...ledger.payments, ...plans].some((row) => row.patientId !== id)) {
    throw new Error("Unexpected account owner");
  }
  const payload = buildPatientLedgerPayload({
    patientId: id,
    invoices: ledger.invoices,
    payments: ledger.payments,
    openings: ledger.openings,
    plans,
  });

  const agreements = plans
    .filter((p) => p.agreementApproved || p.debtSource || p.installments.length || p.consentAt)
    .map((p) => {
      const verified = p.approvedAgreement?.available !== false && p.invoiceFinancial?.kind !== "review_required";
      const current = p.progress;
      const dueNowMinor = !verified
        ? null
        : p.approvedAgreement?.dueNowMinor ??
          (p.installments.length
            ? Math.min(current.remainingMinor, Math.max(0, current.dueToDateMinor - current.paidMinor))
            : null);
      return {
        id: p.id,
        currency: p.baseCurrency,
        totalMinor: current.totalMinor,
        paidMinor: verified ? current.paidMinor : null,
        remainingMinor: verified ? current.remainingMinor : null,
        dueNowMinor,
        status: p.status,
        approval: p.approvedAgreement ?? null,
        mayApprove:
          p.status === "active" &&
          Boolean(p.consentAt) &&
          !p.items.some((item) => item.legacyAgreementId) &&
          !p.approvedAgreement,
        principalMinor: p.totalMinor,
        collectible:
          verified &&
          p.status === "active" &&
          (p.debtSource === "classic_installments" ||
            p.debtSource === "approved_agreement" ||
            (!p.invoiceFinancial && !p.approvedAgreement && p.installments.length > 0)),
      };
    });

  const schedules = legacyArrangements.map((arr) => ({
    id: arr.id,
    currency: arr.currency,
    dueNowMinor: arr.progress.suggestedMinor,
  }));

  const balances = CURRENCIES.map((currency) => {
    const dueMinor = payload.balances[currency].dueMinor;
    const planDue = agreements
      .filter((a) => a.currency === currency && a.status === "active")
      .reduce<number | null>((acc, a) => (acc === null || a.dueNowMinor === null ? null : acc + a.dueNowMinor), 0);
    const schedDue = schedules
      .filter((s) => s.currency === currency)
      .reduce((acc, s) => acc + s.dueNowMinor, 0);
    const scheduledDueMinor = planDue === null ? null : planDue + schedDue;
    return {
      currency,
      dueMinor,
      paidMinor: payload.balances[currency].collectedMinor,
      scheduledDueMinor,
      otherMinor: scheduledDueMinor !== null ? Math.max(0, dueMinor - scheduledDueMinor) : 0,
    };
  });

  const invoices = ledger.invoices.map((i) => ({
    id: i.id,
    number: i.invoiceNumber,
    status: i.status,
    currency: i.baseCurrency,
    netMinor: i.totalMinor - i.discountMinor,
    createdAt: i.createdAt,
  }));

  const receipts = ledger.payments.map((p) => ({
    id: p.id,
    number: p.receiptNumber,
    currency: p.currency,
    amountMinor: p.amountMinor,
    kind: p.kind,
    createdAt: p.createdAt,
    invoiceId: p.invoiceId,
    planId: p.planId,
  }));

  const targets = {
    invoices: invoices.filter((i) => i.status === "open").map(({ id: invId, currency }) => ({ id: invId, currency })),
    plans: agreements.filter((a) => a.collectible).map(({ id: planId, currency, dueNowMinor }) => ({ id: planId, currency, dueNowMinor })),
    openings: legacyOpeningPositions.filter((o) => o.remainingMinor > 0).map((o) => o.currency),
  };

  const history = (historicalAgreements ?? []).map(
    ({ kind, id: histId, currency, agreedMinor, previouslyPaidMinor, remainingMinor, historicalAsOf }) => ({
      kind,
      id: histId,
      currency,
      agreedMinor,
      previouslyPaidMinor,
      remainingMinor,
      historicalAsOf,
    }),
  );

  const openings = ledger.openings.map(({ currency, amountMinor, asOfDate }) => ({ currency, amountMinor, asOfDate }));

  const invoiceWorkspace = includeInvoiceWorkspace
    ? {
        balances: payload.balances,
        balance: payload.balances[CLINIC_BASE_CURRENCY],
        baseCurrency: CLINIC_BASE_CURRENCY,
        invoices: ledger.invoices.map(
          ({ id: invId, patientId, invoiceNumber, status, totalMinor, discountMinor, baseCurrency, createdAt, items }) => ({
            id: invId,
            patientId,
            invoiceNumber,
            status,
            totalMinor,
            discountMinor,
            baseCurrency,
            createdAt,
            note: null,
            items: items.map(({ id: itemId, description, quantity, unitPriceMinor, totalMinor: lineTotal }) => ({
              id: itemId,
              description,
              quantity,
              unitPriceMinor,
              totalMinor: lineTotal,
            })),
          }),
        ),
        payments: ledger.payments.map(
          ({
            id: payId,
            receiptNumber,
            invoiceId,
            planId,
            openingCurrency,
            kind,
            amountMinor,
            currency,
            exchangeRate,
            baseAmountMinor,
            method,
            createdAt,
            reversalOfId,
          }) => ({
            id: payId,
            receiptNumber,
            invoiceId,
            planId,
            openingCurrency,
            kind,
            amountMinor,
            currency,
            exchangeRate,
            baseAmountMinor,
            method,
            createdAt,
            reversalOfId,
            note: null,
          }),
        ),
        plans: payload.plans.map((plan) => ({ ...plan, title: `اتفاق #${plan.id}` })),
        openings: openings.map((row) => ({ ...row, patientId: id, note: null })),
      }
    : undefined;

  return {
    id,
    balances,
    invoices,
    agreements,
    receipts,
    history,
    schedules,
    targets,
    openings,
    invoiceWorkspace,
    legacyOpeningPositions,
  };
}
