import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), buildReport: vi.fn(), getPatient: vi.fn(),
  patientLedger: vi.fn(), getSettingsSafe: vi.fn(), patientPlanCurrencies: vi.fn(), listPatientPlans: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/reports", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/reports")>(), buildReport: mocks.buildReport }));
vi.mock("@/lib/db", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/db")>(),
  getPatient: mocks.getPatient, patientLedger: mocks.patientLedger, getSettingsSafe: mocks.getSettingsSafe,
  patientPlanCurrencies: mocks.patientPlanCurrencies, listPatientPlans: mocks.listPatientPlans,
  // The current print reads the same sources in one snapshot; here it composes the same mocks.
  patientStatementSnapshot: async (id: number, today: string) => ({ ledger: await mocks.patientLedger(id),
    planCurrencies: await mocks.patientPlanCurrencies(id), plans: await mocks.listPatientPlans(id, today), historicalAgreements: [] }) }));
vi.mock("@/components/PrintHeader", () => ({ PrintHeader: ({ title }: { title: string }) => createElement("h1", null, title), PrintFooter: () => null }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));
import StatementPage from "../app/print/statement/[id]/page";
import { PrintableReportDocument } from "../components/reports/PrintableReportDocument";
import { SETTING_DEFAULTS } from "../lib/settings";
import { DataTable } from "../components/reports/shared";
import { applyReportView, moneyTotalsByCurrency, EMPTY_REPORT_VIEW } from "../lib/report-view";
import { formatMoney } from "../lib/money";
import type { ReportResult } from "../lib/reports-types";
import { ReportInputError } from "../lib/reports";

function run(query?: Record<string, string | string[] | undefined>, id = "17") {
  return StatementPage({ params: Promise.resolve({ id }), ...(query ? { searchParams: Promise.resolve(query) } : {}) });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ role: "admin", username: "synthetic", userId: 1 });
  mocks.getSettingsSafe.mockResolvedValue({});
  mocks.getPatient.mockResolvedValue({ id: 17, fullName: "Synthetic patient", patientNumber: "SYN-17" });
  mocks.patientLedger.mockResolvedValue({ invoices: [], payments: [], openings: [] });
  mocks.patientPlanCurrencies.mockResolvedValue(new Map());
  mocks.listPatientPlans.mockResolvedValue([]);
  mocks.buildReport.mockResolvedValue({ report: "patient-statement", title: "كشف حساب المريض", subtitle: "Synthetic patient — SYN-17",
    periodLabel: "من فتح الملف حتى 30/09/2026", from: "2026-09-01", to: "2026-09-30", baseCurrency: "YER",
    filtersLabel: "جميع العملات", kpis: [], rows: [], columns: [] });
});

