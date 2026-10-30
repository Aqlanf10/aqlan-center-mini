import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VisibleFinanceSummary } from "../lib/finance-report-visibility";
import type { ValuedInventoryItem } from "../lib/inventory-domain/read";
import type { LabPricingRule, LabService } from "../lib/lab";
import { formatMoney } from "../lib/money";
import { dailyClinicReportFixture } from "./fixtures/daily-clinic-report";

// Only seed completed read-state: SSR cannot run the components' fetch effects.
// No handler, request, financial projection, or database mutation is exercised.
const seed = vi.hoisted(() => ({ kind: "" as "" | "inventory" | "finance", value: null as unknown, used: false }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => {
    if (seed.kind && initial === null && !seed.used) { seed.used = true; return actual.useState(seed.value); }
    if (seed.kind === "finance" && initial === true) return actual.useState(false);
    return actual.useState(initial);
  } };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ username: "synthetic-admin", role: "admin" }) }));
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "مركز صناعي لفحص جميع المطبوعات", useSetting: (key: string) => ({
  "clinic.name": "مركز صناعي لفحص جميع المطبوعات", "clinic.lead_doctor": "طبيب صناعي", "clinic.lead_doctor_title": "اختبار العرض",
  "clinic.lead_doctor_credentials": "", "clinic.phone": "000-000000", "clinic.address": "عنوان صناعي فقط",
}[key] ?? "") }));

import { PrintDocumentWatermark } from "../components/PrintDocument";
import { InventoryValuationReview } from "../components/inventory/InventoryValuationReview";
import { DailyClinicReportBody } from "../app/reports/daily-clinic/DailyClinicReportView";
import { LabPricingReportModal } from "../components/LabPricingReportModal";
import FinanceReportsPage from "../app/finance/reports/page";
import inventoryStyles from "../components/inventory/inventory.module.css";
import dailyStyles from "../app/reports/daily-clinic/daily-clinic-report.module.css";
import modalStyles from "../components/PrintReportModal.module.css";

const compose = (node: ReactNode) => {
  const html = renderToStaticMarkup(<><PrintDocumentWatermark />{node}</>);
  expect(html.match(/class="print-document-watermark"/g)).toHaveLength(1);
  expect(html).toContain("print-brand-header");
  return html;
};
function cssModule(path: string, mapping: Record<string, string>) {
  const globals: string[] = [];
  // Vitest exposes CSS modules as a property proxy: Object.entries may be empty.
  // Extract local selectors from the source, shielding explicit globals first.
  let css = readFileSync(resolve(path), "utf8").replace(/:global\(([^)]+)\)/g, (_match, selector: string) => {
    globals.push(selector); return `___GLOBAL_SELECTOR_${globals.length - 1}___`;
  });
  const localNames = new Set([...css.matchAll(/\.([_a-zA-Z][\w-]*)/g)].map(match => match[1]));
  for (const name of localNames) {
    const generated = mapping[name];
    expect(generated).toBeTypeOf("string");
    css = css.replace(new RegExp(`\\.${name}(?![\\w-])`, "g"), `.${generated}`);
  }
  css = css.replace(/___GLOBAL_SELECTOR_(\d+)___/g, (_match, index: string) => globals[Number(index)]);
  for (const root of ["root", "modal", "report"]) if (localNames.has(root)) {
    expect(mapping[root]).not.toBe(root);
    expect(css).toContain(`.${mapping[root]}`);
    expect(css).not.toMatch(new RegExp(`\\.${root}(?![\\w-])`));
  }
  return css;
}
function artifact(name: string, markup: string, modules: string[] = []) {
  if (!process.env.PRINT_RENDER_OUTPUT) return;
  const directory = resolve(process.env.PRINT_RENDER_OUTPUT); mkdirSync(directory, { recursive: true });
  const tailwind = process.env.PRINT_RENDER_TAILWIND_CSS;
  if (!tailwind) throw new Error("Report visual fixtures require the compiled project Tailwind CSS");
  const css = [readFileSync(resolve(tailwind), "utf8"), readFileSync(resolve("components/print-document.css"), "utf8"), ...modules].join("\n");
  const logo = `data:image/png;base64,${readFileSync(resolve("public/logo.png")).toString("base64")}`;
  const body = markup.replaceAll('src="/logo.png"', `src="${logo}"`).replaceAll('href="/logo.png"', `href="${logo}"`);
  writeFileSync(resolve(directory, `${name}.html`), `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>Synthetic report watermark evidence</title><style>${css}</style></head><body>${body}</body></html>`);
}
beforeEach(() => { seed.kind = ""; seed.value = null; seed.used = false; vi.useFakeTimers(); vi.setSystemTime(new Date("2031-01-05T10:00:00Z")); });
afterEach(() => vi.useRealTimers());

