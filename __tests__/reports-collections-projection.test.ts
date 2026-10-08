import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { collectionsReport } from "../lib/reports";
import { formatAmount, formatMoney, settlePaymentMinor, type Currency } from "../lib/money";
import { reportCsv, reportExcel } from "../lib/report-export";
import { applyReportView, EMPTY_REPORT_VIEW, moneyTotalsByCurrency } from "../lib/report-view";
import type { ReportFilters, ReportResult } from "../lib/reports-types";
import { DataTable, KpiGrid } from "../components/reports/shared";
import { PrintableReportDocument } from "../components/reports/PrintableReportDocument";

// The actual report projection, canonical settlement helper and all output
// renderers run on synthetic loaded facts. No database or live records are used.
vi.mock("../components/Icon", () => ({ Icon: () => null, Logo: () => null }));
vi.mock("../components/SettingsProvider", () => ({ useSetting: () => "" }));
vi.mock("../components/PrintHeader", () => ({ PrintHeader: () => null, PrintFooter: () => null }));

type Context = Parameters<typeof collectionsReport>[0];
type Patient = Context["movements"][number];
type Payment = Patient["payments"][number];

const filters: ReportFilters = {
  preset: "custom", from: "2026-10-01", to: "2026-10-31",
  specialty: null, doctorId: null, patientId: null, serviceId: null,
  currency: "all", patientStatus: "all", debtStatus: "all", debtMode: "collected",
  compare: "none", method: null, receivedBy: null,
};

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 1, date: "2026-10-07", at: "2026-10-07T09:00:00Z", kind: "payment",
    amountMinor: 1_250, currency: "SAR", baseMinor: 1_875,
    settlementCurrency: "YER", settlementMinor: 1_875,
    method: "cash", createdBy: "synthetic alpha", note: null,
    invoiceId: 10, planId: null, openingCurrency: null,
    ...overrides,
  };
}
function patient(payments: Payment[], overrides: Partial<Patient> = {}): Patient {
  return {
    patientId: 1, patientNumber: "SYN-1", name: "Synthetic patient", phone: null,
    createdDate: "2026-01-01", lastVisitDate: null, status: "active",
    referralSource: null, referredBy: null, openings: {}, invoices: [], plans: [],
    visitDoctorIds: [], payments, ...overrides,
  };
}
function context(payments: Payment[], patch: Partial<ReportFilters> = {}, patients?: Patient[]): Context {
  return { filters: { ...filters, ...patch }, base: "YER", doctors: new Map(), commissions: new Map(),
    expenses: [], visits: [], movements: patients ?? [patient(payments)] };
}
function kpi(result: ReportResult, key: string) { return result.kpis.find((item) => item.key === key); }
function native(result: ReportResult, currency: Currency) { return kpi(result, `cur-${currency}`)?.minor ?? 0; }
function outputs(result: ReportResult) {
  return {
    screen: renderToStaticMarkup(createElement(DataTable, { columns: result.columns!, rows: result.rows!, base: "YER" })),
    cards: renderToStaticMarkup(createElement(KpiGrid, { kpis: result.kpis, base: "YER" })),
    print: renderToStaticMarkup(createElement(PrintableReportDocument, { result,
      settings: {} as Parameters<typeof PrintableReportDocument>[0]["settings"],
      generatedAt: "Synthetic fixed time", generatedBy: "synthetic" })),
    csv: reportCsv(result.columns!, result.rows!, "YER"),
    excel: reportExcel(result.columns!, result.rows!, "YER"),
  };
}

const mixed = () => [
  payment(),
  payment({ id: 2, kind: "refund", amountMinor: 250, baseMinor: 375, settlementMinor: 375 }),
  payment({ id: 3, currency: "USD", amountMinor: 500, baseMinor: 5_000, invoiceId: 20,
    settlementCurrency: "USD", settlementMinor: 500, method: "transfer", createdBy: "synthetic beta" }),
  payment({ id: 4, currency: "YER", amountMinor: 800, baseMinor: 800, invoiceId: 30,
    settlementCurrency: "YER", settlementMinor: 800, createdBy: "synthetic beta" }),
  payment({ id: 5, amountMinor: 100, baseMinor: 150, invoiceId: null, planId: 40,
    settlementCurrency: "SAR", settlementMinor: 100, method: "transfer" }),
  payment({ id: 6, date: "2026-09-30", amountMinor: 900_000, baseMinor: 900_000, settlementMinor: 900_000 }),
  payment({ id: 7, date: "2026-11-01", amountMinor: 800_000, baseMinor: 800_000, settlementMinor: 800_000 }),
];