describe("existing statement print with an explicit cutoff", () => {
  it("keeps its existing role gate before any report or patient reads", async () => {
    for (const role of ["doctor", "assistant", null]) {
      mocks.session.mockResolvedValue(role ? { role, username: "synthetic", permissions: { canViewPatientPayments: true } } : null);
      await expect(run({ to: "2026-09-30" })).rejects.toThrow();
    }
    expect(mocks.buildReport).not.toHaveBeenCalled();
    expect(mocks.patientLedger).not.toHaveBeenCalled();
    expect(mocks.getPatient).not.toHaveBeenCalled();
  });

  it.each(["admin", "reception", "cashier", "accountant"])("preserves existing %s access to one patient and uses the canonical report", async (role) => {
    mocks.session.mockResolvedValue({ role, username: "synthetic", userId: 1 });
    const html = renderToStaticMarkup(await run({ from: "2026-09-01", to: "2026-09-30", patientId: "17", currency: "SAR", doctorId: "92" }));
    expect(mocks.buildReport).toHaveBeenCalledWith("patient-statement", expect.objectContaining({ patientId: 17,
      preset: "custom", from: "2026-09-01", to: "2026-09-30", currency: "all", doctorId: null, patientStatus: "all" }));
    expect(html).toContain("30/09/2026");
    expect(html).toContain("SYN-17");
    expect(html).toContain("جميع العملات");
    expect(mocks.patientLedger).not.toHaveBeenCalled();
    expect(mocks.listPatientPlans).not.toHaveBeenCalled();
  });

  it.each([
    { to: "2026-02-30" }, { to: "2026-13-01" }, { to: "0000-01-01" }, { to: "bad" }, { to: "" },
    { to: ["2026-09-30", "2026-10-01"] }, { from: "2026-09-01" }, { from: "2026-10-01", to: "2026-09-30" },
    { from: "2026-02-30", to: "2026-09-30" }, { from: ["2026-09-01"], to: "2026-09-30" },
    { patientId: "18", to: "2026-09-30" }, { patientId: ["17"], to: "2026-09-30" },
  ])("fails closed for malformed or conflicting query %j", async (query) => {
    await expect(run(query)).rejects.toThrow();
    expect(mocks.buildReport).not.toHaveBeenCalled();
    expect(mocks.patientLedger).not.toHaveBeenCalled();
  });

  it("accepts a real leap day and a cutoff without a lower-bound filter", async () => {
    await run({ to: "2024-02-29" });
    expect(mocks.buildReport).toHaveBeenCalledWith("patient-statement", expect.objectContaining({ from: "2024-02-29", to: "2024-02-29" }));
  });

  it("retains the current all-history statement when no cutoff was supplied", async () => {
    const html = renderToStaticMarkup(await run());
    expect(html).toContain("Synthetic patient");
    expect(mocks.buildReport).not.toHaveBeenCalled();
    expect(mocks.patientLedger).toHaveBeenCalledWith(17);
    expect(mocks.patientPlanCurrencies).toHaveBeenCalledWith(17);
    expect(mocks.listPatientPlans).toHaveBeenCalledWith(17, expect.any(String));
  });

  it("keeps closing balances visible without summing running balances in the official print", async () => {
    const result: ReportResult = { ...(await mocks.buildReport()),
      kpis: [{ key: "balance", label: "الرصيد المتبقي", minor: 700, currency: "YER" },
        { key: "balance-SAR", label: "الرصيد المتبقي (SAR)", minor: 50, currency: "SAR" }],
      columns: [{ key: "currency", label: "العملة" }, { key: "description", label: "البيان" },
        { key: "debitMinor", label: "مدين", type: "money", currencyKey: "currency" },
        { key: "creditMinor", label: "دائن", type: "money", currencyKey: "currency" },
        { key: "balanceMinor", label: "الرصيد", type: "money", currencyKey: "currency", aggregate: "none" }],
      rows: [
        { currency: "YER", description: "Opening", debitMinor: 100, creditMinor: 0, balanceMinor: 100 },
        { currency: "YER", description: "Invoice", debitMinor: 900, creditMinor: 0, balanceMinor: 1000 },
        { currency: "YER", description: "Payment", debitMinor: 0, creditMinor: 300, balanceMinor: 700 },
        { currency: "SAR", description: "Opening", debitMinor: 100, creditMinor: 0, balanceMinor: 100 },
        { currency: "SAR", description: "Payment", debitMinor: 0, creditMinor: 50, balanceMinor: 50 },
      ] };
    mocks.buildReport.mockResolvedValue(result);
    const html = renderToStaticMarkup(await run({ to: "2026-09-30" }));
    expect(html).toContain(formatMoney(700, "YER"));
    expect(html).toContain(formatMoney(50, "SAR"));
    expect(html).toContain("report-total-row");
    expect(html.match(/<tfoot>([\s\S]*?)<\/tfoot>/)?.[1]).toMatch(/<td class="num"><\/td><\/tr>/);
    expect(html).not.toContain(formatMoney(1800, "YER"));
    const grouped = renderToStaticMarkup(createElement(PrintableReportDocument, { result, settings: SETTING_DEFAULTS,
      generatedAt: "synthetic", generatedBy: "synthetic", view: { ...EMPTY_REPORT_VIEW, group: "currency" } }));
    expect(grouped).toContain("report-subtotal-row");
    expect(grouped).not.toContain(formatMoney(1800, "YER"));
    expect(grouped).not.toContain(formatMoney(150, "SAR"));
    const applied = applyReportView(result.columns!, result.rows!, { ...EMPTY_REPORT_VIEW, group: "currency" }, "YER");
    expect(applied.groups!.every((group) => !("balanceMinor" in group.totals))).toBe(true);
    expect(applied.groups!.find((group) => group.label === "YER")?.totals.debitMinor).toEqual({ YER: 1000 });
    expect(moneyTotalsByCurrency(result.rows!, result.columns!.at(-1)!, "YER")).toEqual({});
    for (const groupKey of [null, "currency"]) {
      const screen = renderToStaticMarkup(createElement(DataTable, { columns: result.columns!, rows: result.rows!, base: "YER", groupKey }));
      expect(screen).toContain(formatMoney(700, "YER"));
      expect(screen).not.toContain(formatMoney(1800, "YER"));
      expect(screen).not.toContain(formatMoney(150, "SAR"));
    }
    const onlyBalances = applyReportView(result.columns!, result.rows!, {
      columns: ["balanceMinor", "currency"], sort: { key: "balanceMinor", direction: "desc" }, group: "currency",
    }, "YER");
    expect(onlyBalances.columns[0].aggregate).toBe("none");
    expect(onlyBalances.groups!.every((group) => Object.keys(group.totals).length === 0)).toBe(true);
    const controlled = renderToStaticMarkup(createElement(DataTable, { columns: onlyBalances.columns, rows: onlyBalances.rows,
      base: "YER", groupKey: "currency" }));
    expect(controlled).not.toContain("<tfoot>");
    // Other reports retain additive totals.
    const normal = renderToStaticMarkup(createElement(PrintableReportDocument, { result: { ...result, report: "daily", columns: result.columns!.map((column) => ({ ...column, aggregate: undefined })) },
      settings: SETTING_DEFAULTS, generatedAt: "synthetic", generatedBy: "synthetic" }));
    expect(normal).toContain("report-total-row");
    expect(normal).toContain(formatMoney(1800, "YER"));
  });

  it("maps missing patient report input to 404, without falling back to a current statement", async () => {
    mocks.buildReport.mockRejectedValue(new ReportInputError("المريض غير موجود."));
    await expect(run({ to: "2026-09-30" })).rejects.toThrow();
    expect(mocks.patientLedger).not.toHaveBeenCalled();
  });
});

