import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { collectionsReport } from "../lib/reports";
import { formatMoney, type Currency } from "../lib/money";
import { reportCsv, reportExcel } from "../lib/report-export";
import type { ReportFilters, ReportResult } from "../lib/reports-types";
import { KpiGrid } from "../components/reports/shared";
import { PrintableReportDocument } from "../components/reports/PrintableReportDocument";

// Exercise the real report and money/output renderers; peripheral clinic branding is inert.
// No database, HTTP request, application startup or live record is needed by these fixtures.
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
    invoiceId: null, planId: null, openingCurrency: null,
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
  return {
    filters: { ...filters, ...patch }, base: "YER", doctors: new Map(), commissions: new Map(),
    expenses: [], visits: [], movements: patients ?? [patient(payments)],
  };
}

function kpi(result: ReportResult, key: string) {
  return result.kpis.find((item) => item.key === key);
}
function total(result: ReportResult, currency: Currency) {
  return kpi(result, currency === "YER" ? "total" : `total-${currency}`)?.minor ?? 0;
}
function native(result: ReportResult, currency: Currency) {
  return kpi(result, `cur-${currency}`)?.minor ?? 0;
}

const mixed = () => [
  payment(),
  payment({ id: 2, kind: "refund", amountMinor: 250, baseMinor: 375, settlementMinor: 375 }),
  payment({ id: 3, currency: "USD", amountMinor: 500, baseMinor: 5_000,
    settlementCurrency: "USD", settlementMinor: 500, method: "transfer", createdBy: "synthetic beta" }),
  payment({ id: 4, currency: "YER", amountMinor: 800, baseMinor: 800,
    settlementCurrency: "YER", settlementMinor: 800, createdBy: "synthetic beta" }),
  payment({ id: 5, amountMinor: 100, baseMinor: 150, settlementCurrency: "SAR", settlementMinor: 100,
    method: "transfer" }),
  payment({ id: 6, date: "2026-09-30", amountMinor: 900_000, baseMinor: 900_000, settlementMinor: 900_000 }),
  payment({ id: 7, date: "2026-11-01", amountMinor: 800_000, baseMinor: 800_000, settlementMinor: 800_000 }),
];

describe("collections native money representation", () => {
  it.each(["YER", "SAR", "USD"] as const)("formats %s minor units once in rows, screen KPIs and print", (currency) => {
    const amountMinor = 1_250;
    const result = collectionsReport(context([payment({ currency, amountMinor,
      settlementCurrency: currency, settlementMinor: amountMinor })]));
    expect(result.rows?.[0].amountText).toBe(formatMoney(amountMinor, currency));
    expect(kpi(result, `cur-${currency}`)).toMatchObject({ minor: amountMinor, currency });
    expect(kpi(result, `cur-${currency}`)?.count).toBeUndefined();
    const screen = renderToStaticMarkup(createElement(KpiGrid, { kpis: result.kpis, base: "YER" }));
    const print = renderToStaticMarkup(createElement(PrintableReportDocument, {
      result, settings: {} as Parameters<typeof PrintableReportDocument>[0]["settings"],
      generatedAt: "Synthetic fixed time", generatedBy: "synthetic",
    }));
    expect(screen).toContain(formatMoney(amountMinor, currency));
    expect(print).toContain(formatMoney(amountMinor, currency));
    if (currency !== "YER") expect(result.rows?.[0].amountText).toContain("12.50");
  });

  it("preserves corrected native amounts in CSV and Excel detail", () => {
    const result = collectionsReport(context([
      payment({ currency: "SAR" }),
      payment({ id: 2, currency: "USD", settlementCurrency: "USD", settlementMinor: 1_250 }),
    ]));
    for (const output of [reportCsv(result.columns!, result.rows!, "YER"), reportExcel(result.columns!, result.rows!, "YER")]) {
      expect(output).toContain(formatMoney(1_250, "SAR"));
      expect(output).toContain(formatMoney(1_250, "USD"));
      expect(output).not.toContain("1250 SAR");
      expect(output).not.toContain("1250 USD");
    }
  });

  it.each(["YER", "SAR", "USD"] as const)("retains a large safe-integer %s amount without rescaling stored totals", (currency) => {
    const amountMinor = 123_456_789;
    const result = collectionsReport(context([payment({ currency, amountMinor,
      settlementCurrency: currency, settlementMinor: amountMinor, baseMinor: amountMinor })]));
    expect(native(result, currency)).toBe(amountMinor);
    expect(total(result, currency)).toBe(amountMinor);
    expect(result.rows?.[0].amountText).toBe(formatMoney(amountMinor, currency));
  });

  it("keeps signed native movements separate from the signed settlement and stored base equivalent", () => {
    const result = collectionsReport(context(mixed()));
    expect(native(result, "SAR")).toBe(1_100);
    expect(native(result, "USD")).toBe(500);
    expect(native(result, "YER")).toBe(800);
    expect(total(result, "SAR")).toBe(100);
    expect(total(result, "USD")).toBe(500);
    expect(total(result, "YER")).toBe(2_300);
    expect(result.rows?.reduce((sum, row) => sum + Number(row.baseMinor), 0)).toBe(7_450);
    expect(kpi(result, "refunds")?.minor).toBe(375);
    expect(result.rows?.find((row) => row.kindLabel === "استرداد")).toMatchObject({
      amountText: formatMoney(250, "SAR"), baseMinor: -375,
    });
  });

  it("retains zero native movement after a receipt is fully reversed", () => {
    const original = payment();
    const result = collectionsReport(context([original, payment({ id: 2, kind: "refund" })]));
    expect(result.rows).toHaveLength(2);
    expect(kpi(result, "cur-SAR")).toMatchObject({ minor: 0, currency: "SAR" });
    expect(total(result, "YER")).toBe(0);
  });

  it.each(["YER", "SAR", "USD"] as const)("keeps refund-only %s totals negative without a cash-handback assertion", (currency) => {
    const result = collectionsReport(context([payment({ currency, kind: "refund", amountMinor: 1_250,
      settlementCurrency: currency, settlementMinor: 1_250 })]));
    expect(native(result, currency)).toBe(-1_250);
    expect(total(result, currency)).toBe(-1_250);
    expect(result.notes?.join(" ")).toContain("لا تُثبت وحدها");
  });
});

