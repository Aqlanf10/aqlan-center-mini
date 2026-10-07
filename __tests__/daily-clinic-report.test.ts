import { describe, expect, it } from "vitest";
import { buildDailyClinicExpenseReport } from "../lib/daily-clinic-expense-report";
import { buildDailyClinicReport, isDailyClinicReportDate } from "../lib/daily-clinic-report-model";
import type { DailyClinicSource, DailyClinicSourcePayment, DailyClinicSourcePlan, DailyClinicSourceVisit } from "../lib/daily-clinic-report-types";

const date = "2026-10-07";
function visit(id = 1, patientId: number | null = 1): DailyClinicSourceVisit {
  return { id, patientId, patientNumber: patientId === null ? null : `P${patientId}`, patientName: `مريض تجريبي ${patientId ?? id}`,
    arrivedAt: "2026-10-07T08:00:00.000Z", signedAt: "2026-10-07T09:00:00.000Z", signedClinicDate: date,
    billingCurrency: "YER", treatmentDone: "علاج موثق", doctorName: "طبيب تجريبي", plannedPlanId: null };
}
function plan(id = 1, currency = "YER", totalMinor = 1000): DailyClinicSourcePlan {
  return { id, patientId: 1, title: `اتفاق ${id}`, status: "active", consentAt: "2026-10-01T09:00:00Z", currency, totalMinor, funded: true };
}
function payment(overrides: Partial<DailyClinicSourcePayment> = {}): DailyClinicSourcePayment {
  return { id: 1, patientId: 1, patientName: "مريض تجريبي 1", receiptNumber: "R1", invoiceId: null,
    planId: null, openingCurrency: null, currency: "YER", amountMinor: 200, baseAmountMinor: 200,
    exchangeRate: 1, kind: "payment", method: "cash", createdAt: "2026-10-07T09:30:00.000Z", clinicDate: date,
    reversalOfId: null, ...overrides };
}
function fixture(overrides: Partial<DailyClinicSource> = {}): DailyClinicSource {
  return { date, clinicTimeZone: "Asia/Aden", generatedAt: "2026-10-07T20:00:00.000Z", selectedDayCutoff: "2026-10-07T21:00:00.000Z",
    visits: [visit()], plans: [], items: [], work: [], invoices: [], payments: [], openings: [], additionalPlanLinks: [],
    expenses: buildDailyClinicExpenseReport([], { date, timeZone: "Asia/Aden" }), ...overrides };
}

