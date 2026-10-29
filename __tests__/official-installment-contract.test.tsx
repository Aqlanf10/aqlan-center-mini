import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { AgreementInstallmentTable, agreementDensity } from "../components/InstallmentAgreementPresentation";
import { DebtRepaymentAgreementPrint } from "../components/DebtRepaymentAgreementPrint";
import type { readSavedRepaymentAgreement } from "../lib/debt-repayment-agreement-db";
import { debtInstallmentProgress } from "../lib/debt-installments";
import { formatMoney, type Currency } from "../lib/money";
import { STANDARD_PLAN_TERMS } from "../lib/plans";
import { SETTING_DEFAULTS } from "../lib/settings";

type Agreement = NonNullable<Awaited<ReturnType<typeof readSavedRepaymentAgreement>>>;
const state = vi.hoisted(() => ({ agreement: null as Agreement | null, read: vi.fn() }));
vi.mock("../lib/debt-repayment-agreement-db", () => ({
  readSavedRepaymentAgreement: (...args: unknown[]) => { state.read(...args); return state.agreement; },
}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("../components/PrintButton", () => ({ PrintButton: () => null }));

function fixture(currency: Currency = "SAR"): Agreement {
  // Synthetic only. The revision starts after earlier receipts: cumulative
  // settled cash must not be reallocated to this new schedule a second time.
  const installments = [
    { kind: "down_payment" as const, dueDate: "2026-11-01", amountMinor: 30_000 },
    { kind: "installment" as const, dueDate: "2026-12-01", amountMinor: 60_000 },
  ];
  return {
    source: { patient_id: 9001, full_name: "مريض اختبار صناعي", patient_number: "SYN-9001", phone: null, invoice_number: "SYN-INV-9001" },
    settings: { ...SETTING_DEFAULTS, "clinic.name": "عيادة الاختبار", "clinic.lead_doctor": "طبيب الاختبار", "clinic.lead_doctor_title": "تقويم الأسنان" },
    schedule: {
      id: 9002, version: 3, status: "active", target: { patientId: 9001, currency, invoiceId: 9003, openingCurrency: null },
      terms: { mode: "installments", installments }, principalMinor: 150_000,
      collectedMinor: 80_000, remainingMinor: 70_000, revisionPrincipalMinor: 90_000,
      sourceHash: "synthetic-source-proof", available: true, requiresReview: false,
      accountDueMinor: 70_000, collectibleMinor: 70_000, history: [],
      progress: debtInstallmentProgress({ principalMinor: 90_000, currentRemainingMinor: 70_000,
        netSettledSinceRevisionMinor: 20_000, installments, today: "2026-11-02" }),
    },
  };
}
const render = async () => renderToStaticMarkup(await DebtRepaymentAgreementPrint({ id: 9002, version: 3, today: "2026-11-02" }));
const rows = (html: string) => [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(match => match[1]);

beforeEach(() => { state.agreement = fixture(); state.read.mockClear(); });

describe("official installment contract preserves financial evidence in the reference presentation", () => {
  it("uses the clinic identity, six-column schedule, clinical terms and signatures", async () => {
    const html = await render();
    expect(html).toContain("عيادة الاختبار");
    expect(html).toContain("اتفاقية خطة العلاج وجدول الأقساط");
    const header = rows(html)[0];
    expect(header.match(/<th\b/g)).toHaveLength(6);
    for (const label of ["القسط", "تاريخ الاستحقاق", "المبلغ", "المحصّل", "المتبقي", "حالة السداد"]) expect(header).toContain(label);
    expect(html).toContain("إقرار وموافقة المريض (أو ولي أمره)");
    expect(html).toContain("الطبيب المعالج / إدارة المركز");
    expect(html).toContain('class="agreement-closing"');
    for (const term of STANDARD_PLAN_TERMS) expect(html).toContain(term);
    expect(html.match(/class="agreement-table-watermark"/g)).toHaveLength(1);
    expect(html).toContain('class="agreement-table-watermark" aria-hidden="true"');
  });

  it("keeps cumulative settlement distinct from revision principal and proposed down payment", async () => {
    const html = await render();
    for (const amount of [150_000, 80_000, 70_000, 90_000, 30_000, 60_000]) {
      expect(html).toContain(formatMoney(amount, "SAR"));
    }
    expect(html).toContain(`<span>إجمالي قيمة الفاتورة</span><span class="num">${formatMoney(150_000, "SAR")}</span>`);
    expect(html).toContain(`<span>المسدد حتى تاريخه</span><span class="num">${formatMoney(80_000, "SAR")}</span>`);
    expect(html).toContain(`<span>المتبقي للسداد</span><span class="num">${formatMoney(70_000, "SAR")}</span>`);
    expect(html).toContain("المقدمة المقترحة موعد سداد وليست سند قبض");
    expect(html).toContain("إجمالي مبالغ هذا الجدول:");
    expect(html).toContain("أقساط ما بعد المقدمة المقترحة:");
    expect(html).toContain("قسط 1");
    expect(html).not.toContain("قيمة الجدول عند اعتماد النسخة");
    expect(html).not.toContain("المتبقي المجدول بعد المقدمة المقترحة");
    expect(html).not.toContain("عملة الاتفاق");
    expect(html).not.toContain("ترتيب #");
    const partial = rows(html)[1];
    expect(partial).toContain("مقدمة مقترحة");
    expect(partial).toContain(formatMoney(20_000, "SAR"));
    expect(partial).toContain(formatMoney(10_000, "SAR"));
    expect(partial).not.toContain("مسدد ✓");
    const unpaid = rows(html)[2];
    expect(unpaid).toContain(formatMoney(60_000, "SAR"));
    expect(unpaid).not.toContain("مسدد ✓");
  });

  it("prints the scheduled post-proposal subtotal even when revision and source totals match", async () => {
    state.agreement!.schedule.principalMinor = 90_000;
    state.agreement!.schedule.collectedMinor = 20_000;
    const html = await render();
    const caption = html.match(/<p[^>]*data-testid="agreement-scheduled-totals"[^>]*>([\s\S]*?)<\/p>/)?.[1];
    expect(caption).toContain(formatMoney(90_000, "SAR"));
    expect(caption).toContain(formatMoney(60_000, "SAR"));
    expect(html).toContain(`<span>المسدد حتى تاريخه</span><span class="num">${formatMoney(20_000, "SAR")}</span>`);
    expect(html).toContain(`<span>المتبقي للسداد</span><span class="num">${formatMoney(70_000, "SAR")}</span>`);
  });

  it("marks only fully settled schedule rows as paid", async () => {
    state.agreement!.schedule.progress = debtInstallmentProgress({
      principalMinor: 90_000, currentRemainingMinor: 60_000, netSettledSinceRevisionMinor: 30_000,
      installments: state.agreement!.schedule.terms.installments, today: "2026-11-02",
    });
    state.agreement!.schedule.collectedMinor = 90_000;
    state.agreement!.schedule.remainingMinor = 60_000;
    const html = await render();
    expect(rows(html)[1]).toContain("مسدد ✓");
    expect(rows(html)[2]).not.toContain("مسدد ✓");
  });

  it.each(["SAR", "USD", "YER"] as const)("preserves source currency %s without conversion", async currency => {
    state.agreement = fixture(currency);
    const html = await render();
    expect(html).toContain(formatMoney(150_000, currency));
    expect(html).toContain(formatMoney(80_000, currency));
    expect(html).toContain(formatMoney(70_000, currency));
    expect(html).toContain("SYN-INV-9001");
    expect(html).toContain('data-agreement-version="3"');
    expect(html).toContain('data-arrangement-id="9002"');
    expect(html).not.toContain("النسخة 3");
    expect(html).toContain('data-testid="agreement-revision-reference"');
    expect(html).toContain(`مرجع جدول السداد: #9002 · نسخة 3 · ${currency}`);
    expect(html.indexOf('data-testid="agreement-revision-reference"')).toBeGreaterThan(html.indexOf("agreement-signatures"));
    expect(state.read).toHaveBeenCalledExactlyOnceWith(9002, 3, "2026-11-02");
  });

  it("retains opening-balance provenance rather than inventing an invoice", async () => {
    state.agreement!.source.invoice_number = null;
    state.agreement!.schedule.target.invoiceId = null;
    state.agreement!.schedule.target.openingCurrency = "SAR";
    const html = await render();
    expect(html).toContain("الرصيد السابق SAR");
    expect(html).not.toContain("SYN-INV-9001");
    expect(html).toContain("SYN-9001");
  });

  it("does not mutate the source, saved schedule or settlement projections while rendering", async () => {
    const before = structuredClone(state.agreement);
    await render();
    expect(state.agreement).toEqual(before);
  });

  it("does not print a saved agreement when its authenticated reader returns unavailable", async () => {
    state.agreement = null;
    await expect(render()).rejects.toThrow("NOT_FOUND");
  });
});


describe("adaptive agreement layout", () => {
  it("groups patient identity, source and actual totals in exactly three paired rows", async () => {
    const html = await render();
    const summary = html.slice(html.indexOf('class="agreement-financial-summary'), html.indexOf("<h3"));
    expect(summary.match(/class="agreement-summary-row"/g)).toHaveLength(3);
    expect(summary.indexOf("المريض")).toBeLessThan(summary.indexOf("رقم الملف"));
    expect(summary.indexOf("رقم الملف")).toBeLessThan(summary.indexOf("مرجع الاتفاق"));
    expect(summary.indexOf("مرجع الاتفاق")).toBeLessThan(summary.indexOf("إجمالي قيمة الفاتورة"));
    expect(summary.indexOf("إجمالي قيمة الفاتورة")).toBeLessThan(summary.indexOf("المسدد حتى تاريخه"));
    expect(summary.indexOf("المسدد حتى تاريخه")).toBeLessThan(summary.indexOf("المتبقي للسداد"));
    expect(summary).toContain("SYN-9001");
    expect(summary).toContain("SYN-INV-9001");
  });
  it.each([[1,"relaxed"],[12,"relaxed"],[13,"balanced"],[24,"balanced"],[25,"dense"],[36,"dense"],[60,"dense"]] as const)("uses bounded whitespace for %i rows", (count, expected) => {
    expect(agreementDensity(count)).toBe(expected);
  });
});

describe("compact six-column financial rows", () => {
  it.each(["SAR", "USD", "YER"] as const)("retains each verified amount in its own %s cell", currency => {
    const html = renderToStaticMarkup(createElement(AgreementInstallmentTable, { currency, rows: [
      { key: 1, number: 1, dueDate: "2027-01-01", amountMinor: 30_000, paid: false, settledMinor: 20_000, remainingMinor: 10_000 },
    ] }));
    const cells = [...rows(html)[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(match => match[1]);
    expect(cells).toHaveLength(6);
    expect(cells.slice(2, 5)).toEqual([30_000, 20_000, 10_000].map(amount => formatMoney(amount, currency)));
    expect(cells[5]).toContain("مسدد جزئيًا");
    expect(html).not.toContain("agreement-settlement-detail");
  });

  it("does not fabricate collection figures where a plan only supplies paid status", () => {
    const html = renderToStaticMarkup(createElement(AgreementInstallmentTable, { currency: "SAR", rows: [
      { key: 1, number: 1, dueDate: "2027-01-01", amountMinor: 30_000, paid: true },
    ] }));
    const cells = [...rows(html)[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(match => match[1]);
    expect(cells.slice(3, 5)).toEqual(["—", "—"]);
    expect(cells[5]).toContain("مسدد ✓");
  });
});

describe("table-only agreement watermark", () => {
  it.each([1, 2, 24, 36])("bounds one decorative logo inside a %i-row schedule, not a fixed page overlay", (count) => {
    const rows = Array.from({ length: count }, (_, index) => ({ key: index, number: index + 1,
      dueDate: "2027-01-01", amountMinor: 10_000, paid: false, settledMinor: 0, remainingMinor: 10_000 }));
    const html = renderToStaticMarkup(createElement(AgreementInstallmentTable, { rows, currency: "SAR" }));
    expect(html.match(/class="agreement-table-watermark"/g)).toHaveLength(1);
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html.match(/<tr[ >]/g)).toHaveLength(count + 1);
    const css = readFileSync(new URL("../app/print/print.css", import.meta.url), "utf8");
    const watermark = css.split(".agreement-table-watermark {")[1].split("}")[0];
    expect(watermark).toContain("opacity: 0.15");
    expect(watermark).toContain("position: absolute");
    expect(watermark).not.toContain("position: fixed");
    expect(watermark).toContain("pointer-events: none");
    expect(watermark).toContain("height: 80%");
    expect(css).toContain("height: 100%; object-fit: contain");
  });
});