// Synthetic presentation evidence only: no live patient data or database writes.
import type { Invoice, Payment } from "../lib/db";
import { ledgerBalancesByCurrency } from "../lib/db";
import { StatementInvoiceDetails, statementPaymentLabel } from "../app/print/statement/[id]/presentation";

function statementInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return { id: 1, invoiceNumber: "SYN-INV-1", patientId: 17, patientName: "Synthetic patient",
    status: "open", totalMinor: 20000, discountMinor: 3000, baseCurrency: "SAR", note: null,
    createdAt: "2026-09-01T10:00:00Z", items: [{ id: 1, serviceId: 900, doctorId: null,
      description: "علاج عصب — السن ٢٦", quantity: 2, unitPriceMinor: 10000, totalMinor: 20000 }], ...overrides };
}
function statementPayment(overrides: Partial<Payment> = {}): Payment {
  return { id: 1, receiptNumber: "SYN-REC-1", patientId: 17, patientName: "Synthetic patient",
    invoiceId: 1, planId: null, openingCurrency: null, shiftId: 1, kind: "payment", reversalOfId: null,
    amountMinor: 5000, currency: "SAR", exchangeRate: 140, baseAmountMinor: 700000,
    baseCurrency: "YER", method: "cash", note: null, createdBy: "synthetic", createdAt: "2026-09-02T10:00:00Z", ...overrides };
}

