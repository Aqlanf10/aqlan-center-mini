import { createElement, type ComponentProps } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FinanceKpis } from "../components/finance/FinanceKpis";
import { CashShiftTab, type PaymentItem, type ShiftData } from "../components/finance/CashShiftTab";
import { expenseTotals } from "../lib/expenses";
import { CURRENCIES, formatMoney, shiftTotals } from "../lib/money";
import { drawerBreakdown, zeroAmounts } from "../lib/shift-close";
import { CLINIC_ZONE_FALLBACK } from "../lib/clinicZone";

const noop = () => {};
const defaultProps: ComponentProps<typeof FinanceKpis> = {
  canMutate: false, activeTab: "cash", onTabChange: noop, baseCurrency: "YER",
  shiftReadState: "ready", isShiftOpen: true, openedBy: "اختبار", expectedInBox: zeroAmounts(),
  shiftTotals: shiftTotals([]), expenseTotals: expenseTotals([]),
  totalDebtsByCurrency: zeroAmounts(), debtorsCount: 0, overduePlansCount: 0,
  labBalanceState: { phase: "unavailable", data: null },
  onOpenQuickCollect: noop, onOpenNewExpense: noop, onOpenCloseShift: noop,
  onOpenLabReconcile: noop, onOpenProfitability: noop,
};
const renderKpis = (props: Partial<typeof defaultProps> = {}) =>
  renderToStaticMarkup(createElement(FinanceKpis, { ...defaultProps, ...props }));
// Inspect only the drawer card so a correct small currency chip cannot hide an incorrect headline.
const cashCard = (html: string) => html.slice(0, html.indexOf("إدارة حركة الصندوق"));
const cashAmounts = (html: string) => cashCard(html).match(/<bdi[^>]*>([^<]+)<\/bdi>/g) ?? [];

const payment = (overrides: Partial<PaymentItem> = {}): PaymentItem => ({
  id: 1, receiptNumber: "SHIFT-1", patientId: 1, patientName: "مريض تجريبي",
  kind: "payment", amountMinor: 12_000, currency: "YER", exchangeRate: 1,
  baseAmountMinor: 12_000, method: "cash", createdAt: "2026-10-01T09:00:00Z",
  ...overrides,
});

