import { describe, expect, it, vi } from "vitest";
import type { Invoice, TreatmentPlan, patientStatementSnapshot } from "../lib/db";
import { debtInstallmentProgress } from "../lib/debt-installments";
import { assemblePatientStatement, planPosition, statementDueNowByCurrency } from "../lib/patient-statement-build";
import { SETTING_DEFAULTS } from "../lib/settings";
import { emptyStatementEvidence, type PatientStatementProjection } from "../lib/patient-statement-projection";

function invoicePlan(): TreatmentPlan {
  const progress = debtInstallmentProgress({ principalMinor: 100, currentRemainingMinor: 100, netSettledSinceRevisionMinor: 0,
    installments: [{ dueDate: "2026-10-01", amountMinor: 80, kind: "installment" }, { dueDate: "2026-11-01", amountMinor: 20, kind: "installment" }], today: "2026-10-26" });
  return { id: 9, patientId: 17, title: "علاج اصطناعي", status: "active", items: [], debtSource: "invoice", baseCurrency: "YER", installments: [],
    progress: { totalMinor: 1000, paidMinor: 900, remainingMinor: 100, dueToDateMinor: 80, overdueMinor: 80, nextDueDate: "2026-11-01", nextDueAmountMinor: 20, paidCount: 0, count: 2 },
    invoiceFinancial: { kind: "invoice_backed", invoiceIds: [1], paidMinor: 900, remainingMinor: 100, schedules: [{ id: 2, target: { patientId: 17, invoiceId: 1, openingCurrency: null, currency: "YER" }, version: 1, status: "active", requiresReview: false, progress }], message: null },
  } as unknown as TreatmentPlan;
}

describe("patient statement due-now uses verified canonical allocation rows", () => {
  it("does not subtract pre-revision receipts a second time from a revised installment principal", () => {
    const plan = invoicePlan();
    expect(planPosition(plan, "2026-10-26")).toEqual({ total: 1000, paid: 900, remaining: 100, due: 80 });
    expect(planPosition(plan, "2026-11-01")?.due).toBe(100);
  });
  it("includes today's unpaid installment once alongside overdue installments", () => {
    expect(planPosition(invoicePlan(), "2026-10-01")?.due).toBe(80);
  });
  it("withholds due-now when any invoice lacks a verified schedule, without inventing zero or treating all remaining as immediately due", () => {
    const plan = invoicePlan();
    plan.invoiceFinancial!.invoiceIds.push(7);
    expect(planPosition(plan, "2026-10-26")).toMatchObject({ total: 1000, remaining: 100, due: null });
    plan.invoiceFinancial!.invoiceIds = [1]; plan.invoiceFinancial!.schedules[0].requiresReview = true;
    expect(planPosition(plan, "2026-10-26")?.due).toBeNull();
  });
  it("passes approved agreement's own due-now through unchanged", () => {
    const plan = invoicePlan();
    plan.approvedAgreement = { planId: 9, currency: "YER", totalMinor: 5000, paidMinor: 1000, remainingMinor: 4000, dueNowMinor: 125, invoiceId: 1, openingCurrency: null, sourceKind: "invoice", available: true };
    expect(planPosition(plan, "2026-10-26")).toEqual({ total: 5000, paid: 1000, remaining: 4000, due: 125 });
    plan.approvedAgreement.available = false;
    expect(planPosition(plan, "2026-10-26")).toBeNull();
  });
  it("uses one captured clinic date for both the account and plan summary even if the clock crosses into a new due date", () => {
    const plan = invoicePlan();
    const snapshot = { ledger: { invoices: [{ id: 1, patientId: 17, status: "open", baseCurrency: "YER" } as Invoice], payments: [], openings: [] },
      plans: [plan], planCurrencies: new Map(), historicalAgreements: [], statementEvidence: emptyStatementEvidence() } satisfies Awaited<ReturnType<typeof patientStatementSnapshot>>;
    const zero = { billedMinor: 0, collectedMinor: 0, openingMinor: 0, dueMinor: 0 };
    const projected: PatientStatementProjection = { invoices: [], payments: [], openings: [], balances: {
      YER: { billedMinor: 1000, collectedMinor: 900, openingMinor: 0, dueMinor: 100 }, SAR: { ...zero }, USD: { ...zero },
    } };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    try {
      expect(statementDueNowByCurrency(snapshot, projected, "2026-10-26").YER).toBe(80);
      const document = assemblePatientStatement({ fullName: "اصطناعي", patientNumber: "SYN-17", phone: null }, SETTING_DEFAULTS,
        snapshot, projected, { type: "summary" }, "2026-11-01", "2026-10-26");
      expect(document.sections.find(section => section.title === "المستحق الآن حسب العملة")?.rows[0][1]).toBe("80 ر.ي");
      expect(document.sections.find(section => section.title === "أرصدة العلاجات والاتفاقات")?.rows[0].at(-1)).toBe("80 ر.ي");
    } finally { vi.useRealTimers(); }
  });
  it("shows zero only when verified remaining is paid or credited", () => {
    const plan = invoicePlan();
    plan.progress.remainingMinor = 0; plan.invoiceFinancial!.schedules = [];
    expect(planPosition(plan, "2026-10-26")?.due).toBe(0);
  });
});
