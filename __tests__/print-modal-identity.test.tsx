import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import printStyles from "../components/PrintReportModal.module.css";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExpenseBudgetReportModal } from "../components/ExpenseBudgetReportModal";
import { LabAccountingAuditReportModal } from "../components/LabAccountingAuditReportModal";
import { LabPricingReportModal } from "../components/LabPricingReportModal";
import { expenseCategoriesFixture as fixture } from "./fixtures/expense-categories";
import { formatAmount, formatMoney, type Currency } from "../lib/money";
import type { LabAccountingExportRow } from "../lib/labAccountingExport";
import type { LabPricingRule, LabService } from "../lib/lab";
import { PrintDocumentWatermark } from "../components/PrintDocument";

vi.mock("../components/SettingsProvider", () => ({ useSetting: (key: string) => ({
  "clinic.name": "مركز صناعي لفحص الطباعة", "clinic.lead_doctor": "طبيب صناعي",
  "clinic.lead_doctor_title": "اختبار", "clinic.lead_doctor_credentials": "",
  "clinic.phone": "000-111-222", "clinic.address": "عنوان صناعي فقط",
}[key] ?? "") }));

const table = (html: string) => html.match(/<table\b[\s\S]*?<\/table>/)?.[0] ?? "";
const columns = (html: string) => (table(html).match(/<th[ >]/g) ?? []).length;
const bodyRows = (html: string) => (table(html).match(/<tbody\b[\s\S]*?<\/tbody>/)?.[0].match(/<tr[ >]/g) ?? []).length;
const commonIdentity = (html: string) => {
  expect(html).toContain('class="print-brand-header"');
  expect(html).toContain('class="print-report-footer"');
  expect(html).toContain("print-metadata");
  expect(html).toContain('class="print-table-watermark" aria-hidden="true"');
  expect(html).toContain("مركز صناعي لفحص الطباعة");
  expect(html).toContain("عنوان صناعي فقط");
  expect(html).toContain('dir="ltr">000-111-222');
};

/** Optional local evidence: rendered source markup plus actual project styles.
 * This creates synthetic HTML only, never browser/PDF acceptance evidence. */
