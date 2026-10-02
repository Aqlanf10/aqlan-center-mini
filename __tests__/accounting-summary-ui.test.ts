import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountingReportsTab } from "../components/finance/AccountingReportsTab";
import { accountingPeriod } from "../lib/accounting-reports";
import { type JournalEntry } from "../lib/accounting";

const entries: JournalEntry[] = [
  { date: "2026-09-30", source: "manual", reference: "OPEN", description: "Synthetic opening", lines: [
    { accountCode: "1101", currency: "YER", amountMinor: 10_000, side: "debit" },
    { accountCode: "3101", currency: "YER", amountMinor: 10_000, side: "credit" },
    { accountCode: "1102", currency: "SAR", amountMinor: 50_000, side: "debit" },
    { accountCode: "2101", currency: "SAR", amountMinor: 50_000, side: "credit" },
  ] },
  { date: "2026-10-01", source: "expense", reference: "SPEND", description: "Synthetic payment", lines: [
    { accountCode: "5502", currency: "YER", amountMinor: 2_000, side: "debit" },
    { accountCode: "1101", currency: "YER", amountMinor: 2_000, side: "credit" },
  ] },
];
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const render = (from: string) => {
  const report = accountingPeriod(entries, from, "2026-10-02");
  return renderToStaticMarkup(createElement(AccountingReportsTab, {
    readState: "ready", error: null, onRetry: () => {},
    balances: report.balances, cumulativeBalances: report.cumulativeBalances,
    throughDate: "2026-10-02", baseCurrency: "YER", isAdmin: true, entryCount: report.entryCount,
  }));
};

describe("accounting overview time scopes", () => {
  it("shows cumulative assets but selected-period income and includes opening-only currency", () => {
    const html = render("2026-10-01");
    const yer = text(html.split('data-testid="accounting-summary-YER"')[1].split('data-testid="accounting-summary-SAR"')[0]);
    expect(yer).toMatch(/إجمالي الأصول\s+8,000/);
    expect(yer).toMatch(/صافي ربح الفترة\s+-2,000/);
    expect(yer).toContain("رصيد تراكمي حتى 2026-10-02");
    const sar = text(html.split('data-testid="accounting-summary-SAR"')[1]);
    expect(sar).toMatch(/إجمالي الأصول\s+500/);
    expect(sar).toMatch(/إجمالي الخصوم\s+500/);
    expect(sar).toMatch(/صافي ربح الفترة\s+0/);
  });

  it("keeps closing balances visible when the selected period has no entries", () => {
    const html = render("2026-10-02");
    expect(html).toContain('data-testid="accounting-summary-YER"');
    expect(html).toContain('data-testid="accounting-summary-SAR"');
    expect(text(html)).toMatch(/إجمالي الأصول\s+8,000/);
    expect(text(html)).toMatch(/صافي ربح الفترة\s+0/);
    expect(text(html)).not.toContain("لا قيود حتى تاريخ التقرير");
  });
});


describe("accounting summary read status", () => {
  it.each(["loading", "error"] as const)("withholds stale amounts and empty-history claims during %s", (readState) => {
    const report = accountingPeriod(entries, "2026-10-01", "2026-10-02");
    const html = renderToStaticMarkup(createElement(AccountingReportsTab, {
      readState, error: readState === "error" ? "Synthetic integrity conflict" : null, onRetry: () => {},
      balances: report.balances, cumulativeBalances: report.cumulativeBalances, throughDate: "2026-10-02",
      baseCurrency: "YER", isAdmin: true, entryCount: report.entryCount,
    }));
    expect(html).not.toContain('data-testid="accounting-summary-');
    expect(text(html)).not.toContain("8,000");
    expect(text(html)).not.toContain("لا قيود حتى تاريخ التقرير");
    expect(text(html)).not.toContain("المدين يساوي الدائن في كل عملة");
    expect(text(html)).toContain(readState === "loading" ? "جارٍ تحميل الدفاتر المحاسبية" : "Synthetic integrity conflict");
    if (readState === "error") expect(text(html)).toContain("إعادة تحميل الدفاتر");
  });

  it("uses precise arithmetic-balance wording and distinguishes cash reconciliation", () => {
    const content = text(render("2026-10-01"));
    expect(content).toContain("المدين يساوي الدائن في كل عملة");
    expect(content).toContain("مطابقة النقد الفعلي مع الصندوق فحص مستقل");
    expect(content).not.toContain("100%");
    expect(content).not.toContain("ضمان عدم ضياع");
  });

  it("shows no entries only after a successful empty response", () => {
    const html = renderToStaticMarkup(createElement(AccountingReportsTab, {
      readState: "ready", error: null, onRetry: () => {}, balances: [], cumulativeBalances: [],
      throughDate: "2026-10-02", baseCurrency: "YER", isAdmin: true, entryCount: 0,
    }));
    expect(text(html)).toContain("لا قيود حتى تاريخ التقرير");
  });
});


it("hides retained summary values and arithmetic assurance immediately without effective report access", () => {
  const report = accountingPeriod(entries, "2026-10-01", "2026-10-02");
  const html = renderToStaticMarkup(createElement(AccountingReportsTab, {
    readState: "ready", error: null, onRetry: () => {}, balances: report.balances,
    cumulativeBalances: report.cumulativeBalances, throughDate: "2026-10-02",
    baseCurrency: "YER", isAdmin: false, entryCount: report.entryCount,
  }));
  expect(html).not.toContain('data-testid="accounting-summary-');
  expect(text(html)).not.toContain("8,000");
  expect(text(html)).not.toContain("المدين يساوي الدائن في كل عملة");
  expect(text(html)).not.toContain("لا قيود حتى تاريخ التقرير");
  expect(text(html)).toContain("الدفاتر المحاسبية العامة وميزان المراجعة مخصصة للإدارة العليا والمدقق المالي");
});
