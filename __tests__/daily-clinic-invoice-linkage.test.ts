import { describe, expect, it } from "vitest";
import { buildDailyClinicExpenseReport } from "../lib/daily-clinic-expense-report";
import { buildDailyClinicReport } from "../lib/daily-clinic-report-model";
import type {
  DailyClinicSource, DailyClinicSourceInvoice, DailyClinicSourceInvoiceLine, DailyClinicSourceLegacyAgreement,
  DailyClinicSourcePayment, DailyClinicSourcePlan, DailyClinicSourceVisit,
} from "../lib/daily-clinic-report-types";

// (INV-LINK REPORT) Synthetic, deterministic sources only.
const date = "2026-10-07";
const visit = (id = 1, patientId = 1): DailyClinicSourceVisit => ({
  id, patientId, patientNumber: `P${patientId}`, patientName: `مريض اصطناعي ${patientId}`,
  arrivedAt: "2026-10-07T08:00:00.000Z", signedAt: "2026-10-07T09:00:00.000Z", signedClinicDate: date,
  billingCurrency: "YER", treatmentDone: "علاج موثق", doctorName: null, plannedPlanId: null,
});
const plan = (overrides: Partial<DailyClinicSourcePlan> = {}): DailyClinicSourcePlan => ({
  id: 1, patientId: 1, title: "خطة من فاتورة", status: "active", consentAt: null, currency: "YER", totalMinor: 150000,
  funded: false, invoiceLinked: true, ...overrides,
});
const invoice = (overrides: Partial<DailyClinicSourceInvoice> = {}): DailyClinicSourceInvoice => ({
  id: 10, patientId: 1, currency: "YER", totalMinor: 150000, discountMinor: 0, status: "open", planId: null,
  invoiceNumber: "INV-10", createdAt: "2026-10-07T08:10:00.000Z", clinicDate: date, ...overrides,
});
const line = (overrides: Partial<DailyClinicSourceInvoiceLine> = {}): DailyClinicSourceInvoiceLine => ({
  id: 100, invoiceId: 10, description: "علاج عصب — سن 36", totalMinor: 150000, planItemId: 1000, planId: 1, caseId: 500,
  toothCode: 36, ...overrides,
});
const payment = (overrides: Partial<DailyClinicSourcePayment> = {}): DailyClinicSourcePayment => ({
  id: 1, patientId: 1, patientName: "مريض اصطناعي 1", receiptNumber: "R1", invoiceId: 10, planId: null, openingCurrency: null,
  currency: "YER", amountMinor: 50000, baseAmountMinor: 50000, exchangeRate: 1, kind: "payment", method: "cash",
  createdAt: "2026-10-07T08:20:00.000Z", clinicDate: date, reversalOfId: null, ...overrides,
});
const legacy = (overrides: Partial<DailyClinicSourceLegacyAgreement> = {}): DailyClinicSourceLegacyAgreement => ({
  id: 70, patientId: 1, serviceName: "تقويم بدأ قبل النظام", specialty: "orthodontics", toothCode: null,
  coverageTeeth: [], coverageScope: "both", coverageRecorded: true, currency: "YER",
  agreedMinor: 300000, previouslyPaidMinor: 120000, remainingMinor: 180000, historicalAsOf: "2026-01-15",
  status: "live", voidReason: null, planItemId: 2000, caseId: 600, ...overrides,
});
const source = (overrides: Partial<DailyClinicSource> = {}): DailyClinicSource => ({
  date, clinicTimeZone: "Asia/Aden", generatedAt: "2026-10-07T20:00:00.000Z", selectedDayCutoff: "2026-10-07T21:00:00.000Z",
  visits: [visit()], plans: [], items: [], work: [], invoices: [], invoiceLines: [], invoiceCorrections: [], legacyAgreements: [],
  payments: [], openings: [], additionalPlanLinks: [],
  expenses: buildDailyClinicExpenseReport([], { date, timeZone: "Asia/Aden" }), ...overrides,
});