function writeSyntheticHtml(name: string, markup: string) {
  const directory = process.env.UNIFIED_PRINT_ARTIFACT_DIR;
  const tailwindPath = process.env.UNIFIED_PRINT_TAILWIND_CSS;
  if (!directory || !tailwindPath) return;
  mkdirSync(directory, { recursive: true });
  const moduleCss = readFileSync(new URL("../components/PrintReportModal.module.css", import.meta.url), "utf8")
    .replace(/:global\(([^)]+)\)/g, "$1")
    .replace(/\.modal\b/g, `.${printStyles.modal}`)
    .replace(/\.landscape\b/g, `.${printStyles.landscape}`);
  const css = [readFileSync(tailwindPath, "utf8"), readFileSync(new URL("../components/print-document.css", import.meta.url), "utf8"), moduleCss].join("\n");
  const logo = `data:image/png;base64,${readFileSync(new URL("../public/logo.png", import.meta.url)).toString("base64")}`;
  const watermark = renderToStaticMarkup(<PrintDocumentWatermark />).replaceAll('src="/logo.png"', `src="${logo}"`);
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>Synthetic print identity evidence</title><style>${css}</style></head><body>${watermark}<div>SYNTHETIC-SCREEN-ONLY</div><main><section><p>SYNTHETIC-SIBLING-NOT-PRINTED</p>${markup.replaceAll('src="/logo.png"', `src="${logo}"`)}</section></main></body></html>`;
  writeFileSync(resolve(directory, `${name}.html`), html);
}

describe("unified report-modal print identity (synthetic SSR, not browser proof)", () => {
  it.each<Currency>(["YER", "SAR", "USD"])("retains expense columns, source amounts and input for %s", baseCurrency => {
    const categories = structuredClone(fixture.categories);
    const before = structuredClone(categories);
    const html = renderToStaticMarkup(<ExpenseBudgetReportModal categories={categories} summary={fixture.summary} month="2031-02" baseCurrency={baseCurrency} onClose={() => {}} />);
    commonIdentity(html);
    expect(columns(html)).toBe(10);
    expect(bodyRows(html)).toBe(categories.length);
    expect(table(html)).toContain(formatMoney(categories[0].monthlyBudgetMinor, baseCurrency));
    expect(table(html)).toContain(formatMoney(categories[0].actualSpentMinor, baseCurrency));
    expect(table(html)).toContain(formatMoney(categories[0].varianceMinor, baseCurrency));
    expect(html).toContain("2031-02");
    expect(html).toContain("<bdi>2031-02</bdi>");
    expect(categories).toEqual(before);
  });

  it("retains all 80 expense rows and financial columns without mutating inputs", () => {
    const categories = Array.from({ length: 80 }, (_, index) => ({ ...fixture.categories[0], id: 99000 + index,
      key: `synthetic-${index}`, name: `بند مصروف صناعي طويل لفحص الطباعة ${index + 1}`, accountName: `حساب صناعي طويل للاختبار ${index + 1}` }));
    const before = structuredClone(categories);
    const html = renderToStaticMarkup(<ExpenseBudgetReportModal categories={categories} summary={fixture.summary} month="2031-02" baseCurrency="YER" onClose={() => {}} />);
    expect(columns(html)).toBe(10);
    expect(bodyRows(html)).toBe(80);
    for (const row of categories) expect(table(html)).toContain(row.name);
    expect(categories).toEqual(before);
    writeSyntheticHtml("modal-expense-80", html);
  });

  it("keeps every laboratory row, account identity and total in a long statement", () => {
    const mappings: LabAccountingExportRow[] = Array.from({ length: 80 }, (_, index) => ({
      id: 99000 + index, name: `مختبر صناعي طويل الاسم رقم ${index + 1}`, currency: "SAR", isActive: true,
      deliveryDays: 4, expenseAccountCode: `EX-${index}`, expenseAccountName: `حساب مصروف صناعي طويل جدًا ${index}`,
      payableAccountCode: `AP-${index}`, payableAccountName: `حساب ذمة صناعي طويل جدًا ${index}`,
      autoPostJournal: index % 2 === 0, customAccountName: null, activeOrdersCount: index, totalOrdersCount: 100 + index,
      totalOwedMinor: 123456 + index, totalPaidMinor: 23456, dueMinor: 100000 + index, lastOrderDate: null,
    }));
    const before = structuredClone(mappings);
    const html = renderToStaticMarkup(<LabAccountingAuditReportModal mappings={mappings} baseCurrency="SAR" onClose={() => {}} />);
    commonIdentity(html);
    expect(columns(html)).toBe(9);
    expect(bodyRows(html)).toBe(80);
    for (const row of mappings) {
      expect(table(html)).toContain(row.expenseAccountName);
      expect(table(html)).toContain(row.payableAccountName);
      expect(table(html)).toContain(formatMoney(row.dueMinor, "SAR"));
    }
    expect(table(html)).toContain(formatMoney(mappings.reduce((total, row) => total + row.dueMinor, 0), "SAR"));
    expect(mappings).toEqual(before);
    writeSyntheticHtml("modal-lab-accounting-80", html);
  });

  it("retains pricing scope, six columns, native currencies and terms", () => {
    const services: LabService[] = [{ id: 99001, name: "خدمة صناعية طويلة لفحص الطباعة", code: "SYNTH-1", category: "prostho", toothScope: "single_tooth", requiresShade: false, defaultDays: 3, description: null, isActive: true, sortOrder: 1 }];
    const rules: LabPricingRule[] = ["YER", "SAR", "USD"].map((currency, index) => ({ id: 99002 + index, partyId: 99001, labServiceId: 99001, costMinor: 123456 + index, costCurrency: currency as Currency, effectiveFrom: "2000-01-01", effectiveTo: null, note: `ملاحظة صناعية ${index}`, createdBy: "synthetic", createdAt: "2000-01-01" }));
    rules.push({ ...rules[0], id: 99999, effectiveTo: "2001-01-01", note: "EXPIRED_SYNTHETIC_RULE" });
    const before = structuredClone(rules);
    const html = renderToStaticMarkup(<LabPricingReportModal laboratories={[{ id: 99001, name: "مختبر صناعي", currency: "SAR", isActive: true, deliveryDays: 4 }]} services={services} rules={rules} onClose={() => {}} />);
    commonIdentity(html);
    expect(columns(html)).toBe(6);
    expect(bodyRows(html)).toBe(3);
    for (const rule of rules.slice(0, 3)) expect(table(html)).toContain(formatAmount(rule.costMinor, rule.costCurrency));
    expect(table(html)).not.toContain("EXPIRED_SYNTHETIC_RULE");
    expect(html).toContain("الشروط والضوابط الفنية المتفق عليها");
    expect(rules).toEqual(before);
    writeSyntheticHtml("modal-lab-pricing-six-columns", html);
  });

  it("keeps explicit empty states without inventing rows", () => {
    const expense = renderToStaticMarkup(<ExpenseBudgetReportModal categories={[]} summary={fixture.summary} month="2031-02" onClose={() => {}} />);
    const audit = renderToStaticMarkup(<LabAccountingAuditReportModal mappings={[]} onClose={() => {}} />);
    expect(bodyRows(expense)).toBe(1);
    expect(bodyRows(audit)).toBe(1);
    expect(expense).toContain('colSpan="10"');
    expect(audit).toContain('colSpan="9"');
  });

  it("scopes print isolation and pagination without hiding document headers", () => {
    const css = readFileSync(new URL("../components/PrintReportModal.module.css", import.meta.url), "utf8");
    expect(css).toContain(":global(body):has(.modal)");
    expect(css).toContain(":not(:has(.modal)):not(.modal)");
    expect(css).toContain("@page aqlan-report-modal");
    expect(css).toContain("@page aqlan-report-modal-landscape");
    expect(css).toContain(".modal { page: aqlan-report-modal; }");
    expect(css).toContain(".modal.landscape { page: aqlan-report-modal-landscape; }");
    expect(css).not.toMatch(/@page\s*\{/);
    expect(css).toContain("overflow-wrap: normal; word-break: normal");
    expect(css).toContain("white-space: normal");
    expect(css).toContain("text-overflow: clip");
    expect(css).toContain("overflow: visible !important");
    expect(css).not.toMatch(/(?:^|\n)\s*(?:nav|header|aside)[\s,]/);
    const inventory = readFileSync(new URL("../components/inventory/inventory.module.css", import.meta.url), "utf8");
    expect(inventory).toContain(".root .printRecordGroup { break-inside: auto");
    expect(inventory).toContain(".root .printRecordGroup li { break-inside: avoid");
  });
});
