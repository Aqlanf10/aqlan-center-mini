import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CheckoutDueSummary } from "../components/patient/CheckoutDueSummary";
import { buildCheckoutDueRecommendation, type CheckoutDueSource } from "../lib/checkout-due-recommendation";
const source: CheckoutDueSource = { kind: "approved_agreement", authorityId: 11, currency: "SAR", invoiceId: 21,
  openingCurrency: null, remainingMinor: 750, dueNowMinor: 0, available: true };
const html = (sources: CheckoutDueSource[], visitInvoiceId: number | null = null) => renderToStaticMarkup(<CheckoutDueSummary recommendation={
  buildCheckoutDueRecommendation({ patientId: 7, visitInvoiceId, current: { SAR: 750 }, sources })} />);
describe("checkout source-qualified display", () => {
  it("renders verified zero due with positive remaining without claiming the account is settled", () => {
    const result = html([source]);
    expect(result).toContain('data-state="verified"');
    expect(result).toContain("لا استحقاق مثبت الآن");
    expect(result).toContain("هذا لا يعني سداد كامل الرصيد");
    expect(result).toContain('href="/patients/7?tab=account"');
    expect(result).not.toContain("<button");
  });
  it("renders unavailable/competing source as review, never a zero amount or collection action", () => {
    const result = html([source, { ...source, kind: "repayment_schedule", authorityId: 31, dueNowMinor: 400 }]);
    expect(result).toContain('data-state="review_required"');
    expect(result).toContain("غير متاح قبل المراجعة");
    expect(result).toContain("لا تُجمع مبالغها");
    expect(result).not.toContain("لا استحقاق مثبت الآن");
    expect(result).not.toContain("<button");
  });
  it("ordinary unscheduled visit invoice keeps the existing exact-target action outside this read-only display", () => {
    const result = html([{ ...source, kind: "visit_invoice", authorityId: 21, dueNowMinor: 750 }], 21);
    expect(result).toContain("فاتورة الزيارة #21");
    expect(result).not.toContain("اختيار مصدر التحصيل");
    expect(result).not.toContain("<button");
  });
  it("keeps multiple plans and currency amounts visibly separate and requires explicit account selection", () => {
    const recommendation = buildCheckoutDueRecommendation({ patientId: 7, visitInvoiceId: null, current: { YER: 500, SAR: 1500, USD: 1000 }, sources: [
      { ...source, currency: "YER", invoiceId: 31, remainingMinor: 500, dueNowMinor: 200 },
      source, { ...source, authorityId: 12, invoiceId: 22, dueNowMinor: 150 },
      { ...source, currency: "USD", invoiceId: 41, remainingMinor: 1000, dueNowMinor: 300 },
    ] });
    const result = renderToStaticMarkup(<CheckoutDueSummary recommendation={recommendation} />);
    for (const currency of ["YER", "SAR", "USD"]) expect(result).toContain(`data-currency="${currency}"`);
    for (const id of [21, 22, 31, 41]) expect(result).toContain(`الفاتورة #${id}`);
    expect(result).toContain("اختر الفاتورة أو الرصيد المقصود");
    expect(result).toContain('target="_blank"'); expect(result).not.toContain("<button");
  });

});
