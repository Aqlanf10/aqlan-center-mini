import { parseAmount, type Currency } from "./money";

type AgreementPricingCheck = { ok: true } | {
  ok: false;
  code: "agreement_pricing_unsupported" | "invalid_agreement_total";
  message: string;
};

/**
 * Creation containment only. This does not establish fixed-price item bundles,
 * allocate a discount, change line-price authority, or require full schedules.
 * Inputs are the normalized items/installments that would reach createPlanV2.
 */
export function checkPlanAgreementPricing(input: {
  pricingMode: unknown;
  total: unknown;
  currency: Currency;
  items: readonly { quantity: number; unitPriceMinor: number; sessionCount: number }[];
  installments: readonly { amountMinor: number }[];
}): AgreementPricingCheck {
  const unsupported = (): AgreementPricingCheck => ({
    ok: false,
    code: "agreement_pricing_unsupported",
    message: "لا يمكن حفظ هذا الاتفاق حاليًا دون تغيير مبلغه. المبلغ المتفق عليه يختلف عن طريقة حساب الإجمالي المحفوظ؛ لم تُحفظ الخطة ولم تتغير بنود المسودة.",
  });
  // Missing mode is the supported legacy contract, not an escape from checking
  // an explicit total. Unknown modes must never silently select another basis.
  if (input.pricingMode !== undefined && input.pricingMode !== "items" && input.pricingMode !== "agreed") {
    return unsupported();
  }
  if (input.pricingMode === "items" && input.items.length === 0) return unsupported();

  const text = input.total == null ? "" : String(input.total).trim();
  // Old item-only callers omit total (some send a blank/null placeholder).
  if (!text && input.pricingMode !== "agreed") return { ok: true };
  const agreedMinor = parseAmount(text, input.currency);
  if (agreedMinor === null || agreedMinor <= 0) {
    return { ok: false, code: "invalid_agreement_total", message: "اكتب مبلغ الاتفاق الصحيح الأكبر من صفر بعملة الخطة." };
  }

  // Mirror the existing createPlanV2 principal, including its integer rounding.
  // Do not compare schedule coverage with item totals: partial custom schedules
  // remain valid when they do not contradict the explicit agreement amount.
  const storedMinor = input.items.length > 0
    ? input.items.filter((item) => item.sessionCount >= 0).reduce((sum, item) =>
      sum + Math.max(0, Math.round(item.quantity)) * Math.max(0, Math.round(item.unitPriceMinor)), 0)
    : input.installments.reduce((sum, part) => sum + Math.max(0, Math.round(part.amountMinor)), 0);
  return Number.isSafeInteger(storedMinor) && agreedMinor === storedMinor ? { ok: true } : unsupported();
}
