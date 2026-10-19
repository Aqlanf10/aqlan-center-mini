import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportExpenseBudgetToExcel } from "../../lib/expenseBudgetExport";
import { MINOR_UNITS, formatMoney, type Currency } from "../../lib/money";
import { expenseCategoriesFixture } from "../fixtures/expense-categories";
import type { ExpenseCategoryDTO } from "../../lib/db";

let browser: Browser, page: Page, downloaded: Blob;
const click = vi.fn();
const template = expenseCategoriesFixture.categories[0];
function category(id: number, budget: number, spent: number, count = 1): ExpenseCategoryDTO {
  return { ...template, id, key: `synthetic-${id}`, name: `Synthetic ${id}`, monthlyBudgetMinor: budget,
    annualBudgetMinor: budget * 12, actualSpentMinor: spent, budgetMinor: budget, varianceMinor: budget - spent,
    consumptionPercent: budget > 0 ? Math.round(spent / budget * 100) : 0,
    variancePercent: budget > 0 ? Math.round((spent - budget) / budget * 100) : spent > 0 ? 100 : 0,
    isOverBudget: budget > 0 && spent > budget, expensesCount: count };
}
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  page = await browser.newPage();
});
afterAll(async () => { await browser?.close(); });
beforeEach(() => {
  click.mockClear();
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => { downloaded = blob as Blob; return "blob:synthetic"; });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.stubGlobal("document", { createElement: () => ({ click }), body: { appendChild: vi.fn(), removeChild: vi.fn() } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function workbook(categories: ExpenseCategoryDTO[], currency: Currency = "YER") {
  // Deliberately stale full-catalogue totals. The export must derive its own scope.
  const params = { clinicName: "Synthetic clinic", month: "2026-10", generatedDate: "2026-10-19",
    categories, baseCurrency: currency, summary: { ...expenseCategoriesFixture.summary,
      totalCategories: 2, activeCategories: 2, totalMonthlyBudgetMinor: 1000,
      totalActualSpentMinor: 600, totalVarianceMinor: 400, totalExpensesCount: 2,
      overallConsumptionPercent: 60, overallVariancePercent: -40, overBudgetCount: 0 } };
  exportExpenseBudgetToExcel(params);
  expect(click).toHaveBeenCalledOnce();
  expect(downloaded.type).toBe("application/vnd.ms-excel;charset=utf-8");
  const xml = await downloaded.text();
  const cells = await page.evaluate((source) => {
    const doc = new DOMParser().parseFromString(source, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("Invalid workbook XML");
    const ns = "urn:schemas-microsoft-com:office:spreadsheet";
    return Array.from(doc.getElementsByTagNameNS(ns, "Row")).map((row) => {
      let column = 1;
      return Array.from(row.getElementsByTagNameNS(ns, "Cell")).map((cell) => {
        column = Number(cell.getAttributeNS(ns, "Index") || column);
        const data = cell.getElementsByTagNameNS(ns, "Data")[0];
        const result = { column, style: cell.getAttributeNS(ns, "StyleID"), type: data?.getAttributeNS(ns, "Type"), value: data?.textContent ?? "" };
        column += 1 + Number(cell.getAttributeNS(ns, "MergeAcross") || 0);
        return result;
      });
    });
  }, xml);
  const total = cells.find((row) => row[0]?.style === "TotalHeader")!;
  const rows = cells.filter((row) => row.some((cell) => cell.style === "CellBold"));
  const kpis = cells.find((row) => row[0]?.style === "KpiVal")!;
  return { xml, cells, total, rows, kpis };
}
function at(row: Awaited<ReturnType<typeof workbook>>["total"], column: number) {
  return row.find((cell) => cell.column === column)?.value;
}

describe("downloaded expense workbook uses exactly its exported rows", () => {
  it("exports a filtered 100 budget row with a 100 total, not the global 1000", async () => {
    const result = await workbook([category(1, 100, 40, 2)]);
    if (process.env.FIN010_EVIDENCE_DIR) {
      await mkdir(process.env.FIN010_EVIDENCE_DIR, { recursive: true });
      await writeFile(`${process.env.FIN010_EVIDENCE_DIR}/filtered.xls`, result.xml);
      await writeFile(`${process.env.FIN010_EVIDENCE_DIR}/cells.json`, JSON.stringify(result.cells, null, 2));
    }
    expect(at(result.rows[0], 7)).toBe("100.00");
    expect(at(result.total, 7)).toBe("100.00");
    expect(at(result.total, 8)).toBe("40.00");
    expect(at(result.total, 9)).toBe("60.00");
    expect(at(result.total, 12)).toBe("2");
    expect(result.kpis[0].value).toBe(formatMoney(100, "YER"));
    expect(result.kpis[1].value).toBe(formatMoney(40, "YER"));
  });
  it("preserves all-data totals when the full catalogue is exported", async () => {
    const result = await workbook([category(1, 100, 40), category(2, 900, 560)]);
    expect(result.rows).toHaveLength(2);
    expect(at(result.total, 7)).toBe("1000.00");
    expect(at(result.total, 8)).toBe("600.00");
    expect(at(result.total, 9)).toBe("400.00");
    expect(at(result.total, 10)).toBe("-40%");
    expect(at(result.total, 11)).toBe("60%");
  });
  it("preserves all rows and computes ratios from sums, not row averages", async () => {
    const result = await workbook([category(1, 100, 50, 2), category(2, 900, 900, 3)]);
    expect(result.rows).toHaveLength(2);
    expect(at(result.total, 7)).toBe("1000.00");
    expect(at(result.total, 8)).toBe("950.00");
    expect(at(result.total, 9)).toBe("50.00");
    expect(at(result.total, 10)).toBe("-5%");
    expect(at(result.total, 11)).toBe("95%");
    expect(at(result.total, 12)).toBe("5");
  });
  it.each(["YER", "SAR", "USD"] as const)("retains %s minor-unit scaling", async (currency) => {
    const result = await workbook([category(1, 12345, 6789)], currency);
    expect(at(result.total, 7)).toBe((12345 / MINOR_UNITS[currency]).toFixed(2));
    expect(at(result.total, 8)).toBe((6789 / MINOR_UNITS[currency]).toFixed(2));
    expect(at(result.rows[0], 13)).toBe((12345 * 12 / MINOR_UNITS[currency]).toFixed(2));
  });
  it.each([
    [100, 150, "-50.00", "+50%", "150%"],
    [100, -25, "125.00", "-125%", "-25%"],
    [0, 0, "0.00", "0%", "0%"],
    [0, 25, "-25.00", "+100%", "0%"],
    [0, -25, "25.00", "0%", "0%"],
  ] as const)("handles budget %s and signed actual %s", async (budget, actual, variance, variancePercent, consumption) => {
    const result = await workbook([category(1, budget, actual)]);
    expect(at(result.total, 9)).toBe(variance);
    expect(at(result.total, 10)).toBe(variancePercent);
    expect(at(result.total, 11)).toBe(consumption);
    expect(result.xml).not.toMatch(/NaN|Infinity/);
  });
  it("exports empty selection as zero totals and ratios", async () => {
    const result = await workbook([]);
    expect(result.rows).toHaveLength(0);
    for (const column of [7, 8, 9]) expect(at(result.total, column)).toBe("0.00");
    for (const column of [10, 11]) expect(at(result.total, column)).toBe("0%");
    expect(at(result.total, 12)).toBe("0");
    expect(result.kpis[4].value).toBe("0 من أصل 0");
  });
  it("includes an exported inactive row's values in totals", async () => {
    const result = await workbook([{ ...category(1, 100, 150), isActive: false }]);
    expect(at(result.total, 7)).toBe("100.00");
    expect(at(result.total, 8)).toBe("150.00");
    expect(result.kpis[4].value).toBe("1 من أصل 1");
  });
});
