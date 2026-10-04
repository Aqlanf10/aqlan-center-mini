import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FinanceKpis } from "../components/finance/FinanceKpis";
import { ReceivablesLabsTab } from "../components/finance/ReceivablesLabsTab";
import { projectLabBalanceOverview, type LabBalanceReadState } from "../lib/lab-balance-overview";
import { formatMoney } from "../lib/money";

const noop = () => {};
const state: LabBalanceReadState = { phase: "ready", data: projectLabBalanceOverview([
  { id: 1, name: "Debit and credit lab", kind: "lab", currency: "YER", phone: null },
  { id: 2, name: "Offsetting lab", kind: "lab", currency: "YER", phone: null },
], [
  { partyId: 1, kind: "lab", currency: "USD", dueMinor: -525 },
  { partyId: 2, kind: "lab", currency: "USD", dueMinor: 525 },
  { partyId: 1, kind: "lab", currency: "SAR", dueMinor: 2250 },
], "2026-10-03T12:00:00.000Z") };
const kpi = (labBalanceState: LabBalanceReadState = state) => renderToStaticMarkup(createElement(FinanceKpis, {
  canMutate: true, activeTab: "receivables", onTabChange: noop, baseCurrency: "YER", shiftReadState: "ready",
  isShiftOpen: false, expectedInBox: null, shiftTotals: null, expenseTotals: null,
  totalDebtsByCurrency: { YER: 0, SAR: 0, USD: 0 }, debtorsCount: 0, overduePlansCount: 0,
  labBalanceState, onOpenQuickCollect: noop, onOpenNewExpense: noop, onOpenCloseShift: noop,
  onOpenLabReconcile: noop, onOpenProfitability: noop,
}));
const tab = (labBalanceState: LabBalanceReadState = state, changes: Partial<ComponentProps<typeof ReceivablesLabsTab>> = {}) => renderToStaticMarkup(createElement(ReceivablesLabsTab, {
  canMutate: true, debtRows: [], baseCurrency: "YER", clinicName: "Synthetic clinic", labBalanceState, onReloadLabBalances: noop,
  labSummaries: [{ partyId: 1, partyName: "Debit and credit lab", currency: "YER", phone: null, activeOrdersCount: 13, unsettledOrdersCount: 28 }],
  labRisks: [], onOpenCollectForPatient: noop, onOpenLabReconcileForParty: noop, ...changes,
}));
const moneyCard = (html: string) => html.slice(html.indexOf("صافي أرصدة المختبرات بكل عملة"), html.indexOf("مراجعة أرصدة كل مختبر"));
const labSection = (html: string) => html.slice(html.indexOf('aria-label="أرصدة المختبرات"'), html.indexOf("بنود المصروفات التشغيلية والموازنات"));

describe("actual finance net-balance components", () => {
  it("renders same-currency net KPI totals and labels offsets without gross AP/base-currency fiction", () => {
    const html = moneyCard(kpi());
    expect(html).toContain(formatMoney(2250, "SAR")); expect(html).toContain(formatMoney(0, "USD"));
    expect(html).toContain("صافي الصفر قد يخفي ديوناً وأرصدة متقابلة");
    expect(html).not.toContain(formatMoney(2250, "YER")); expect(html).not.toContain("(AP)");
    expect(html).not.toContain("عمل معمل");
  });
  it("retains opposite signed lab rows even when the overall currency net is zero", () => {
    const html = labSection(tab());
    for (const value of [-525, 525]) expect(html).toContain(formatMoney(value, "USD"));
    expect(html).toContain(formatMoney(0, "USD")); expect(html).toContain(formatMoney(2250, "SAR"));
    expect(html).toContain("صافي رصيد حساب المختبر بكل عملة");
    expect(html).toContain("الموجب علينا للمختبر؛ السالب رصيد لنا لديه");
    expect(html).not.toContain("الرصيد غير المسدد"); expect(html).not.toContain("إجمالي المستحق:");
  });
  it("keeps counts explicitly clinical and loaded-window, never outstanding payable counts", () => {
    const html = labSection(tab());
    expect(html).toContain("الأعمال النشطة ضمن النافذة المحمّلة: 13");
    expect(html).toContain("علامات غير «مدفوع» ضمن النافذة المحمّلة: 28");
    expect(html).toContain("نافذة حتى 300 أمر على مستوى المركز");
    expect(html).toContain("مقارنة أوامر المختبر"); expect(html).not.toContain("تسوية كشف المعمل");
    expect(html).toContain('href="/finance/lab-accounting"'); expect(html).toContain("كشوفات المختبرات الموسعة");
  });
  it.each(["loading", "error"] as const)("does not turn %s state into a zero or reuse lab rows", (phase) => {
    const unavailable: LabBalanceReadState = { phase, data: null };
    const card = moneyCard(kpi(unavailable)); const section = labSection(tab(unavailable));
    expect(card).not.toContain("<bdi"); expect(section).not.toContain("<bdi");
    expect(section).not.toContain("Debit and credit lab"); expect(section).not.toContain("الرصيد الصافي صفر في جميع العملات");
    expect(section).toContain(phase === "loading" ? "جارٍ التحقق" : "هذا لا يعني أن الرصيد صفر");
  });
  it("hides the financial sections when authority is unavailable", () => {
    const unavailable: LabBalanceReadState = { phase: "unavailable", data: null };
    expect(kpi(unavailable)).not.toContain("صافي أرصدة المختبرات بكل عملة");
    expect(tab(unavailable)).not.toContain('aria-label="أرصدة المختبرات"');
    expect(tab(unavailable)).toContain('href="/finance/lab-accounting"');
  });
  it("renders verified empty buckets as explicit zero, and empty catalog separately", () => {
    const empty = projectLabBalanceOverview([{ id: 1, name: "Verified zero lab", kind: "lab", currency: "YER", phone: null }], [], state.data.observedAt);
    expect(labSection(tab({ phase: "ready", data: empty }))).toContain("الرصيد الصافي صفر في جميع العملات");
    const none = projectLabBalanceOverview([], [], state.data.observedAt);
    expect(labSection(tab({ phase: "ready", data: none }))).toContain("لا توجد مختبرات في القائمة المقروءة");
    expect(tab({ phase: "ready", data: none })).not.toContain("لا توجد مختبرات مسجلة أو مستحقات معلقة");
  });
});