describe("daily clinic report — invoice-first linkage", () => {
  it("shows an invoice-first agreement without clinical consent instead of hiding it, and its invoice once with explicit receipts", () => {
    const report = buildDailyClinicReport(source({
      visits: [{ ...visit(), plannedPlanId: 1 }], plans: [plan()],
      items: [{ id: 1000, planId: 1, serviceName: "علاج عصب", quantity: 1, unitPriceMinor: 150000, status: "planned", visitId: null, doneAt: null, doneClinicDate: null }],
      invoices: [invoice()], invoiceLines: [line()], payments: [payment()],
    }));
    expect(report.agreements).toHaveLength(1);
    expect(report.agreements[0].includedInTotals).toBe(false);
    expect(report.agreements[0].excludedReason).toContain("اتفاق مالي بفاتورة");
    expect(report.agreements[0].excludedReason).not.toBe("خطة بلا موافقة موثقة");
    expect(report.invoices).toHaveLength(1);
    const [row] = report.invoices;
    expect(row.reasons).toEqual(["issued_today", "receipt_today", "linked_to_day_agreement"]);
    expect(row.linkage).toBe("single_plan_item");
    expect(row.lines[0]).toMatchObject({ planItemId: 1000, planId: 1, caseId: 500, toothCode: 36 });
    expect(row.explicitPaymentIds).toEqual([1]);
    expect(row.explicitlySettledMinor).toBe(50000);
    expect(row.remainingMinor).toBe(100000);
    // The plan totals do not count the same money a second time.
    expect(report.totals.agreement.YER).toBe(0);
    expect(report.totals.invoicesIssuedNet.YER).toBe(150000);
    expect(report.totals.currentReceivable.YER).toBe(100000);
  });

  it("does not depend on invoices.plan_id: a line link alone ties the invoice to the day's agreement", () => {
    const report = buildDailyClinicReport(source({
      visits: [{ ...visit(), plannedPlanId: 1 }], plans: [plan()],
      invoices: [invoice({ createdAt: "2026-09-01T08:00:00.000Z", clinicDate: "2026-09-01" })], invoiceLines: [line()],
    }));
    expect(report.invoices.map((row) => [row.id, row.reasons])).toEqual([[10, ["linked_to_day_agreement"]]]);
    expect(report.totals.invoicesIssuedNet.YER).toBe(0);
  });

  it("keeps a mixed invoice whole: receipts are never estimated per case", () => {
    const report = buildDailyClinicReport(source({
      plans: [plan(), plan({ id: 2, title: "خطة ثانية" })],
      invoices: [invoice({ totalMinor: 200000 })],
      invoiceLines: [line(), line({ id: 101, planItemId: 1001, planId: 2, caseId: 501, toothCode: 14, totalMinor: 30000 }),
        line({ id: 102, planItemId: null, planId: null, caseId: null, toothCode: null, description: "استشارة", totalMinor: 20000 })],
      payments: [payment({ amountMinor: 80000, baseAmountMinor: 80000 })],
    }));
    const [row] = report.invoices;
    expect(row.linkage).toBe("mixed");
    expect(row.explicitlySettledMinor).toBe(80000);
    expect(report.agreements).toEqual([]);
    expect(report.warnings.join(" ")).toContain("لا توزع تقديريًا على الحالات");
  });

  it("shows a cancelled invoice and its stored correction, and never invents one without audit evidence", () => {
    const report = buildDailyClinicReport(source({ plans: [plan()],
      invoices: [invoice({ id: 9, invoiceNumber: "INV-9", status: "cancelled", totalMinor: 180000 }), invoice(),
        invoice({ id: 11, invoiceNumber: "INV-11", status: "cancelled", totalMinor: 5000 })],
      invoiceLines: [line({ id: 90, invoiceId: 9, totalMinor: 180000 }), line(), line({ id: 110, invoiceId: 11, totalMinor: 5000, planItemId: null, planId: null, caseId: null })],
      invoiceCorrections: [{ originalInvoiceId: 9, correctedInvoiceNumber: "INV-10", reason: "سعر خاطئ", at: "2026-10-07T08:09:00.000Z", actor: "synthetic-admin" }],
    }));
    const byId = new Map(report.invoices.map((row) => [row.id, row]));
    expect(byId.get(9)).toMatchObject({ status: "cancelled", netMinor: 0, remainingMinor: 0 });
    expect(byId.get(9)!.corrections).toEqual([expect.objectContaining({ correctedInvoiceNumber: "INV-10", reason: "سعر خاطئ" })]);
    expect(byId.get(10)!.correctsInvoiceNumbers).toEqual(["INV-9"]);
    expect(byId.get(11)!.corrections).toEqual([]);
    expect(byId.get(11)!.correctsInvoiceNumbers).toEqual([]);
    expect(report.totals.cancelledInvoicesCount).toBe(2);
    expect(report.totals.invoicesIssuedNet.YER).toBe(150000);
    expect(report.totals.invoicesIssuedCount).toBe(1);
  });

  it("keeps each currency separate in invoice totals", () => {
    const report = buildDailyClinicReport(source({ plans: [plan()],
      invoices: [invoice(), invoice({ id: 12, invoiceNumber: "INV-12", currency: "SAR", totalMinor: 9000 }),
        invoice({ id: 13, invoiceNumber: "INV-13", currency: "USD", totalMinor: 4000, discountMinor: 500 })],
      invoiceLines: [line(), line({ id: 120, invoiceId: 12, planItemId: null, planId: null, caseId: null, totalMinor: 9000 }),
        line({ id: 130, invoiceId: 13, planItemId: null, planId: null, caseId: null, totalMinor: 4000 })],
    }));
    expect(report.totals.invoicesIssuedNet).toEqual({ YER: 150000, SAR: 9000, USD: 3500 });
  });

  it("refuses a line that points at another patient's plan", () => {
    expect(() => buildDailyClinicReport(source({
      plans: [plan({ patientId: 2 })], invoices: [invoice()], invoiceLines: [line()],
    }))).toThrow("Unresolved or cross-patient agreement link");
  });
});