describe("collections native money and explicit settlement presentation", () => {
  it.each(["YER", "SAR", "USD"] as const)("keeps same-currency %s receipts native in every output", (currency) => {
    const amountMinor = 1_250, baseMinor = 987_654_321;
    const result = collectionsReport(context([payment({ currency, amountMinor, baseMinor,
      settlementCurrency: currency, settlementMinor: amountMinor })]));
    expect(result.rows?.[0]).toMatchObject({ currency, nativeMinor: amountMinor, settlementText: "—" });
    expect(result.rows?.[0].baseMinor).toBeUndefined();
    expect(kpi(result, `cur-${currency}`)).toMatchObject({ minor: amountMinor, currency });
    expect(kpi(result, `cur-${currency}`)?.count).toBeUndefined();
    const rendered = outputs(result);
    for (const output of [rendered.screen, rendered.cards, rendered.print]) expect(output).toContain(formatMoney(amountMinor, currency));
    for (const output of [rendered.csv, rendered.excel]) expect(output).toContain(`${formatAmount(amountMinor, currency)} ${currency}`);
    for (const output of Object.values(rendered)) expect(output).not.toContain("987,654,321");
    expect(result.columns?.some((column) => column.key === "baseMinor")).toBe(false);
    expect(result.kpis.some((item) => /^(total|old|new|refunds)(-|$)/.test(item.key))).toBe(false);
    if (currency !== "YER") expect(rendered.screen).toContain("12.50");
  });

  it.each(["invoice", "plan", "opening"] as const)("shows recorded SAR → YER settlement only for an explicit %s target", (kind) => {
    const source = payment({ invoiceId: kind === "invoice" ? 10 : null,
      planId: kind === "plan" ? 40 : null, openingCurrency: kind === "opening" ? "YER" : null });
    source.settlementMinor = settlePaymentMinor({ amountMinor: source.amountMinor, currency: source.currency,
      baseAmountMinor: source.baseMinor, id: source.id }, "YER");
    const result = collectionsReport(context([source]));
    const target = kind === "invoice" ? "فاتورة #10" : kind === "plan" ? "اتفاق #40" : "رصيد افتتاحي (YER)";
    expect(result.rows?.[0]).toMatchObject({ nativeMinor: 1_250, currency: "SAR", targetLabel: target,
      settlementText: formatMoney(1_875, "YER") });
    expect(result.kpis.map((item) => item.key)).toEqual(["cur-SAR"]);
    const rendered = outputs(result);
    for (const output of [rendered.screen, rendered.print, rendered.csv, rendered.excel]) {
      expect(output).toContain(target);
      expect(output).toContain(formatMoney(1_875, "YER"));
    }
    expect(rendered.cards).not.toContain(formatMoney(1_875, "YER"));
  });

  it.each(["plan", "opening"] as const)("keeps a SAR payment to a SAR %s target entirely native", (kind) => {
    const result = collectionsReport(context([payment({ invoiceId: null,
      planId: kind === "plan" ? 40 : null, openingCurrency: kind === "opening" ? "SAR" : null,
      settlementCurrency: "SAR", settlementMinor: 1250, baseMinor: 1875 })]));
    expect(result.rows?.[0]).toMatchObject({ nativeMinor: 1250, currency: "SAR", settlementText: "—",
      targetLabel: kind === "plan" ? "اتفاق #40" : "رصيد افتتاحي (SAR)" });
    for (const output of Object.values(outputs(result))) expect(output).not.toContain("1,875");
  });

  it("labels the authoritative invoice when a receipt also carries its plan reference", () => {
    const result = collectionsReport(context([payment({ invoiceId: 10, planId: 40 })]));
    expect(result.rows?.[0].targetLabel).toBe("فاتورة #10");
  });

  it("uses the recorded USD → YER amount including historical rounding", () => {
    const source = payment({ currency: "USD", amountMinor: 101, baseMinor: 2626, settlementMinor: 2626 });
    const result = collectionsReport(context([source]));
    expect(result.rows?.[0]).toMatchObject({ nativeMinor: 101, currency: "USD", settlementText: formatMoney(2626, "YER") });
  });

  it("does not invent a USD → SAR rate unsupported by the canonical recorded-money contract", () => {
    expect(() => settlePaymentMinor({ amountMinor: 1250, currency: "USD", baseAmountMinor: 32500 }, "SAR"))
      .toThrow(/بلا سعرٍ مسجَّل/);
  });

  it.each(["payment", "refund"])("keeps an unlinked %s target unknown despite another current agreement", (kind) => {
    const source = payment({ kind, invoiceId: null, settlementCurrency: kind === "refund" ? "SAR" : "YER",
      settlementMinor: kind === "refund" ? 1250 : 1875 });
    const plan: Patient["plans"][number] = { id: 40, title: "Unrelated current agreement", totalMinor: 10_000,
      currency: "SAR", status: "active", startDate: "2026-01-01", categories: [], paidMinor: 0, categoryShares: [] };
    const owner = patient([source], { plans: [plan], openings: { YER: { date: "2026-01-01", minor: 5_000 } } });
    const result = collectionsReport(context([source], {}, [owner]));
    expect(result.rows?.[0]).toMatchObject({ targetLabel: "غير محدد في السند", settlementText: "—",
      currency: "SAR", nativeMinor: kind === "refund" ? -1250 : 1250 });
    expect(result.rows?.[0].targetLabel).not.toContain("اتفاق");
    expect(JSON.stringify(result)).not.toContain("1,875");
  });

  it("shows a resolved cancelled invoice target without relying on active invoice rows", () => {
    const source = payment({ invoiceId: 99 });
    const result = collectionsReport(context([source], {}, [patient([source], { invoices: [] })]));
    expect(result.rows?.[0]).toMatchObject({ targetLabel: "فاتورة #99", settlementText: formatMoney(1875, "YER") });
  });

  it.each(["YER", "SAR", "USD"] as const)("preserves large safe-integer native %s minor units", (currency) => {
    const amountMinor = 123_456_789;
    const result = collectionsReport(context([payment({ currency, amountMinor,
      settlementCurrency: currency, settlementMinor: amountMinor })]));
    expect(native(result, currency)).toBe(amountMinor);
    expect(result.rows?.[0].nativeMinor).toBe(amountMinor);
    expect(outputs(result).screen).toContain(formatMoney(amountMinor, currency));
  });

  it("keeps every table and group subtotal currency-tagged without a cross-currency total", () => {
    const result = collectionsReport(context(mixed()));
    const column = result.columns!.find((item) => item.key === "nativeMinor")!;
    expect(column).toMatchObject({ type: "money", currencyKey: "currency" });
    expect(moneyTotalsByCurrency(result.rows!, column, "YER")).toEqual({ YER: 800, SAR: 1100, USD: 500 });
    const applied = applyReportView(result.columns!, result.rows!, { ...EMPTY_REPORT_VIEW, group: "methodLabel" }, "YER");
    expect(applied.groups?.find((group) => group.label === "نقدًا")?.totals.nativeMinor).toEqual({ YER: 800, SAR: 1000 });
    expect(native(result, "SAR")).toBe(1100);
    expect(native(result, "USD")).toBe(500);
    expect(native(result, "YER")).toBe(800);
    expect(result.kpis.slice(0, 3).map((item) => item.key)).toEqual(["cur-YER", "cur-SAR", "cur-USD"]);
    expect(kpi(result, "refunds-SAR")).toMatchObject({ minor: 250, currency: "SAR" });
    expect(result.rows?.find((row) => row.receiptId === 2)).toMatchObject({ nativeMinor: -250,
      settlementText: formatMoney(-375, "YER"), kindLabel: "استرداد" });
    const rendered = outputs(result);
    for (const output of [rendered.screen, rendered.print]) expect(output).toContain(formatMoney(-250, "SAR"));
    for (const output of [rendered.csv, rendered.excel]) expect(output).toContain("-2.50 SAR");
  });

  it("stacks only the opted-in native currency totals and leaves default report layouts unchanged", () => {
    const result = collectionsReport(context(mixed()));
    expect(result.columns?.filter((column) => column.stackCurrencyTotals).map((column) => column.key))
      .toEqual(["nativeMinor"]);
    const rendered = outputs(result);
    for (const output of [rendered.screen, rendered.print]) {
      expect(output.match(/data-report-currency-total=""/g)).toHaveLength(3);
      for (const [currency, minor] of [["YER", 800], ["SAR", 1100], ["USD", 500]] as const) {
        expect(output).toContain(`>${formatMoney(minor, currency)}</span>`);
      }
    }
    expect(rendered.screen).toContain('class="block whitespace-nowrap"');
    expect(rendered.print).toContain('style="display:block;white-space:nowrap"');

    const defaultColumns = result.columns!.map((column) => {
      const copy = { ...column };
      delete copy.stackCurrencyTotals;
      return copy;
    });
    const defaultResult = { ...result, columns: defaultColumns };
    const defaults = outputs(defaultResult);
    expect(defaults.screen).not.toContain("data-report-currency-total");
    expect(defaults.print).not.toContain("data-report-currency-total");
    expect(defaults.screen).toContain("11.00 ر.س · 5.00 $ · 800 ر.ي");
    expect(defaults.print).toContain("800 ر.ي · 11.00 ر.س · 5.00 $");
    expect(rendered.csv).toBe(defaults.csv);
    expect(rendered.excel).toBe(defaults.excel);

    const view = { ...EMPTY_REPORT_VIEW, group: "methodLabel" };
    const applied = applyReportView(result.columns!, result.rows!, view, "YER");
    const groupedScreen = renderToStaticMarkup(createElement(DataTable, {
      columns: applied.columns, rows: applied.rows, base: "YER", groupKey: applied.view.group,
    }));
    const groupedPrint = renderToStaticMarkup(createElement(PrintableReportDocument, {
      result, view, settings: {} as Parameters<typeof PrintableReportDocument>[0]["settings"],
      generatedAt: "Synthetic fixed time", generatedBy: "synthetic",
    }));
    // Cash and transfer each have two currencies; the overall total has three.
    for (const output of [groupedScreen, groupedPrint]) {
      expect(output.match(/data-report-currency-total=""/g)).toHaveLength(7);
      expect(output).toContain(`>${formatMoney(1000, "SAR")}</span>`);
      expect(output).toContain(`>${formatMoney(100, "SAR")}</span>`);
    }
  });

  it("resets obsolete saved collections columns consistently without changing other report layouts", () => {
    const result = collectionsReport(context(mixed()));
    for (const legacy of [["date", "amountText", "baseMinor"], ["date", "baseMinor"], ["amountText"]]) {
      const applied = applyReportView(result.columns!, result.rows!, {
        columns: legacy, sort: { key: "baseMinor", direction: "desc" }, group: null,
      }, "YER");
      expect(applied.columns).toEqual(result.columns);
      expect(applied.view.sort).toBeNull();
      expect(reportCsv(applied.columns, applied.rows, "YER")).toContain("12.50 SAR");
      expect(applied.columns.some((column) => column.key === "amountText")).toBe(false);
      expect(reportCsv(applied.columns, applied.rows, "YER")).toContain("-2.50 SAR");
      expect(reportExcel(applied.columns, applied.rows, "YER")).toContain("-2.50 SAR");
      const print = renderToStaticMarkup(createElement(PrintableReportDocument, { result,
        settings: {} as Parameters<typeof PrintableReportDocument>[0]["settings"],
        generatedAt: "Synthetic fixed time", generatedBy: "synthetic",
        view: { columns: legacy, sort: null, group: null } }));
      expect(print).toContain(formatMoney(-250, "SAR"));
    }
    const other = [{ key: "date", label: "Date" }, { key: "baseMinor", label: "Other report amount", type: "money" as const }];
    expect(applyReportView(other, [{ date: "synthetic", baseMinor: 100 }], {
      ...EMPTY_REPORT_VIEW, columns: ["baseMinor"],
    }, "YER").columns.map((column) => column.key)).toEqual(["baseMinor"]);
  });

  it("retains visible zero native movement after full reversal", () => {
    const result = collectionsReport(context([payment(), payment({ id: 2, kind: "refund" })]));
    expect(result.rows).toHaveLength(2);
    expect(kpi(result, "cur-SAR")).toMatchObject({ minor: 0, currency: "SAR" });
    expect(kpi(result, "refunds-SAR")).toMatchObject({ minor: 1250, currency: "SAR" });
  });

  it.each(["payment", "refund"])("does not normalize invalid legacy %s magnitudes with abs or silently drop zero", (kind) => {
    // New writes require positive magnitudes, but the historical CHECK is NOT
    // VALID and loadMovements does not validate positivity. Characterize that
    // existing signed contract; no real data anomaly or safe repair is implied.
    for (const amountMinor of [-250, 0]) {
      const source = payment({ kind, currency: "SAR", amountMinor, baseMinor: 0,
        settlementCurrency: "SAR", settlementMinor: amountMinor });
      const before = JSON.stringify(source);
      const result = collectionsReport(context([source]));
      const expected = kind === "refund" ? -amountMinor : amountMinor;
      expect(result.rows).toHaveLength(1);
      expect(result.rows?.[0].nativeMinor).toBe(expected);
      expect(native(result, "SAR")).toBe(expected === 0 ? 0 : expected);
      expect(JSON.stringify(source)).toBe(before);
    }
  });

  it.each(["YER", "SAR", "USD"] as const)("keeps refund-only %s native net negative", (currency) => {
    const result = collectionsReport(context([payment({ currency, kind: "refund", amountMinor: 1250,
      settlementCurrency: currency, settlementMinor: 1250 })]));
    expect(native(result, currency)).toBe(-1250);
    expect(kpi(result, `refunds-${currency}`)).toMatchObject({ minor: 1250, currency });
    expect(result.notes?.join(" ")).toContain("لا تُثبت وحدها");
  });
});