describe("one root watermark across actual report families (synthetic SSR, not browser proof)", () => {
  it("retains the full inventory print list and explicit unknown/estimated costs", () => {
    const items: ValuedInventoryItem[] = Array.from({ length: 26 }, (_, index) => ({ id: 99000 + index,
      name: `SYNTHETIC-STOCK-${String(index + 1).padStart(2, "0")} مادة صناعية للاختبار فقط`, category: "synthetic", unit: "وحدة صناعية",
      qty: index + 1, valueMinor: index === 0 ? null : 123400 + index, unitCostMinor: index === 0 ? null : 100,
      costStatus: index === 0 ? "missing" : index === 1 ? "estimated" : "known" }));
    const report = { items, totalMinor: null, knownTotalMinor: 2961924, withoutCost: 1, estimated: 1, baseCurrency: "YER" };
    const before = structuredClone(report); seed.kind = "inventory"; seed.value = { key: "synthetic-admin:0", report };
    const html = compose(<InventoryValuationReview />);
    for (const item of items) expect(html).toContain(item.name);
    expect(html).toContain("التقييم غير مكتمل"); expect(html).toContain('data-state="missing"'); expect(html).toContain('data-state="estimated"');
    expect(html).toContain(formatMoney(report.knownTotalMinor, "YER")); expect(report).toEqual(before);
    // The screen list is paged at 20; the print list includes all 26, unchanged.
    expect(html.match(/<article\b/g)).toHaveLength(46); expect(html).not.toContain("<table");
    const css = readFileSync(resolve("components/inventory/inventory.module.css"), "utf8");
    expect(css).toContain(".root .printMetrics { display: block; direction: rtl; }");
    expect(css).toContain("width: 100%; min-width: 0; grid-column: auto");
    artifact("inventory-record-list-26", html, [cssModule("components/inventory/inventory.module.css", inventoryStyles)]);
  });

  it("keeps financial period cards in native currencies and does not invent hidden expenses", () => {
    const summary: VisibleFinanceSummary = { from: "2031-01-05", to: "2031-01-05",
      income: { byCurrency: { YER: 123400, SAR: 234500, USD: 345600 }, baseTotalMinor: 456700, count: 3 },
      refunds: { baseTotalMinor: 78900, count: 1 }, invoicedByCurrency: { YER: 567800, SAR: 678900, USD: 789000 },
      invoiceCount: 3, patientCount: 3,
      topServices: [{ name: "SYNTHETIC-SERVICE-SAR خدمة صناعية", count: 1, totalMinor: 678900, currency: "SAR" }, { name: "SYNTHETIC-SERVICE-USD خدمة صناعية", count: 1, totalMinor: 789000, currency: "USD" }] };
    const before = structuredClone(summary); seed.kind = "finance"; seed.value = { requestedFrom: summary.from, requestedTo: summary.to, summary };
    const html = compose(<FinanceReportsPage />);
    for (const currency of ["YER", "SAR", "USD"] as const) {
      expect(html).toContain(formatMoney(summary.income.byCurrency[currency], currency));
      expect(html).toContain(formatMoney(summary.invoicedByCurrency[currency], currency));
    }
    expect(html).not.toContain('data-testid="finance-expenses"'); expect(html).not.toContain('data-testid="finance-net"');
    expect(html).not.toContain("<table"); expect(summary).toEqual(before);
    artifact("finance-period-cards", html);
  });

  it.each(["summary", "full"] as const)("preserves all long day-close %s rows, source amounts and appendix scope", scope => {
    const report = dailyClinicReportFixture("2031-01-05", 18); const before = structuredClone(report);
    const html = compose(<article className={dailyStyles.report} data-print-scope={scope} dir="rtl"><DailyClinicReportBody report={report} clinicName="مركز صناعي لفحص جميع المطبوعات" printScope={scope} /></article>);
    expect(html.match(/data-patient-key=/g)).toHaveLength(18);
    for (const row of report.attendees) {
      expect(html).toContain(row.patientNumber!);
      for (const currency of ["YER", "SAR", "USD"] as const) expect(html).toContain(`data-minor="${row.agreement[currency]}" data-currency="${currency}"`);
    }
    expect(html).toContain(`data-print-scope="${scope}"`); expect(html).toContain("SYNTHETIC-RECEIPT-500");
    expect(html).toContain('data-testid="daily-clinic-end"'); expect(report).toEqual(before);
    artifact(`daily-clinic-${scope}-18`, html, [cssModule("app/reports/daily-clinic/daily-clinic-report.module.css", dailyStyles)]);
  });

  it("retains large exact values in the existing separate-currency print appendices", () => {
    const report = dailyClinicReportFixture("2031-01-05", 2);
    // Synthetic source snapshot large enough to select the existing readability
    // path; the component must display, not recompute or narrow these values.
    report.attendees[0].agreement.YER = 9000000000000;
    report.attendees[0].agreementRemaining.YER = 8999999876544;
    report.agreements[0].principalMinor = 9000000000000;
    report.agreements[0].remainingMinor = 8999999876544;
    report.totals.agreement.YER = 9000987654321;
    report.totals.agreementRemaining.YER = 9000987407409;
    const before = structuredClone(report);
    const html = compose(<article className={dailyStyles.report} data-print-scope="full" dir="rtl"><DailyClinicReportBody report={report} clinicName="مركز صناعي لفحص جميع المطبوعات" printScope="full" /></article>);
    expect(html).toContain('data-testid="daily-clinic-currency-panels"');
    expect(html).toContain('data-testid="daily-clinic-recipient-currency-panels"');
    for (const amount of [9000000000000, 8999999876544, 9000987654321, 9000987407409]) expect(html).toContain(`data-minor="${amount}" data-currency="YER"`);
    expect(report).toEqual(before);
    artifact("daily-clinic-currency-appendices", html, [cssModule("app/reports/daily-clinic/daily-clinic-report.module.css", dailyStyles)]);
  });

  it("uses one root logo for two separately paginated lab documents, preserving selected scope", () => {
    const labs = [{ id: 99001, name: "SYNTHETIC-LAB-A مختبر صناعي", currency: "SAR" as const, isActive: true, deliveryDays: 3 },
      { id: 99002, name: "SYNTHETIC-LAB-B مختبر صناعي", currency: "USD" as const, isActive: true, deliveryDays: 5 },
      { id: 99003, name: "SYNTHETIC-INACTIVE-NOT-PRINTED", currency: "YER" as const, isActive: false, deliveryDays: 1 }];
    const services: LabService[] = [{ id: 99100, name: "خدمة صناعية طويلة لفحص الطباعة", code: "SYNTH-SVC-1", category: "prostho", toothScope: "single_tooth", requiresShade: false, defaultDays: 3, description: null, isActive: true, sortOrder: 1 }];
    const rules: LabPricingRule[] = labs.map((lab, index) => ({ id: 99200 + index, partyId: lab.id, labServiceId: 99100, costMinor: 123456 + index, costCurrency: lab.currency, effectiveFrom: "2000-01-01", effectiveTo: null, note: `SYNTHETIC-PRICE-${index}`, createdBy: "synthetic", createdAt: "2000-01-01" }));
    const before = structuredClone([labs, services, rules]);
    const html = compose(<LabPricingReportModal laboratories={labs} services={services} rules={rules} onClose={() => {}} />);
    expect(html.match(/class="print-brand-header"/g)).toHaveLength(2);
    expect(html.match(/<table\b/g)).toHaveLength(2); expect(html).toContain("SYNTHETIC-LAB-A"); expect(html).toContain("SYNTHETIC-LAB-B");
    // Inactive lab may be in screen selector options, but never a print document.
    expect(html.match(/SYNTHETIC-INACTIVE-NOT-PRINTED/g)).toHaveLength(1);
    expect(html).not.toContain("SYNTHETIC-PRICE-2"); expect([labs, services, rules]).toEqual(before);
    artifact("lab-pricing-two-documents", html, [cssModule("components/PrintReportModal.module.css", modalStyles)]);
  });
});
