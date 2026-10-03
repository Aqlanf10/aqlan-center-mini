import { CLINIC_BASE_CURRENCY, isCurrency, toBaseAmount, type Currency } from "./money";
import { rateFromSettings, type SettingsMap } from "./settings";

type LabOrderPricingConflictCode = "lab_order_exchange_rate_invalid" | "lab_order_automatic_price_invalid";

/** An automatic price cannot be committed without a trustworthy money snapshot. */
export class LabOrderPricingConflict extends Error {
  constructor(readonly code: LabOrderPricingConflictCode) {
    super(code === "lab_order_exchange_rate_invalid"
      ? "سعر الصرف غير مضبوط أو غير صالح لحفظ تكلفة المختبر. راجع الإعدادات وأعد المحاولة."
      : "تعذّر اعتماد تكلفة المختبر من جدول التسعير. راجع العملة والمبلغ وأعد المحاولة.");
    this.name = "LabOrderPricingConflict";
  }
}

/** Only the omitted-cost rule path calls this; explicit caller rates stay intact. */
export function resolveAutomaticLabPrice(input: {
  costMinor: unknown;
  costCurrency: unknown;
  quantity: number;
  baseCurrency: Currency;
  settings: SettingsMap;
}): { costMinor: number; costCurrency: Currency; exchangeRate: number; baseAmountMinor: number } {
  const invalidPrice = () => new LabOrderPricingConflict("lab_order_automatic_price_invalid");
  // Configured rates are denominated in the clinic base, not arbitrary cross-FX.
  if (input.baseCurrency !== CLINIC_BASE_CURRENCY || !isCurrency(input.costCurrency)) throw invalidPrice();
  if (typeof input.costMinor !== "number"
    && (typeof input.costMinor !== "string" || !/^\d+$/.test(input.costMinor))) throw invalidPrice();
  const unitCost = Number(input.costMinor);
  if (!Number.isSafeInteger(unitCost) || unitCost < 0
    || !Number.isSafeInteger(input.quantity) || input.quantity < 1) throw invalidPrice();
  const costMinor = unitCost * input.quantity;
  if (!Number.isSafeInteger(costMinor)) throw invalidPrice();

  const exchangeRate = rateFromSettings(input.settings, input.costCurrency, input.baseCurrency);
  // Both persisted rate columns are NUMERIC(18,6). Do not calculate using digits
  // that would disappear on storage; retain the existing settings maximum, too.
  if (exchangeRate === null || exchangeRate > 1_000_000
    || Number(exchangeRate.toFixed(6)) !== exchangeRate) {
    throw new LabOrderPricingConflict("lab_order_exchange_rate_invalid");
  }
  const baseAmountMinor = toBaseAmount(costMinor, input.costCurrency, input.baseCurrency, exchangeRate);
  if (!Number.isSafeInteger(baseAmountMinor) || baseAmountMinor < 0) throw invalidPrice();
  return { costMinor, costCurrency: input.costCurrency, exchangeRate, baseAmountMinor };
}
