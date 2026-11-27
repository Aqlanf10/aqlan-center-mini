import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReportView } from "../components/reports/ReportView";
import { moneyText } from "../components/reports/shared";
import { SettingsProvider } from "../components/SettingsProvider";
import { parseReportView } from "../lib/report-view";
import type { ReportColumn, ReportResult, ReportRow } from "../lib/reports-types";

const columns: ReportColumn[] = [
  { key: "patientName", label: "المريض", type: "text" },
  { key: "balanceMinor", label: "المتبقي", type: "money", currencyKey: "currency", stackCurrencyTotals: true },
  { key: "paidMinor", label: "المسدّد", type: "money" },
  { key: "referenceMinor", label: "مرجع غير قابل للجمع", type: "money", aggregate: "none" },
  { key: "category", label: "المجموعة", type: "text" },
];
const rows: ReportRow[] = [
  { patientName: "Synthetic A", category: "مجموعة أ", balanceMinor: 170, currency: "YER", paidMinor: 1, referenceMinor: 1900 },
  { patientName: "Synthetic B", category: "مجموعة أ", balanceMinor: 200, currency: "SAR", paidMinor: 2, referenceMinor: 1900 },
  { patientName: "Synthetic C", category: "مجموعة أ", balanceMinor: 30, currency: "YER", paidMinor: 3, referenceMinor: 1900 },
  { patientName: "Synthetic D", category: "مجموعة ب", balanceMinor: -40, currency: "YER", paidMinor: 4, referenceMinor: 1900 },
  { patientName: "Synthetic E", category: "مجموعة ب", balanceMinor: 125, currency: "USD", paidMinor: 5, referenceMinor: 1900 },
];
const result: ReportResult = {
  report: "debt", title: "تقرير اصطناعي", from: "2026-01-01", to: "2026-01-31",
  periodLabel: "فترة اصطناعية", filtersLabel: "مرشح اصطناعي", baseCurrency: "YER", kpis: [],
  columns, rows,
};
const names = { "clinic.name": "مركز اصطناعي" };
const summary = [
  { label: "مجموع مجموعة أ", balances: [moneyText(200,"YER"), moneyText(200,"SAR")], paid: 6 },
  { label: "مجموع مجموعة ب", balances: [moneyText(-40,"YER"), moneyText(125,"USD")], paid: 9 },
  { label: "الإجمالي (5 صفًا)", balances: [moneyText(160,"YER"), moneyText(200,"SAR"), moneyText(125,"USD")], paid: 15 },
];

function render(columnKeys: string, grouped = true, stackCurrencyTotals = true) {
  const view = parseReportView(new URLSearchParams({ columns: columnKeys, ...(grouped ? { group: "category" } : {}) }));
  const displayedResult = stackCurrencyTotals ? result : {
    ...result, columns: columns.map((column) => column.key === "balanceMinor" ? { ...column, stackCurrencyTotals } : column),
  };
  return renderToStaticMarkup(<SettingsProvider value={names}>
    <ReportView result={displayedResult} clinicName={names["clinic.name"]} view={view}
      generated={{ at: "2026-01-31T03:00:00Z", by: "Synthetic reporter", clinicTimeZone: "Asia/Aden" }}
      printHref="/print/report?report=debt" onViewChange={() => {}} onPatientClick={() => {}} />
  </SettingsProvider>);
}
function plain(html: string) {
  return html.replace(/<[^>]+>/g, "");
}
function headings(html: string) {
  const head = html.match(/<thead>(.*?)<\/thead>/s)?.[1] ?? "";
  return [...head.matchAll(/<th\b[^>]*>(.*?)<\/th>/gs)].map((match) => plain(match[1]));
}
function totalCells(html: string, label: string) {
  const possible = [...html.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/gs)]
    .map((row) => [...row[1].matchAll(/<td\b[^>]*>(.*?)<\/td>/gs)].map((cell) => cell[1]))
    .filter((cells) => plain(cells[0] ?? "").startsWith(label));
  expect(possible, label).toHaveLength(1);
  return possible[0];
}
function currencySpans(cell: string) {
  return [...cell.matchAll(/<span\b[^>]*data-report-currency-total=""[^>]*>(.*?)<\/span>/gs)].map((match) => plain(match[1]));
}

describe("ReportView screen totals with customized column positions", () => {
  it.each([
    { keys: "balanceMinor,patientName", labels: ["المتبقي","المريض"], paidIndex: -1 },
    { keys: "balanceMinor", labels: ["المتبقي"], paidIndex: -1 },
    { keys: "balanceMinor,paidMinor,referenceMinor", labels: ["المتبقي","المسدّد","مرجع غير قابل للجمع"], paidIndex: 1 },
  ])("keeps grouped and grand totals when $keys leads", ({ keys, labels, paidIndex }) => {
    const before = structuredClone(result);
    const html = render(keys);
    expect(headings(html)).toEqual(labels);
    expect(html.match(/<tfoot>/g)).toHaveLength(1);
    expect(html).toContain('href="/print/report?report=debt"');
    for (const { label, balances, paid } of summary) {
      const cells = totalCells(html, label);
      expect(cells).toHaveLength(labels.length); // Preserve the table grid.
      expect(plain(cells[0])).toBe(label + balances.join(""));
      expect(currencySpans(cells[0])).toEqual(balances);
      expect(cells[0]).toMatch(/<span class="[^"]*\bprint:hidden\b/);
      if (paidIndex >= 0) {
        expect(plain(cells[paidIndex])).toBe(moneyText(paid, "YER"));
        expect(plain(cells[2])).toBe("");
      } else {
        expect(cells.slice(1).map(plain)).toEqual(labels.slice(1).map(() => ""));
      }
    }
    expect(result).toEqual(before);
  });

  it("keeps legacy first text label and single monetary cell without duplication", () => {
    const html = render("patientName,balanceMinor");
    expect(headings(html)).toEqual(["المريض", "المتبقي"]);
    for (const { label, balances } of summary) {
      const cells = totalCells(html, label);
      expect(cells).toHaveLength(2);
      expect(plain(cells[0])).toBe(label);
      expect(currencySpans(cells[1])).toEqual(balances);
    }
  });

  it("retains the existing inline currency separator for a leading unstacked debt total", () => {
    const html = render("balanceMinor", true, false);
    for (const { label, balances } of summary) {
      const [cell] = totalCells(html, label);
      expect(plain(cell)).toBe(label + balances.join(" · "));
      expect(currencySpans(cell)).toEqual([]);
    }
  });

  it("uses the same first-cell aggregate without grouping and respects non-aggregating money", () => {
    const ungrouped = render("balanceMinor", false);
    expect(ungrouped).not.toContain("مجموع مجموعة");
    expect(currencySpans(totalCells(ungrouped, summary[2].label)[0])).toEqual(summary[2].balances);

    const nonsummableFirst = render("referenceMinor,paidMinor");
    for (const { label, paid } of summary) {
      const cells = totalCells(nonsummableFirst, label);
      expect(cells.map(plain)).toEqual([label, moneyText(paid,"YER")]);
    }
    const noTotals = render("referenceMinor");
    expect(noTotals).not.toContain("<tfoot>");
    expect(noTotals).not.toContain("مجموع مجموعة");
  });
});
