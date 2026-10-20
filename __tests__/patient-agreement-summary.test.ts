import { describe, expect, it } from "vitest";
import { patientAgreementSummary, hasPatientFinancialActivity } from "../lib/patient-agreement-summary";
import { planProgress } from "../lib/plans";

type Plan = Parameters<typeof patientAgreementSummary>[0][number];
const plan = (patch: Partial<Plan> = {}): Plan => ({ status: "active", baseCurrency: "SAR", totalMinor: 999999,
  progress: planProgress({ totalMinor: 999999, status: "active", installments: [] }, 0, "2026-10-19"),
  approvedAgreement: null, invoiceFinancial: null, debtSource: null, ...patch });
const approved = { planId: 1, currency: "SAR" as const, totalMinor: 150000, paidMinor: 50000, remainingMinor: 100000,
  dueNowMinor: 25000, invoiceId: 1, openingCurrency: null, sourceKind: "new", available: true };

describe("patient agreement read projection", () => {
  it("uses approved fields exclusively and retains completed approvals without mutation", () => {
    const input = [plan({ status: "completed", approvedAgreement: approved, debtSource: "approved_agreement" }), plan()];
    const before = JSON.stringify(input);
    expect(patientAgreementSummary(input, "SAR")).toEqual({ approvedAgreements: { count: 1, available: true, reviewCount: 0,
      totalMinor: 150000, paidMinor: 50000, remainingMinor: 100000, dueNowMinor: 25000 }, classicInstallments: null });
    expect(patientAgreementSummary(input, "YER")).toEqual({ approvedAgreements: null, classicInstallments: null });
    expect(JSON.stringify(input)).toBe(before);
  });

  it("never reports a partial settlement aggregate as complete when an approved source is unavailable", () => {
    const input = [plan({ approvedAgreement: approved }), plan({ approvedAgreement: { ...approved, planId: 2, available: false } })];
    expect(patientAgreementSummary(input, "SAR").approvedAgreements).toEqual({ count: 2, available: false, reviewCount: 1,
      totalMinor: 300000, paidMinor: null, remainingMinor: null, dueNowMinor: null });
  });

  it("uses classic source classification and excludes invoice-backed/review sources from the reference", () => {
    const classic = plan({ debtSource: "classic_installments" });
    const invoice = plan({ debtSource: "invoice" });
    const review = plan({ invoiceFinancial: { kind: "review_required", invoiceIds: [9], paidMinor: 0, remainingMinor: 0,
      progress: classic.progress, schedules: [], message: "Needs review" } });
    expect(patientAgreementSummary([classic, invoice, review, plan()], "SAR")).toEqual({ approvedAgreements: null,
      classicInstallments: { count: 1, totalMinor: 999999, paidMinor: 0, remainingMinor: 999999 } });
  });

  it("rejects unsafe approved aggregates rather than silently rounding money", () => {
    expect(() => patientAgreementSummary([plan({ approvedAgreement: { ...approved, totalMinor: Number.MAX_SAFE_INTEGER } }),
      plan({ approvedAgreement: approved })], "SAR")).toThrow(/safe minor units/);
  });

  it("keeps completed/review-only sources visible when active and ledger values are zero", () => {
    const bucket = { balanceMinor: 0, invoicedMinor: 0, paidMinor: 0, openingMinor: 0,
      agreedMinor: 0, treatmentDoneMinor: 0, remainingTreatmentMinor: 0,
      ...patientAgreementSummary([plan({ status: "completed", approvedAgreement: { ...approved, available: false } })], "SAR") };
    expect(hasPatientFinancialActivity(bucket)).toBe(true);
  });
});