describe("finance KPI drawer balance", () => {
  it("promotes opening balances in each actual currency even before any receipts", () => {
    const opening = { YER: 50_000, SAR: 12_500, USD: 2_025 };
    const html = renderKpis({ expectedInBox: drawerBreakdown(opening, [], []).expected });
    expect(cashCard(html)).toContain("النقد المتوقع بالصندوق");
    expect(cashAmounts(html)).toEqual(CURRENCIES.map((currency) =>
      `<bdi dir="ltr">${formatMoney(opening[currency], currency)}</bdi>`));
    expect(cashCard(html)).toContain("يشمل العهدة الافتتاحية والحركة النقدية فقط");
  });

  it("does not replace cash with the converted receipts total including bank transfers", () => {
    const payments = [payment(), payment({ id: 2, method: "transfer", amountMinor: 90_000, baseAmountMinor: 90_000 })];
    const expenses = [{ category: "other", currency: "YER" as const, amountMinor: 2_000, baseAmountMinor: 2_000 }];
    const expected = drawerBreakdown({ YER: 50_000, SAR: 0, USD: 0 }, payments, expenses).expected;
    const html = renderKpis({ expectedInBox: expected, shiftTotals: shiftTotals(payments), expenseTotals: expenseTotals(expenses) });
    expect(cashCard(html)).toContain(`<bdi dir="ltr">${formatMoney(60_000, "YER")}</bdi>`);
    expect(cashCard(html)).not.toContain(formatMoney(100_000, "YER"));
    expect(cashCard(html)).not.toContain(formatMoney(102_000, "YER"));
    expect(html).toContain("نقد وتحويلات · مكافئ بالعملة الأساسية");
    expect(html).toContain(`بعد المصروفات (مكافئ): ${formatMoney(100_000, "YER")}`);
    expect(html).not.toContain("صافي النقد:");
  });

  it("keeps mixed currencies separate, including cash refunds and expenses", () => {
    const payments = [
      payment({ currency: "SAR", amountMinor: 15_000, baseAmountMinor: 19_500 }),
      payment({ id: 2, kind: "refund", currency: "USD", amountMinor: 1_025, baseAmountMinor: 5_433 }),
      payment({ id: 3, method: "transfer", currency: "SAR", amountMinor: 20_000, baseAmountMinor: 26_000 }),
    ];
    const expenses = [{ category: "other", currency: "YER" as const, amountMinor: 2_000, baseAmountMinor: 2_000 }];
    const expected = drawerBreakdown({ YER: 50_000, SAR: 12_500, USD: 2_025 }, payments, expenses).expected;
    expect(expected).toEqual({ YER: 48_000, SAR: 27_500, USD: 1_000 });
    const html = renderKpis({ expectedInBox: expected, shiftTotals: shiftTotals(payments), expenseTotals: expenseTotals(expenses) });
    expect(cashAmounts(html)).toEqual(CURRENCIES.map((currency) =>
      `<bdi dir="ltr">${formatMoney(expected[currency], currency)}</bdi>`));
    expect(cashCard(html)).not.toContain(formatMoney(38_067, "YER"));
  });

  it("shows real zero balances explicitly in all three currencies", () => {
    expect(cashAmounts(renderKpis())).toEqual(CURRENCIES.map((currency) =>
      `<bdi dir="ltr">${formatMoney(0, currency)}</bdi>`));
  });

  it("preserves negative expected cash instead of hiding a drawer shortfall", () => {
    const html = renderKpis({ expectedInBox: { YER: -500, SAR: 0, USD: -125 } });
    expect(cashCard(html)).toContain(`<bdi dir="ltr">${formatMoney(-500, "YER")}</bdi>`);
    expect(cashCard(html)).toContain(`<bdi dir="ltr">${formatMoney(-125, "USD")}</bdi>`);
  });

  it("does not show a stale balance as current after a shift closes", () => {
    const html = renderKpis({ isShiftOpen: false, expectedInBox: { YER: 72_500, SAR: 5_000, USD: 0 } });
    expect(cashCard(html)).toContain("الصندوق مغلق");
    expect(cashCard(html)).toContain("لا توجد وردية مفتوحة");
    expect(cashAmounts(html)).toHaveLength(0);
    expect(cashCard(html)).not.toContain(formatMoney(72_500, "YER"));
    expect(cashCard(html)).not.toContain(formatMoney(5_000, "SAR"));
  });

  it("does not invent a zero balance when the active drawer data is missing", () => {
    const html = renderKpis({ expectedInBox: null });
    expect(cashCard(html)).toContain("أرصدة الوردية غير متاحة");
    expect(cashAmounts(html)).toHaveLength(0);
  });
});

const shift: ShiftData = {
  id: 1, openedBy: "اختبار", openedAt: "2026-09-29T09:00:00Z", opening: zeroAmounts(),
  closedBy: null, closedAt: null, counted: null, note: null, status: "open",
};
const renderShift = (props: Partial<ComponentProps<typeof CashShiftTab>> = {}) =>
  renderToStaticMarkup(createElement(CashShiftTab, {
    canMutate: false, shift, payments: [], expenses: [], recentShifts: [],
    expectedInBox: zeroAmounts(), baseCurrency: "YER", clinicTimeZone: CLINIC_ZONE_FALLBACK,
    parties: [], isAdmin: false, busy: false,
    onOpenShift: async () => {}, onCloseShift: async () => "failed" as const, onCreateExpense: async () => {},
    onRemoveExpense: async () => {}, onOpenQuickCollect: noop, lastVoucherId: null,
    onClearLastVoucher: noop, lastReceiptId: null, onClearLastReceipt: noop,
    spending: false, setSpending: noop, closing: false, setClosing: noop, ...props,
  }));