describe("collections exact receipt filter population", () => {
  it.each([
    [{ currency: "SAR" }, 3, { YER: 0, SAR: 1100, USD: 0 }],
    [{ method: "cash" }, 3, { YER: 800, SAR: 1000, USD: 0 }],
    [{ receivedBy: "synthetic alpha" }, 3, { YER: 0, SAR: 1100, USD: 0 }],
    [{ currency: "SAR", method: "cash", receivedBy: "synthetic alpha" }, 2, { YER: 0, SAR: 1000, USD: 0 }],
    [{ currency: "USD", method: "transfer", receivedBy: "synthetic beta" }, 1, { YER: 0, SAR: 0, USD: 500 }],
  ] as [Partial<ReportFilters>, number, Record<Currency, number>][]) (
    "uses exactly the selected receipts for %j", (patch, count, expected) => {
      const result = collectionsReport(context(mixed(), patch));
      expect(result.rows).toHaveLength(count);
      for (const currency of ["YER", "SAR", "USD"] as const) expect(native(result, currency)).toBe(expected[currency]);
      expect(result.kpis.some((item) => /^(old|new|total)(-|$)/.test(item.key))).toBe(false);
    });

  it("filters by original SAR tender while preserving the explicit YER settlement on that row", () => {
    const result = collectionsReport(context([payment()], { currency: "SAR" }));
    expect(result.rows).toHaveLength(1);
    expect(native(result, "SAR")).toBe(1250);
    expect(kpi(result, "cur-YER")).toBeUndefined();
    expect(result.rows?.[0].settlementText).toBe(formatMoney(1875, "YER"));
    expect(result.notes?.[0]).toContain("عملة السند الأصلية");
  });

  it("does not leak an excluded refund into any card or row", () => {
    const result = collectionsReport(context(mixed(), { receivedBy: "synthetic beta" }));
    expect(result.rows).toHaveLength(2);
    expect(result.kpis.some((item) => item.key.startsWith("refunds"))).toBe(false);
    expect(native(result, "SAR")).toBe(0);
    expect(native(result, "YER")).toBe(800);
  });

  it("shows an empty selected currency as zero without stale other-currency totals", () => {
    const result = collectionsReport(context(mixed(), { currency: "SAR", receivedBy: "missing synthetic user" }));
    expect(result.rows).toEqual([]);
    expect(result.kpis).toHaveLength(1);
    expect(kpi(result, "cur-SAR")).toMatchObject({ minor: 0, currency: "SAR" });
  });

  it("never reallocates an earlier receiver's old debt to later selected receipts", () => {
    const payments = [payment({ invoiceId: null }), payment({ id: 2, invoiceId: null, createdBy: "synthetic beta" })];
    const owner = patient(payments, { openings: { YER: { date: "2026-09-01", minor: 100 } } });
    for (const patch of [{}, { receivedBy: "synthetic beta" }]) {
      const result = collectionsReport(context(payments, patch, [owner]));
      expect(result.kpis.some((item) => /^(old|new|total)(-|$)/.test(item.key))).toBe(false);
      expect(result.rows?.every((row) => row.targetLabel === "غير محدد في السند" && row.settlementText === "—")).toBe(true);
    }
  });

  it("preserves doctor cohorts, inclusive date boundaries and immutable source facts", () => {
    const payments = [payment({ date: filters.from }), payment({ id: 2, date: filters.to })];
    const included = patient(payments, { visitDoctorIds: [7] });
    const excluded = patient([payment({ amountMinor: 9999 })], { patientId: 2, visitDoctorIds: [8] });
    const ctx = context(payments, { doctorId: 7, currency: "SAR" }, [included, excluded]);
    const before = JSON.stringify(ctx.movements);
    expect(collectionsReport(ctx).rows).toHaveLength(2);
    expect(native(collectionsReport(ctx), "SAR")).toBe(2500);
    expect(JSON.stringify(ctx.movements)).toBe(before);
  });

  it("uses the identical projection for collected-debt mode", () => {
    const ctx = context(mixed(), { currency: "SAR", method: "cash" });
    const result = collectionsReport(ctx, "debt");
    expect(result.report).toBe("debt");
    expect(result.rows).toEqual(collectionsReport(ctx).rows);
    expect(result.kpis).toEqual(collectionsReport(ctx).kpis);
    expect(native(result, "SAR")).toBe(1000);
  });

  it("preserves specialty cohorts without calling unlinked receipts agreement settlements", () => {
    const payments = [payment({ invoiceId: null })];
    const plan: Patient["plans"][number] = { id: 10, title: "Synthetic agreement", totalMinor: 10_000,
      currency: "YER", status: "active", startDate: "2026-01-01", categories: ["ortho"], paidMinor: 0,
      categoryShares: [{ category: "ortho", minor: 10_000 }] };
    const included = patient(payments, { plans: [plan] });
    const excluded = patient([payment({ id: 3, amountMinor: 9999 })], { patientId: 2,
      plans: [{ ...plan, id: 11, categories: ["rct"], categoryShares: [{ category: "rct", minor: 10_000 }] }] });
    const result = collectionsReport(context(payments, { specialty: "ortho" }, [included, excluded]));
    expect(result.rows).toHaveLength(1);
    expect(result.rows?.[0]).toMatchObject({ patientId: 1, nativeMinor: 1250, targetLabel: "غير محدد في السند", settlementText: "—" });
    expect(result.notes).toContain("فلتر الطبيب أو التخصص يختار مجموعة مرضى وفق ارتباطاتهم المسجّلة، ثم يعرض حركاتهم خلال الفترة؛ ولا ينسب كل سند إلى الطبيب أو التخصص المختار.");
  });
});
