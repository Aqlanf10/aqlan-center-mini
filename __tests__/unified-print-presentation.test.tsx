import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Invoice, Payment } from "../lib/db";
import type { ReportResult } from "../lib/reports-types";
import { SETTING_DEFAULTS } from "../lib/settings";
import { formatMoney } from "../lib/money";
import { dispatchOrder, DISPATCH_PRIVATE_CANARIES } from "./fixtures/lab-dispatch";

const state = vi.hoisted(() => ({ invoice: null as Invoice | null, payment: null as Payment | null }));
vi.mock("@/lib/session", () => ({ requireSession: async () => ({ role: "admin", username: "synthetic", userId: 9001 }) }));
vi.mock("@/lib/db", async importOriginal => ({ ...await importOriginal<typeof import("../lib/db")>(),
  getInvoice: async () => state.invoice, getPayment: async () => state.payment,
  getPatient: async () => ({ id: 9001, fullName: "مريض عرض صناعي — اسم طويل للاختبار فقط", patientNumber: "SYNTHETIC-9001", phone: null }),
  getSettingsSafe: async () => settings, printCount: async () => 0,
  getLabOrderById: async () => dispatchOrder({ labName: "مختبر عرض صناعي", doctorName: "طبيب عرض صناعي", workType: "جسر تجريبي للاختبار فقط" }),
  patientStatementSnapshot: async () => ({ ledger: { invoices: [state.invoice!], payments: [state.payment!], openings: [] }, planCurrencies: new Map(), plans: [], historicalAgreements: [] }),
}));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: async () => true }));
vi.mock("@/lib/receipt-provenance-db", () => ({ readReceiptProvenance: async () => ({}) }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null, ReprintMark: () => null }));
import InvoicePage from "../app/print/invoice/[id]/page";
import ReceiptPage from "../app/print/receipt/[id]/page";
import StatementPage from "../app/print/statement/[id]/page";
import LabPage from "../app/print/lab/[id]/page";
import labStyles from "../app/print/lab/[id]/lab-dispatch.module.css";
import labelStyles from "../app/print/statement/[id]/labels.module.css";
import { PrintableReportDocument } from "../components/reports/PrintableReportDocument";
import { AgreementIdentitySummary, AgreementInstallmentTable, AgreementTermsAndSignatures, agreementDensity } from "../components/InstallmentAgreementPresentation";
import { PrintHeader } from "../components/PrintHeader";
import { PrintDocumentWatermark } from "../components/PrintDocument";
import { STANDARD_PLAN_TERMS } from "../lib/plans";

const settings = { ...SETTING_DEFAULTS, "clinic.name": "مركز عقلان — نموذج عرض صناعي", "clinic.lead_doctor": "طبيب اختبار",
  "clinic.lead_doctor_title": "طب وجراحة الأسنان", "clinic.lead_doctor_credentials": "", "clinic.phone": "000-000000", "clinic.address": "عنوان صناعي للاختبار" };