describe("finance active-shift scope", () => {
  it("labels receipts and expenses as shift totals, not today's activity", () => {
    const html = renderKpis();
    expect(html).toContain("مقبوضات الوردية");
    expect(html).toContain("مصروفات الوردية");
    expect(html).not.toContain("مقبوضات اليوم");
    expect(html).not.toContain("صافي النقد");
  });

  it("renders payments from multiple days with shift-scoped heading and opening date", () => {
    const html = renderShift({ payments: [
      payment({ receiptNumber: "SHIFT-EARLIER", createdAt: "2026-09-29T10:00:00Z" }),
      payment({ id: 2, receiptNumber: "SHIFT-LATER", createdAt: "2026-10-01T10:00:00Z" }),
    ] });
    expect(html).toContain('aria-label="حركات الوردية الحالية"');
    expect(html).toContain("حركات الوردية الحالية</h3>");
    expect(html).not.toContain("حركات الصندوق اليوم");
    expect(html).toContain("SHIFT-EARLIER");
    expect(html).toContain("SHIFT-LATER");
    expect(html).toContain(new Date(shift.openedAt).toLocaleString("ar-YE-u-nu-latn", {
      timeZone: CLINIC_ZONE_FALLBACK,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }));
  });

  it.each(["UTC", "America/Los_Angeles", "Asia/Tokyo"])(
    "shows the clinic opening date across midnight when the viewer timezone is %s",
    (timeZone) => {
      vi.stubEnv("TZ", timeZone);
      try {
        const html = renderShift({ shift: { ...shift, openedAt: "2026-09-30T22:30:00Z" } });
        // 22:30 UTC is the following day at 01:30 in the clinic, regardless of the viewer.
        expect(html).toContain("01\u200f/10\u200f/2026، 01:30 ص");
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.each(["UTC", "America/Los_Angeles", "Asia/Tokyo"])(
    "uses the configured non-default clinic timezone when the viewer timezone is %s",
    (timeZone) => {
      vi.stubEnv("TZ", timeZone);
      try {
        const html = renderShift({
          clinicTimeZone: "America/New_York",
          shift: { ...shift, openedAt: "2026-09-30T22:30:00Z" },
        });
        expect(html).toContain("30\u200f/09\u200f/2026، 06:30 م");
        expect(html).not.toContain("01\u200f/10\u200f/2026، 01:30 ص");
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("passes the configured timezone received with the shift feed to the cash tab", () => {
    const source = readFileSync("app/finance/page.tsx", "utf8");
    expect(source).toContain("clinicTimeZone={feed?.clinicTimeZone ?? CLINIC_ZONE_FALLBACK}");
  });

  it("retains the canonical fallback for callers without the new timezone field", () => {
    const html = renderShift({
      clinicTimeZone: undefined,
      shift: { ...shift, openedAt: "2026-09-30T22:30:00Z" },
    });
    expect(html).toContain("01\u200f/10\u200f/2026، 01:30 ص");
  });

  it("does not announce current-shift activity when closed, but keeps past shifts available", () => {
    const closedShift: ShiftData = { ...shift, status: "closed", closedBy: "اختبار",
      closedAt: "2026-09-29T18:00:00Z", counted: zeroAmounts() };
    const html = renderShift({ shift: null, recentShifts: [closedShift] });
    expect(html).toContain("الصندوق مغلق");
    expect(html).toContain('aria-label="الورديات السابقة"');
    expect(html).not.toContain("حركات الوردية الحالية");
    expect(html).not.toContain("لم تُسجل أي حركة مالية في هذه الوردية بعد.");
  });

  it("receipt success does not claim every payment changes physical cash", () => {
    const html = renderShift({ lastReceiptId: 1 });
    expect(html).toContain("تم إصدار سند القبض بنجاح وتحديث بيانات الوردية.");
    expect(html).not.toContain("تحديث رصيد الصندوق الفعلي");
  });
});
