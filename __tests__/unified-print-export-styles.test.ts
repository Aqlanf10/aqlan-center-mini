import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportLabAccountingToExcel, type LabAccountingExportRow } from "../lib/labAccountingExport";
import { exportExpenseBudgetToExcel } from "../lib/expenseBudgetExport";
import type { Currency } from "../lib/money";
import { expenseCategoriesFixture } from "./fixtures/expense-categories";
import golden from "./fixtures/unified-print-export-cell-golden.json";

let downloaded: Blob;
const click = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2031-01-15T08:00:00.000Z"));
  vi.spyOn(URL, "createObjectURL").mockImplementation(blob => { downloaded = blob as Blob; return "blob:synthetic"; });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.stubGlobal("document", { createElement: () => ({ click, remove: vi.fn() }), body: { appendChild: vi.fn(), removeChild: vi.fn() } });
  click.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function inputs(currency: Currency, count: number) {
  const rows: LabAccountingExportRow[] = Array.from({ length: count }, (_, i) => ({
    id: 100 + i, name: `مختبر اصطناعي طويل الاسم ${i} & <tag> "quote" 'apostrophe'`, currency, isActive: i === 0,
    deliveryDays: 7 + i, expenseAccountCode: `EXP-${i}`, expenseAccountName: "حساب اصطناعي", payableAccountCode: `PAY-${i}`,
    payableAccountName: "مورد اصطناعي", autoPostJournal: i === 0, customAccountName: i === 0 ? null : "ربط خاص",
    activeOrdersCount: i + 1, totalOrdersCount: i + 4, totalOwedMinor: 123456 + i, totalPaidMinor: 23456 + i,
    dueMinor: 100000, lastOrderDate: i === 0 ? "2031-01-01" : null,
  }));
  const categories = Array.from({ length: count }, (_, i) => ({ ...expenseCategoriesFixture.categories[0],
    id: 100 + i, key: `SYNTHETIC-${i}`, name: `بند اصطناعي طويل ${i} & <tag> "quote" 'apostrophe'`, isActive: i === 0,
    monthlyBudgetMinor: 123456 + i, annualBudgetMinor: 1481472 + i, actualSpentMinor: 223456 + i, varianceMinor: -100000,
    isOverBudget: true, consumptionPercent: 181, variancePercent: 81, expensesCount: 3 + i,
    description: i === 0 ? "وصف اصطناعي طويل دون حذف" : null,
  }));
  return { rows, categories };
}
function style(xml: string, id: string) {
  return xml.match(new RegExp(`<Style ss:ID="${id}"[\\s\\S]*?</Style>`))?.[0] ?? "";
}

/** Golden digests were captured from the unmodified main-base generators before
 * their style-only migration. Each digest includes every XML Data node verbatim,
 * including ss:Type, escaping, numeric precision, native currency and row order. */
describe.each(["YER", "SAR", "USD"] as const)("styled export identity / %s data integrity", currency => {
  it.each([0, 2])("preserves every typed XML cell for %s synthetic rows", async count => {
    const source = inputs(currency, count);
    const before = structuredClone(source);
    for (const kind of ["lab", "expense"] as const) {
      if (kind === "lab") exportLabAccountingToExcel({ clinicName: "مركز اصطناعي & <safe>", baseCurrency: currency, rows: source.rows, generatedDate: "2031-01-15", filterLabel: "مرشح اصطناعي" });
      else exportExpenseBudgetToExcel({ clinicName: "مركز اصطناعي & <safe>", baseCurrency: currency, categories: source.categories, month: "2031-01", generatedDate: "2031-01-15" });
      expect(downloaded.type).toBe("application/vnd.ms-excel;charset=utf-8");
      const xml = await downloaded.text();
      const cells = xml.match(/<Data\s+ss:Type="[^"]+">[\s\S]*?<\/Data>/g) ?? [];
      const expected = golden[`${kind}-${currency}-${count}` as keyof typeof golden];
      expect(cells).toHaveLength(expected.count);
      expect(createHash("sha256").update(cells.join("\n")).digest("hex")).toBe(expected.sha256);
      expect(source).toEqual(before);
      const header = style(xml, kind === "lab" ? "TableHeader" : "ColHeader");
      expect(header).toContain('ss:Color="#1A3A5C"');
      expect(header).toContain('ss:Color="#E2E8F0"');
      expect(header).toContain('ss:Size="10"');
      expect(header).toContain('ss:FontName="Segoe UI"');
      if (kind === "lab") {
        expect(style(xml, "MoneyDueCell")).toContain('ss:Color="#E11D48"');
        expect(style(xml, "AutoPostActive")).toContain('ss:Color="#047857"');
      } else {
        expect(style(xml, "CellStatusDeficit")).toContain('ss:Color="#991B1B"');
        expect(style(xml, "CellStatusSurplus")).toContain('ss:Color="#166534"');
        expect(xml).toContain('<Layout x:Orientation="Landscape"/>');
        expect(xml).toContain('<FitHeight>0</FitHeight>');
      }
    }
    expect(click).toHaveBeenCalledTimes(2);
  });
});