describe("daily clinic report: arrival cohort and distinct money meanings", () => {
  it("includes unbilled attendees and unregistered walk-ins without guessing a financial identity", () => {
    const report = buildDailyClinicReport(fixture({ visits: [visit(), { ...visit(2, null), signedAt: null, signedClinicDate: null }] }));
    expect(report.totals.attendeesCount).toBe(2);
    expect(report.totals.pendingVisitsCount).toBe(1);
    expect(report.attendees[1].key).toBe("visit:2");
    expect(report.currentAccounts).toHaveLength(1);
    expect(report.attendees[1].agreement).toEqual({ YER: 0, SAR: 0, USD: 0 });
  });

  it("counts one shared agreement and patient debt only once across multiple visits", () => {
    const report = buildDailyClinicReport(fixture({ visits: [{ ...visit(), plannedPlanId: 1 }, { ...visit(2), plannedPlanId: 1 }],
      plans: [plan()], invoices: [{ id: 10, patientId: 1, currency: "YER", totalMinor: 400, discountMinor: 0, status: "open", planId: 1 }],
      payments: [payment({ planId: 1, invoiceId: 10 })], openings: [{ patientId: 1, currency: "YER", amountMinor: 300 }] }));
    expect(report.attendees).toHaveLength(1);
    expect(report.attendees[0].visitsCount).toBe(2);
    expect(report.totals.agreement.YER).toBe(1000);
    expect(report.totals.explicitlySettled.YER).toBe(200);
    expect(report.totals.agreementRemaining.YER).toBe(800);
    expect(report.totals.currentReceivable.YER).toBe(500);
    expect(report.agreements[0].paymentIds).toEqual([1]);
  });

  it("keeps unallocated receipts and patient opening credit out of agreement settlement", () => {
    const report = buildDailyClinicReport(fixture({ visits: [{ ...visit(), plannedPlanId: 1 }], plans: [plan()],
      payments: [payment()], openings: [{ patientId: 1, currency: "YER", amountMinor: -50 }] }));
    expect(report.totals.explicitlySettled.YER).toBe(0);
    expect(report.totals.agreementRemaining.YER).toBe(1000);
    expect(report.totals.currentCredit.YER).toBe(250);
    expect(report.currentAccounts[0].unallocatedPaymentIds).toEqual([1]);
  });

  it("keeps each currency independent and displays foreign tender separately from YER settlement", () => {
    const report = buildDailyClinicReport(fixture({ plans: [plan(), plan(2, "SAR", 5000), plan(3, "USD", 3000)],
      additionalPlanLinks: [1, 2, 3].map((planId) => ({ planId, patientId: 1, visitId: 1 })),
      payments: [payment({ planId: 1, currency: "USD", amountMinor: 100, baseAmountMinor: 500, exchangeRate: 500 }),
        payment({ id: 2, receiptNumber: "R2", planId: 2, currency: "SAR", amountMinor: 250, baseAmountMinor: 300, method: "transfer" })] }));
    expect(report.totals.agreement).toEqual({ YER: 1000, SAR: 5000, USD: 3000 });
    expect(report.totals.explicitlySettled).toEqual({ YER: 500, SAR: 250, USD: 0 });
    expect(report.totals.nativeReceipts).toEqual({ YER: 0, SAR: 250, USD: 100 });
    expect(report.totals.nativeTransferNetRecorded.SAR).toBe(250);
    expect(report.totals.nativeCashNetRecorded.USD).toBe(100);
    expect(report.receipts[0]).toMatchObject({ tenderCurrency: "USD", settlementCurrency: "YER", signedSettlementMinor: 500 });
  });

  it("preserves payment-only patients solely in clinicwide day movements", () => {
    const report = buildDailyClinicReport(fixture({ payments: [payment({ patientId: 2, patientName: "محصل بلا حضور" })] }));
    expect(report.attendees).toHaveLength(1);
    expect(report.receipts).toHaveLength(1);
    expect(report.receipts[0].attendee).toBe(false);
    expect(report.currentAccounts.map((row) => row.patientId)).toEqual([1]);
  });

  it("shows present account state honestly while the selected day excludes future movements", () => {
    const report = buildDailyClinicReport(fixture({ generatedAt: "2026-10-10T10:00:00Z",
      plans: [plan()], visits: [{ ...visit(), plannedPlanId: 1 }], payments: [payment(), payment({ id: 2, planId: 1,
        createdAt: "2026-10-08T10:00:00Z", clinicDate: "2026-10-08", amountMinor: 300, baseAmountMinor: 300 })] }));
    expect(report.basis.account).toBe("current_at_generation");
    expect(report.receipts.map((row) => row.id)).toEqual([1]);
    expect(report.totals.explicitlySettled.YER).toBe(300);
    expect(report.totals.currentCredit.YER).toBe(500);
    expect(report.warnings[0]).toContain("ليست أرصدة تاريخية");
  });

  it("shows later-day reversal as its own signed movement without asserting a physical cash refund", () => {
    const report = buildDailyClinicReport(fixture({ payments: [payment({ createdAt: "2026-10-06T10:00:00Z", clinicDate: "2026-10-06" }),
      payment({ id: 2, kind: "refund", reversalOfId: 1, amountMinor: 50, baseAmountMinor: 50 })] }));
    expect(report.receipts).toHaveLength(1);
    expect(report.receipts[0].reversalOfId).toBe(1);
    expect(report.totals.nativeReversals.YER).toBe(50);
    expect(report.totals.nativeNetRecorded.YER).toBe(-50);
    expect(report.totals.currentCredit.YER).toBe(150);
  });

  it("excludes cancelled/draft agreements from principal and remainder totals", () => {
    const report = buildDailyClinicReport(fixture({ plans: [{ ...plan(), consentAt: null }, { ...plan(2), status: "cancelled" }],
      additionalPlanLinks: [1, 2].map((planId) => ({ planId, patientId: 1, visitId: 1 })) }));
    expect(report.agreements).toHaveLength(2);
    expect(report.agreements.every((row) => row.remainingMinor === null)).toBe(true);
    expect(report.attendees[0].excludedAgreementCount).toBe(2);
    expect(report.totals.agreement.YER).toBe(0);
  });
});