describe("daily clinic report — treatment started before the system", () => {
  it("300000 agreed / 120000 paid before → 180000 opening only; the prior payment is not today's collection and the remainder is not added twice", () => {
    const report = buildDailyClinicReport(source({
      legacyAgreements: [legacy()], openings: [{ patientId: 1, currency: "YER", amountMinor: 180000 }],
    }));
    expect(report.legacyAgreements).toEqual([expect.objectContaining({
      agreedMinor: 300000, previouslyPaidMinor: 120000, remainingAtStartMinor: 180000, historicalAsOf: "2026-01-15", currency: "YER",
    })]);
    expect(report.totals.nativeReceipts).toEqual({ YER: 0, SAR: 0, USD: 0 });
    expect(report.totals.explicitlySettled.YER).toBe(0);
    expect(report.totals.currentReceivable.YER).toBe(180000);
    expect(report.receipts).toEqual([]);
    expect(report.warnings.join(" ")).toContain("المدفوع قبل النظام ليس تحصيل اليوم");
  });

  it("shows coverage as recorded or as needing review, and keeps voided agreements visible with their reason", () => {
    const report = buildDailyClinicReport(source({
      legacyAgreements: [legacy({ id: 71, coverageRecorded: false, coverageTeeth: null, coverageScope: null }),
        legacy({ id: 72, status: "void", voidReason: "إدخال مكرر" })],
    }));
    expect(report.legacyAgreements.map((row) => [row.id, row.coverageRecorded, row.status, row.voidReason]))
      .toEqual([[71, false, "live", null], [72, true, "void", "إدخال مكرر"]]);
  });

  it("rejects inconsistent historical arithmetic rather than displaying it", () => {
    expect(() => buildDailyClinicReport(source({ legacyAgreements: [legacy({ remainingMinor: 170000 })] })))
      .toThrow("Legacy agreement arithmetic");
  });
});