describe("collections effective filter population", () => {
  it.each([
    [{ currency: "SAR" }, 3, { YER: 1_500, SAR: 100, USD: 0 }, { YER: 0, SAR: 1_100, USD: 0 }],
    [{ method: "cash" }, 3, { YER: 2_300, SAR: 0, USD: 0 }, { YER: 800, SAR: 1_000, USD: 0 }],
    [{ receivedBy: "synthetic alpha" }, 3, { YER: 1_500, SAR: 100, USD: 0 }, { YER: 0, SAR: 1_100, USD: 0 }],
    [{ currency: "SAR", method: "cash", receivedBy: "synthetic alpha" }, 2,
      { YER: 1_500, SAR: 0, USD: 0 }, { YER: 0, SAR: 1_000, USD: 0 }],
    [{ currency: "USD", method: "transfer", receivedBy: "synthetic beta" }, 1,
      { YER: 0, SAR: 0, USD: 500 }, { YER: 0, SAR: 0, USD: 500 }],
  ] as [Partial<ReportFilters>, number, Record<Currency, number>, Record<Currency, number>][]) (
    "uses exactly the selected receipt population for %j", (patch, count, expectedSettlement, expectedNative) => {
      const result = collectionsReport(context(mixed(), patch));
      expect(result.rows).toHaveLength(count);
      for (const currency of ["YER", "SAR", "USD"] as const) {
        expect(total(result, currency)).toBe(expectedSettlement[currency]);
        expect(native(result, currency)).toBe(expectedNative[currency]);
      }
      expect(result.kpis.some((item) => /^(old|new)(-|$)/.test(item.key))).toBe(false);
      expect(result.notes?.join(" ")).toContain("لا يُعرض تصنيف الرصيد السابق");
    },
  );

  it("selects by tender currency even when the legal settlement currency differs", () => {
    const result = collectionsReport(context([payment()], { currency: "SAR" }));
    expect(result.rows).toHaveLength(1);
    expect(native(result, "SAR")).toBe(1_250);
    expect(total(result, "YER")).toBe(1_875);
    expect(total(result, "SAR")).toBe(0);
    expect(result.notes?.[0]).toContain("عملة السند الأصلية");
  });

  it("does not include an excluded refund in refund/native/settlement totals", () => {
    const result = collectionsReport(context(mixed(), { receivedBy: "synthetic beta" }));
    expect(result.rows).toHaveLength(2);
    expect(kpi(result, "refunds")?.minor).toBe(0);
    expect(native(result, "SAR")).toBe(0);
    expect(total(result, "YER")).toBe(800);
  });

  it("reports a genuinely empty filtered set without stale all-period totals", () => {
    const result = collectionsReport(context(mixed(), { currency: "SAR", receivedBy: "missing synthetic user" }));
    expect(result.rows).toEqual([]);
    expect(result.kpis.every((item) => item.minor === 0)).toBe(true);
    expect(kpi(result, "cur-SAR")).toMatchObject({ minor: 0, currency: "SAR" });
  });

  it("does not reassign earlier-receiver old debt to later filtered receipts", () => {
    const payments = [
      payment({ currency: "YER", amountMinor: 100, baseMinor: 100, settlementMinor: 100 }),
      payment({ id: 2, currency: "YER", amountMinor: 50, baseMinor: 50, settlementMinor: 50,
        createdBy: "synthetic beta" }),
    ];
    const owner = patient(payments, { openings: { YER: { date: "2026-09-01", minor: 100 } } });
    const all = collectionsReport(context(payments, {}, [owner]));
    expect(kpi(all, "old")?.minor).toBe(100);
    expect(kpi(all, "new")?.minor).toBe(50);
    const selected = collectionsReport(context(payments, { receivedBy: "synthetic beta" }, [owner]));
    expect(total(selected, "YER")).toBe(50);
    expect(kpi(selected, "old")).toBeUndefined();
    expect(kpi(selected, "new")).toBeUndefined();
  });

  it("retains the unfiltered classifier without claiming advance credit is new service value", () => {
    const payments = [payment({ currency: "YER", amountMinor: 40, baseMinor: 40, settlementMinor: 40 })];
    const owner = patient(payments, { openings: { YER: { date: "2026-09-01", minor: -100 } } });
    const result = collectionsReport(context(payments, {}, [owner]));
    expect(kpi(result, "old")?.minor).toBe(0);
    expect(kpi(result, "new")?.minor).toBe(40);
    expect(kpi(result, "new")?.hint).toContain("رصيدًا مقدمًا");
  });

  it("preserves the existing patient doctor cohort and inclusive period without mutating source facts", () => {
    const payments = [payment({ date: filters.from }), payment({ id: 2, date: filters.to })];
    const included = patient(payments, { visitDoctorIds: [7] });
    const excluded = patient([payment({ amountMinor: 9_999 })], { patientId: 2, visitDoctorIds: [8] });
    const ctx = context(payments, { doctorId: 7, currency: "SAR" }, [included, excluded]);
    const before = JSON.stringify(ctx.movements);
    const result = collectionsReport(ctx);
    expect(result.rows).toHaveLength(2);
    expect(native(result, "SAR")).toBe(2_500);
    expect(JSON.stringify(ctx.movements)).toBe(before);
  });

  it("uses the same corrected projection for collected-debt mode", () => {
    const result = collectionsReport(context(mixed(), { currency: "SAR", method: "cash" }), "debt");
    expect(result.report).toBe("debt");
    expect(result.title).toBe("تحصيل المديونيات خلال الفترة");
    expect(native(result, "SAR")).toBe(1_000);
    expect(total(result, "YER")).toBe(1_500);
    expect(kpi(result, "old")).toBeUndefined();
  });

  it("preserves the recorded specialty patient cohort without claiming every receipt belongs to that specialty", () => {
    const payments = [payment(), payment({ id: 2, kind: "refund", amountMinor: 250,
      baseMinor: 375, settlementMinor: 375 })];
    const plan: Patient["plans"][number] = {
      id: 10, title: "Synthetic recorded agreement", totalMinor: 10_000, currency: "YER",
      status: "active", startDate: "2026-01-01", categories: ["ortho"], paidMinor: 0,
      categoryShares: [{ category: "ortho", minor: 10_000 }],
    };
    const included = patient(payments, { plans: [plan] });
    const otherSpecialty = patient([payment({ id: 3, amountMinor: 9_999, settlementMinor: 9_999 })], {
      patientId: 2, plans: [{ ...plan, id: 11, categories: ["rct"],
        categoryShares: [{ category: "rct", minor: 10_000 }] }],
    });
    // These unallocated receipts have no plan/invoice target. The recorded patient
    // relationship admits the cohort; it does not attribute either receipt to ortho.
    const result = collectionsReport(context(payments, { specialty: "ortho" }, [included, otherSpecialty]));
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.every((row) => row.patientId === 1)).toBe(true);
    expect(native(result, "SAR")).toBe(1_000);
    expect(total(result, "YER")).toBe(1_500);
    expect(result.notes).toContain("فلتر الطبيب أو التخصص يختار مجموعة مرضى وفق ارتباطاتهم المسجّلة، ثم يعرض حركاتهم خلال الفترة؛ ولا ينسب كل سند إلى الطبيب أو التخصص المختار.");
  });
});