describe("daily clinic report: recorded work and incomplete valuation", () => {
  const procedure = { sourceType: "procedure" as const, id: 1, visitId: 1, patientId: 1,
    description: "علاج عصب", quantity: 1, toothCode: 16, doctorName: "طبيب", planId: 1, planItemId: 1, unitPriceMinor: 0 };
  const item = { id: 1, planId: 1, serviceName: "علاج عصب", quantity: 1, unitPriceMinor: 1000,
    status: "in_progress", visitId: null, doneAt: null, doneClinicDate: null };

  it("reports included partial sessions as work, never zero-valued treatment or fractional contract recognition", () => {
    const report = buildDailyClinicReport(fixture({ plans: [plan()], items: [item], work: [procedure] }));
    expect(report.work[0]).toMatchObject({ classification: "included", valueMinor: null, currency: "YER" });
    expect(report.totals.knownCompletedValue.YER).toBe(0);
    expect(report.totals.unvaluedWorkCount).toBe(1);
  });

  it("values a priced item once only at documented full completion with reconciled agreement pricing", () => {
    const report = buildDailyClinicReport(fixture({ plans: [plan()],
      items: [{ ...item, status: "done", visitId: 1, doneAt: "2026-10-07T09:00:00Z", doneClinicDate: date }],
      work: [procedure, { ...procedure, id: 2 }] }));
    expect(report.totals.knownCompletedValue.YER).toBe(1000);
    expect(report.work.filter((row) => row.valuationBasis === "completed_plan_item")).toHaveLength(1);
    expect(report.work[1].valueMinor).toBeNull();
    expect(report.work[1].valuationBasis).toBe("included_in_completed_item");
    expect(report.totals.unvaluedWorkCount).toBe(0);
  });

  it("does not invent value when item prices differ from the lump-sum contract", () => {
    const report = buildDailyClinicReport(fixture({ plans: [plan(1, "YER", 800)],
      items: [{ ...item, status: "done", visitId: 1, doneAt: "2026-10-07T09:00:00Z", doneClinicDate: date }], work: [procedure] }));
    expect(report.work[0].valueMinor).toBeNull();
    expect(report.work[0].unvaluedReason).toContain("لا تطابق");
  });

  it("uses signed standalone recorded price, explicitly before invoice discounts", () => {
    const report = buildDailyClinicReport(fixture({ work: [{ ...procedure, planId: null, planItemId: null, unitPriceMinor: 700, quantity: 2 }] }));
    expect(report.work[0]).toMatchObject({ valueMinor: 1400, valuationBasis: "recorded_procedure_price" });
    expect(report.totals.agreement.YER).toBe(0);
    expect(report.warnings.join(" ")).toContain("قبل خصم الفاتورة");
  });

  it("does not mistake chair done or a later signature for work verified at day cutoff", () => {
    const report = buildDailyClinicReport(fixture({ generatedAt: "2026-10-09T10:00:00Z",
      visits: [{ ...visit(), signedAt: null, signedClinicDate: null },
        { ...visit(2), signedAt: "2026-10-08T10:00:00Z", signedClinicDate: "2026-10-08" }],
      work: [{ ...procedure, planId: null, planItemId: null, unitPriceMinor: 700 }] }));
    expect(report.work).toEqual([]);
    expect(report.totals.pendingVisitsCount).toBe(2);
    expect(report.totals.lateSignedVisitsCount).toBe(1);
  });

  it("retains signed narrative-only and orthodontic work with unknown price", () => {
    const report = buildDailyClinicReport(fixture({ visits: [visit(), visit(2)], work: [{
      ...procedure, sourceType: "ortho_adjustment", visitId: 2, planId: null, planItemId: null, unitPriceMinor: null,
    }] }));
    expect(report.work.map((row) => row.sourceType)).toEqual(["ortho_adjustment", "clinical_note"]);
    expect(report.totals.unvaluedWorkCount).toBe(2);
  });
});