describe("daily clinic report — recorded visit links, installment plans and currency (Dot review 5450750803)", () => {
  const old = { createdAt: "2026-09-01T08:00:00.000Z", clinicDate: "2026-09-01" };
  it("includes an older invoice recorded on today's visit (visits.invoice_id), once, without counting it as issued today", () => {
    const report = buildDailyClinicReport(source({
      visits: [{ ...visit(), invoiceId: 10 }], invoices: [invoice(old)],
      invoiceLines: [line({ planItemId: null, planId: null, caseId: null, toothCode: null })],
    }));
    expect(report.invoices.map((row) => [row.id, row.reasons])).toEqual([[10, ["attached_to_day_visit"]]]);
    expect(report.totals.invoicesIssuedNet.YER).toBe(0);
  });

  it("includes an older invoice whose line is sourced from a procedure of today's visit", () => {
    const report = buildDailyClinicReport(source({
      invoices: [invoice(old)],
      invoiceLines: [line({ planItemId: null, planId: null, caseId: null, toothCode: null, sourceType: "visit_procedure", sourceId: 77, sourceVisitId: 1, sourceVisitPatientId: 1 })],
    }));
    expect(report.invoices.map((row) => row.reasons)).toEqual([["line_from_day_visit"]]);
    // Dot review 5461818993: labelled by its clinical source, not as a bare financial invoice.
    expect(report.invoices[0].linkage).toBe("visit_procedures");
    expect(report.invoices[0].lines.map((one) => one.sourceVisitId)).toEqual([1]);
  });

  it("labels a visit-procedure line beside a bare financial line as mixed, and a plain unsourced line as financial only", () => {
    const procedure = line({ id: 1, planItemId: null, planId: null, caseId: null, toothCode: null, sourceType: "visit_procedure", sourceId: 77, sourceVisitId: 1, sourceVisitPatientId: 1 });
    const bare = line({ id: 2, planItemId: null, planId: null, caseId: null, toothCode: null });
    const mixed = buildDailyClinicReport(source({ invoices: [invoice()], invoiceLines: [procedure, bare] }));
    expect(mixed.invoices[0].linkage).toBe("mixed");
    expect(mixed.invoices[0].lines.map((one) => one.sourceVisitId)).toEqual([1, null]);
    const plain = buildDailyClinicReport(source({ invoices: [invoice()], invoiceLines: [bare] }));
    expect(plain.invoices[0].linkage).toBe("financial_only");
  });

  it("does not infer today's work from an unrelated past invoice", () => {
    const report = buildDailyClinicReport(source({ invoices: [invoice(old)], invoiceLines: [line({ planItemId: null, planId: null, caseId: null })] }));
    expect(report.invoices).toEqual([]);
  });

  it("fails closed on a visit invoice or a line source that belongs to another patient", () => {
    expect(() => buildDailyClinicReport(source({ visits: [{ ...visit(), invoiceId: 10 }], invoices: [invoice({ ...old, patientId: 2 })], invoiceLines: [] })))
      .toThrow("Unresolved or cross-patient visit invoice");
    expect(() => buildDailyClinicReport(source({ invoices: [invoice(old)],
      invoiceLines: [line({ planItemId: null, planId: null, caseId: null, sourceType: "visit_procedure", sourceId: 77, sourceVisitId: 1, sourceVisitPatientId: 2 })] })))
      .toThrow("Cross-patient invoice line source");
  });

  it("refuses a same-patient line that ties the invoice to a plan in another currency", () => {
    expect(() => buildDailyClinicReport(source({ plans: [plan({ currency: "SAR" })], invoices: [invoice()], invoiceLines: [line()] })))
      .toThrow("Invoice line plan currency conflict");
  });

  it("labels an invoice linked only through invoices.plan_id as a plan installment, not as treatment work", () => {
    const report = buildDailyClinicReport(source({ plans: [plan()],
      invoices: [invoice({ planId: 1 })], invoiceLines: [line({ planItemId: null, planId: null, caseId: null, toothCode: null })] }));
    expect(report.invoices[0].linkage).toBe("plan_installment");
  });

  it("shows the recorded original net and an excess settlement separately, never as patient debt", () => {
    const report = buildDailyClinicReport(source({ plans: [plan()],
      invoices: [invoice({ status: "cancelled" }), invoice({ id: 12, invoiceNumber: "INV-12", totalMinor: 40000 })],
      invoiceLines: [line(), line({ id: 120, invoiceId: 12, planItemId: null, planId: null, caseId: null, totalMinor: 40000 })],
      payments: [payment({ id: 3, invoiceId: 12, amountMinor: 50000, baseAmountMinor: 50000 })] }));
    const byId = new Map(report.invoices.map((row) => [row.id, row]));
    expect(byId.get(10)).toMatchObject({ netMinor: 0, originalNetMinor: 150000, remainingMinor: 0, excessSettledMinor: 0 });
    expect(byId.get(12)).toMatchObject({ netMinor: 40000, explicitlySettledMinor: 50000, remainingMinor: 0, excessSettledMinor: 10000 });
  });
});

describe("daily clinic report — legacy agreements' current effect and coverage", () => {
  it("states the remaining's current effect: inside the opening when live, removed when void, none when settled historically", () => {
    const report = buildDailyClinicReport(source({ legacyAgreements: [
      legacy({ id: 80, openingEffect: "created" }),
      legacy({ id: 81, status: "void", voidReason: "إدخال مكرر", openingEffect: "created" }),
      legacy({ id: 82, previouslyPaidMinor: 300000, remainingMinor: 0, openingEffect: "none" }),
    ] }));
    expect(report.legacyAgreements.map((row) => [row.id, row.remainingAtStartMinor, row.currentOpeningEffect]))
      .toEqual([[80, 180000, "in_opening"], [81, 180000, "removed_by_void"], [82, 0, "none"]]);
    expect(report.warnings.join(" ")).toContain("أُزيل من الرصيد عند الإبطال");
  });

  it("rejects an opening effect that contradicts the remaining", () => {
    expect(() => buildDailyClinicReport(source({ legacyAgreements: [legacy({ openingEffect: "none" })] })))
      .toThrow("Legacy opening effect conflict");
  });

  it("carries the canonical coverage state and label; unknown or conflicting coverage stays review-needed", () => {
    const report = buildDailyClinicReport(source({ legacyAgreements: [
      legacy({ id: 83, coverageState: "verified", coverageLabel: "سن 36 · الأسطح: إنسي (M)، إطباقي (O)" }),
      legacy({ id: 84, coverageRecorded: true, coverageState: "conflict", coverageLabel: null }),
    ] }));
    expect(report.legacyAgreements.map((row) => [row.coverageState, row.coverageLabel]))
      .toEqual([["verified", "سن 36 · الأسطح: إنسي (M)، إطباقي (O)"], ["conflict", null]]);
  });
});