describe("current patient statement explains stored treatment and discounts", () => {
  it.each(["open", "paid"] as const)("shows recorded items and gross/discount/net for a %s invoice", async (status) => {
    const invoice = statementInvoice({ status });
    const before = structuredClone(invoice);
    mocks.patientLedger.mockResolvedValue({ invoices: [invoice], payments: status === "paid"
      ? [statementPayment({ amountMinor: 17000, baseAmountMinor: 2380000 })] : [], openings: [] });
    const html = renderToStaticMarkup(await run());
    if (status === "paid") expect(html).toContain("المستحق الحالي مسدّد");
    for (const value of [invoice.invoiceNumber, invoice.items[0].description, "الكمية", "سعر الوحدة", "إجمالي البند",
      "الإجمالي قبل الخصم", "الخصم المسجل", "صافي الفاتورة بعد الخصم",
      formatMoney(10000, "SAR"), formatMoney(20000, "SAR"), formatMoney(3000, "SAR"), formatMoney(17000, "SAR")]) {
      expect(html).toContain(value);
    }
    expect(html).toContain('<td class="num">2</td>');
    expect(invoice).toEqual(before);
  });

  it("omits cancelled original invoices entirely and prints their current corrected replacement once", async () => {
    const original = statementInvoice({ status: "cancelled", invoiceNumber: "SYN-CANCELLED-ORIGINAL",
      items: [{ ...statementInvoice().items[0], description: "CANCELLED-OLD-TREATMENT" }] });
    const corrected = statementInvoice({ id: 2, invoiceNumber: "SYN-CORRECTED-2", totalMinor: 14000, discountMinor: 3000,
      items: [{ ...statementInvoice().items[0], id: 2, unitPriceMinor: 7000, totalMinor: 14000, originInvoiceId: 1 }] });
    // Payment remains linked to its historical original; filtering is presentation-only.
    const ledger = { invoices: [original, corrected], payments: [statementPayment()], openings: [] };
    const before = structuredClone(ledger);
    mocks.patientLedger.mockResolvedValue(ledger);
    const html = renderToStaticMarkup(await run());
    expect(html).not.toContain("SYN-CANCELLED-ORIGINAL");
    expect(html).not.toContain("CANCELLED-OLD-TREATMENT");
    expect(html.match(/data-invoice-id="2"/g)).toHaveLength(1);
    expect(html).not.toContain('data-invoice-id="1"');
    expect(html).toContain("SYN-REC-1");
    expect(html).toContain(formatMoney(6000, "SAR"));
    expect(ledgerBalancesByCurrency(17, ledger, new Map()).SAR.dueMinor).toBe(6000);
    expect(ledger).toEqual(before);
  });

  it("shows zero discount and zero-net treatment without inventing catalogue discounts", async () => {
    const zero = statementInvoice({ totalMinor: 0, discountMinor: 0,
      items: [{ ...statementInvoice().items[0], unitPriceMinor: 0, totalMinor: 0 }] });
    mocks.patientLedger.mockResolvedValue({ invoices: [zero], payments: [], openings: [] });
    const html = renderToStaticMarkup(await run());
    expect(html).toContain(zero.items[0].description);
    expect(html).toContain(`الخصم المسجل</td><td class="num">${formatMoney(0, "SAR")}`);
    expect(html).toContain("المستحق الحالي مسدّد");
    expect(html).not.toContain(formatMoney(20000, "SAR"));
  });

  it("renders fully discounted invoices from stored gross, not inferred item discounts", () => {
    const html = renderToStaticMarkup(createElement(StatementInvoiceDetails, {
      invoices: [statementInvoice({ discountMinor: 20000 })],
    }));
    expect(html).toContain(`الخصم المسجل</td><td class="num">${formatMoney(20000, "SAR")}`);
    expect(html).toContain(`صافي الفاتورة بعد الخصم</td><td class="num">${formatMoney(0, "SAR")}`);
  });

  it("preserves independent native-currency balances and real refund/reversal receipts", async () => {
    const ledger = { invoices: [statementInvoice(), statementInvoice({ id: 2, invoiceNumber: "SYN-USD", baseCurrency: "USD" })],
      payments: [statementPayment(), statementPayment({ id: 2, receiptNumber: "SYN-REV-2", kind: "refund", reversalOfId: 1,
        amountMinor: 1000, baseAmountMinor: 140000 }), statementPayment({ id: 3, receiptNumber: "SYN-REF-3",
        kind: "refund", amountMinor: 500, baseAmountMinor: 70000 })], openings: [] };
    mocks.patientLedger.mockResolvedValue(ledger);
    const html = renderToStaticMarkup(await run());
    expect(html).toContain("عكس سند SYN-REC-1");
    expect(html).toContain("استرداد");
    for (const payment of ledger.payments) expect(html).toContain(payment.receiptNumber);
    expect(html).toContain(formatMoney(13500, "SAR"));
    expect(html).toContain(formatMoney(17000, "USD"));
    expect(html).toContain("صافي المحصّل بعد الاستردادات وعكس السندات");
    expect(ledgerBalancesByCurrency(17, ledger, new Map()).SAR.dueMinor).toBe(13500);
    expect(ledgerBalancesByCurrency(17, ledger, new Map()).USD.dueMinor).toBe(17000);
  });

  it("does not interpret note wording as a correction or silently remove refunds", () => {
    expect(statementPaymentLabel(statementPayment({ note: "تصحيح السند" }), [])).toBe("دفعة");
    expect(statementPaymentLabel(statementPayment({ kind: "refund", note: "تصحيح السند" }), [])).toBe("استرداد");
    expect(statementPaymentLabel(statementPayment({ kind: "refund", reversalOfId: 99 }), [])).toBe("عكس سند سابق");
  });

  it("keeps long RTL treatment rows in a splittable table with repeated invoice identity and headings", async () => {
    const invoice = statementInvoice({ items: Array.from({ length: 120 }, (_, i) => ({
      ...statementInvoice().items[0], id: i + 1, description: `بند-${i + 1} ${"علاج طويل متعدد المراحل والأسنان ".repeat(12)}`,
    })) });
    mocks.patientLedger.mockResolvedValue({ invoices: [invoice], payments: [], openings: [] });
    const html = renderToStaticMarkup(await run());
    expect(html).toContain('class="sheet sheet-a4 statement-sheet" dir="rtl"');
    expect(html.match(/class="statement-description"/g)).toHaveLength(120);
    expect(html).toContain("بند-120");
    expect(html).toContain("overflow-wrap: anywhere");
    expect(html).toContain("table.statement-invoice td.num, table.statement-invoice th.num");
    expect(html).toContain("break-inside: auto");
    expect(html).toContain("display: table-header-group");
    expect(html).toContain('<thead><tr><th colSpan="4">فاتورة');
    // Markup contract only; physical multipage browser/PDF verification belongs to hosted CI.
  });

  it("makes missing stored details explicit rather than fabricating a treatment", () => {
    const html = renderToStaticMarkup(createElement(StatementInvoiceDetails, { invoices: [statementInvoice({ items: [] })] }));
    expect(html).toContain("تفاصيل البنود غير مسجلة لهذه الفاتورة");
    expect(html).toContain(formatMoney(17000, "SAR"));
  });
});