describe("daily clinic report: fail closed", () => {
  it.each(["0000-01-01", "2026-02-30", "2026-13-01", "", "26-01-01"])("rejects invalid calendar date %s", (value) => {
    expect(isDailyClinicReportDate(value)).toBe(false);
  });
  it("accepts leap day and rejects its non-leap equivalent", () => {
    expect(isDailyClinicReportDate("2024-02-29")).toBe(true);
    expect(isDailyClinicReportDate("2025-02-29")).toBe(false);
  });
  it("rejects cross-patient invoice and plan references", () => {
    expect(() => buildDailyClinicReport(fixture({ invoices: [{ id: 10, patientId: 2, currency: "YER", totalMinor: 1000, discountMinor: 0, status: "open", planId: null }], payments: [payment({ invoiceId: 10 })] }))).toThrow();
    expect(() => buildDailyClinicReport(fixture({ plans: [{ ...plan(), patientId: 2 }], payments: [payment({ planId: 1 })] }))).toThrow();
  });
  it("does not expose an untrusted foreign plan-item title or substitute a visit doctor", () => {
    const foreign = fixture({ plans: [{ ...plan(), patientId: 2 }],
      items: [{ id: 4, planId: 1, serviceName: "FOREIGN-PRIVATE-TITLE", quantity: 1, unitPriceMinor: 1000,
        status: "planned", visitId: null, doneAt: null, doneClinicDate: null }],
      work: [{ sourceType: "procedure", id: 1, visitId: 1, patientId: 1, description: "FOREIGN-PRIVATE-TITLE",
        quantity: 1, toothCode: 16, doctorName: null, planId: 1, planItemId: 4, unitPriceMinor: 0 }] });
    expect(() => buildDailyClinicReport(foreign)).toThrow();
    const own = fixture({ work: [{ sourceType: "procedure", id: 1, visitId: 1, patientId: 1, description: "Signed work",
      quantity: 1, toothCode: 16, doctorName: null, planId: null, planItemId: null, unitPriceMinor: 0 }] });
    expect(buildDailyClinicReport(own).work[0].doctorName).toBeNull();
  });
  it("rejects conflicting dual targets and unsupported foreign-to-foreign settlement", () => {
    expect(() => buildDailyClinicReport(fixture({ plans: [plan(), plan(2)], invoices: [{ id: 10, patientId: 1, currency: "YER", totalMinor: 1000, discountMinor: 0, status: "open", planId: 2 }], payments: [payment({ invoiceId: 10, planId: 1 })] }))).toThrow();
    expect(() => buildDailyClinicReport(fixture({ plans: [plan(1, "SAR")], payments: [payment({ planId: 1, currency: "USD" })] }))).toThrow();
  });
  it("rejects unknown currency, source fanout and unsafe aggregate amounts", () => {
    expect(() => buildDailyClinicReport(fixture({ plans: [plan(1, "EUR")] }))).toThrow();
    expect(() => buildDailyClinicReport(fixture({ visits: [visit(), visit()] }))).toThrow();
    expect(() => buildDailyClinicReport(fixture({ payments: [payment({ amountMinor: Number.MAX_SAFE_INTEGER }), payment({ id: 2 })] }))).toThrow();
  });
  it("rejects historical settlement overflow even when a later reversal leaves a safe-looking result", () => {
    const historic = { createdAt: "2026-10-01T10:00:00Z", clinicDate: "2026-10-01" };
    expect(() => buildDailyClinicReport(fixture({ payments: [
      payment({ ...historic, amountMinor: Number.MAX_SAFE_INTEGER, baseAmountMinor: Number.MAX_SAFE_INTEGER }),
      payment({ ...historic, id: 2, amountMinor: 2, baseAmountMinor: 2 }),
      payment({ ...historic, id: 3, kind: "refund", reversalOfId: 1, amountMinor: Number.MAX_SAFE_INTEGER, baseAmountMinor: Number.MAX_SAFE_INTEGER }),
    ] }))).toThrow("aggregate");
  });
  it("rejects opening plus billed overflow before a large settlement can conceal lost precision", () => {
    expect(() => buildDailyClinicReport(fixture({
      openings: [{ patientId: 1, currency: "YER", amountMinor: Number.MAX_SAFE_INTEGER }],
      invoices: [{ id: 4, patientId: 1, currency: "YER", totalMinor: 2, discountMinor: 0, status: "open", planId: null }],
      payments: [payment({ amountMinor: Number.MAX_SAFE_INTEGER, baseAmountMinor: Number.MAX_SAFE_INTEGER,
        createdAt: "2026-10-01T10:00:00Z", clinicDate: "2026-10-01" })],
    }))).toThrow("opening plus billed");
  });
  it("returns a truthful empty day with three currency zeroes", () => {
    const report = buildDailyClinicReport(fixture({ visits: [] }));
    expect(report.attendees).toEqual([]);
    expect(report.currentAccounts).toEqual([]);
    expect(report.totals.agreement).toEqual({ YER: 0, SAR: 0, USD: 0 });
  });
});