const reset = `*,::before,::after{box-sizing:border-box;border-width:0;border-style:solid}html{line-height:1.5}body,p,h1,h2,h3,ol,ul{margin:0}ol,ul{padding:0;list-style:none}h1,h2,h3{font-size:inherit;font-weight:inherit}table{border-collapse:collapse;border-color:inherit}img{display:block;max-width:100%;height:auto}.object-contain{object-fit:contain}.h-9{height:2.25rem}.w-9{width:2.25rem}`;
function fixture(count = 5): Invoice {
  return { id: 9002, patientId: 9001, patientName: "مريض عرض صناعي — اسم طويل للاختبار فقط", invoiceNumber: "SYNTHETIC-INV-9002", status: "open", baseCurrency: "SAR", totalMinor: count * 12345,
    discountMinor: 1234, createdAt: "2031-01-05T10:00:00Z", note: "وثيقة صناعية للتحقق من العرض فقط — لا بيانات مرضى حقيقية.",
    items: Array.from({ length: count }, (_, i) => ({ id: i + 1, serviceId: null, doctorId: null, description: `بند علاجي صناعي ${String(i + 1).padStart(3, "0")} — وصف عربي مع مرجع MIXED-REF-${i + 1}`, quantity: 1, unitPriceMinor: 12345, totalMinor: 12345 })) };
}
function cssModule(file: string, classes: Record<string, string>) {
  let css = readFileSync(resolve(file), "utf8");
  const globalNames = new Set([...css.matchAll(/:global\(\.([\w-]+)\)/g)].map(match => match[1]));
  for (const name of new Set([...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(match => match[1]))) {
    if (!globalNames.has(name)) css = css.replace(new RegExp(`\\.${name}(?![\\w-])`, "g"), `.${classes[name]}`);
  }
  css = css.replace(/:global\(([^)]+)\)/g, "$1");
  return css;
}
/** Optional synthetic renderer input; no network, database writes or browser claims. */
function artifact(name: string, markup: string, extra = "") {
  if (!process.env.PRINT_RENDER_OUTPUT) return;
  const output = resolve(process.env.PRINT_RENDER_OUTPUT); mkdirSync(output, { recursive: true });
  const logo = `data:image/png;base64,${readFileSync(resolve("public/logo.png")).toString("base64")}`;
  const shared = existsSync(resolve("components/print-document.css")) ? readFileSync(resolve("components/print-document.css"), "utf8") : "";
  const css = reset + shared + readFileSync(resolve("app/print/print.css"), "utf8") + extra;
  const watermark = renderToStaticMarkup(<PrintDocumentWatermark src={name.includes("missing-logo") ? "" : "/logo.png"} />);
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>Synthetic print preview</title><style>${css}</style></head><body>${watermark.replaceAll('src="/logo.png"', `src="${logo}"`)}<div class="print-root">${markup.replaceAll('src="/logo.png"', `src="${logo}"`)}</div></body></html>`;
  writeFileSync(resolve(output, `${name}.html`), html);
}
beforeEach(() => {
  state.invoice = fixture();
  state.payment = { id: 9003, receiptNumber: "SYNTHETIC-REC-9003", patientId: 9001, patientName: state.invoice.patientName, invoiceId: 9002,
    planId: null, openingCurrency: null, shiftId: 1, kind: "payment", reversalOfId: null, amountMinor: 20000, currency: "SAR", exchangeRate: 140, baseAmountMinor: 2800000,
    baseCurrency: "YER", method: "cash", note: "بيانات عرض صناعية فقط", createdBy: "موظف اختبار", createdAt: "2031-01-05T10:00:00Z" };
});
describe("unified print actual-route synthetic presentation", () => {
  it.each([5, 90])("preserves all %s invoice items, native money, totals, metadata and source data", async count => {
    state.invoice = fixture(count); const before = structuredClone(state.invoice);
    const html = renderToStaticMarkup(await InvoicePage({ params: Promise.resolve({ id: "9002" }) }));
    expect(html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0].match(/<tr>/g)).toHaveLength(count);
    for (const amount of [state.invoice.totalMinor, 1234, state.invoice.totalMinor - 1234]) expect(html).toContain(formatMoney(amount, "SAR"));
    expect(state.invoice).toEqual(before); artifact(`invoice-${count}`, html);
    if (count === 5) artifact("invoice-missing-logo", html.replaceAll('src="/logo.png"', 'src="data:image/png;base64,"'));
  });
  it("retains A6 receipt amount, exchange rate and equivalent without changing source", async () => {
    const before = structuredClone(state.payment); const html = renderToStaticMarkup(await ReceiptPage({ params: Promise.resolve({ id: "9003" }) }));
    for (const text of [formatMoney(20000, "SAR"), formatMoney(2800000, "YER"), "140", "SYNTHETIC-REC-9003"]) expect(html).toContain(text);
    expect(state.payment).toEqual(before); artifact("receipt-a6", html, "@page { size: A6; }"); artifact("receipt-a4-stock", html, "@page { size: A4; }");
  });
  it("retains current patient statement rows, source currency and totals", async () => {
    const before = structuredClone([state.invoice, state.payment]); const html = renderToStaticMarkup(await StatementPage({ params: Promise.resolve({ id: "9001" }) }));
    for (const text of ["SYNTHETIC-INV-9002", "SYNTHETIC-REC-9003", formatMoney(20000, "SAR"), "الرصيد الحالي"]) expect(html).toContain(text);
    expect([state.invoice, state.payment]).toEqual(before); artifact("statement", html, cssModule("app/print/statement/[id]/labels.module.css", labelStyles));
  });
  it("preserves external lab privacy, order QR and clinical diagram", async () => {
    const html = renderToStaticMarkup(await LabPage({ params: Promise.resolve({ id: "381" }) }));
    for (const canary of DISPATCH_PRIVATE_CANARIES) expect(html).not.toContain(canary);
    expect(html).toContain('data-dental-arch="18,17,16,15,14,13,12,11,21,22,23,24,25,26,27,28"');
    expect(html).toContain("RX-381"); artifact("lab-dispatch", html, cssModule("app/print/lab/[id]/lab-dispatch.module.css", labStyles));
  });
  it.each([0, 75])("preserves %s landscape report rows and each native currency independently", count => {
    const result: ReportResult = { report: "visits", title: "كشف زيارات صناعي متعدد العملات", periodLabel: "2031-01-01 — 2031-01-31", from: "2031-01-01", to: "2031-01-31", baseCurrency: "YER", filtersLabel: "بيانات اختبار فقط", kpis: [],
      columns: [{ key: "ref", label: "المرجع" }, { key: "name", label: "المريض" }, { key: "description", label: "البيان" }, { key: "currency", label: "العملة" }, { key: "amount", label: "المبلغ", type: "money", currencyKey: "currency" }, { key: "workSource", label: "المصدر" }, { key: "date", label: "التاريخ" }, { key: "status", label: "الحالة" }],
      rows: Array.from({ length: count }, (_, i) => ({ ref: `SYN-${String(i + 1).padStart(3, "0")}`, name: "مريض عرض صناعي", description: "بيان طويل متعدد الكلمات للاختبار مع رقم ABC123456789", currency: ["YER", "SAR", "USD"][i % 3], amount: 123456, workSource: "بلا فاتورة جديدة", date: "2031-01-05", status: "قراءة فقط" })) };
    const before = structuredClone(result); const html = renderToStaticMarkup(createElement(PrintableReportDocument, { result, settings, generatedAt: "2031-01-31 10:00", generatedBy: "اختبار" }));
    expect(result).toEqual(before); expect(html.match(/<th\b/g)?.length).toBe(8);
    if (count) for (const currency of ["YER", "SAR", "USD"] as const) expect(html).toContain(formatMoney(123456, currency));
    artifact(`report-landscape-${count}`, html);
  });
  it.each([4, 6, 12, 24, 36, 60])("keeps %s agreement rows with six columns, paired identity and fixed paper-logo sizing", count => {
    const html = renderToStaticMarkup(<div className="sheet sheet-a4 agreement-sheet" data-density={agreementDensity(count)} dir="rtl"><PrintHeader settings={settings} title="اتفاقية خطة العلاج وجدول الأقساط" />
      <AgreementIdentitySummary patientName="مريض عرض صناعي" patientNumber="SYN-9001" reference="SYN-INV-9002" totalLabel="إجمالي قيمة الفاتورة" totalMinor={count * 10000} paidMinor={Math.min(count, 10) * 10000} remainingMinor={Math.max(count - 10, 0) * 10000} currency="SAR" />
      <h3>جدول الأقساط والمواعيد الاستحقاقية</h3><AgreementInstallmentTable currency="SAR" rows={Array.from({ length: count }, (_, i) => ({ key: i, number: i + 1, dueDate: "2031-01-05", amountMinor: 10000, paid: i < 10, settledMinor: i < 10 ? 10000 : 0, remainingMinor: i < 10 ? 0 : 10000 }))} /><AgreementTermsAndSignatures terms={STANDARD_PLAN_TERMS} /></div>);
    expect(html.match(/class="agreement-summary-row"/g)).toHaveLength(3); expect(html.match(/<th\b/g)).toHaveLength(6);
    expect(html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0].match(/<tr/g)).toHaveLength(count);
    artifact(`agreement-fixed-${count}`, html);
    if (count === 24) artifact("agreement-anchor", html);
    if (count === 4) artifact("agreement-ordinary-plan-4", html.replace("sheet sheet-a4 agreement-sheet", "sheet sheet-a4"));
  });
});
