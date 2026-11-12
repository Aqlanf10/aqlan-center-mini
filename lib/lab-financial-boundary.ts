import { CLINIC_BASE_CURRENCY, isCurrency, type Currency } from "./money";
import { isLabAccountingRate } from "./lab-accounting-edit";

export class LabFinancialBoundaryError extends Error {
  readonly status = 409;
  constructor(readonly code: string, message = "راجع عملة تكلفة المختبر وسعر صرفها والمبلغ المحفوظ قبل المتابعة؛ لم يُنشأ التزام مالي.") {
    super(message); this.name = "LabFinancialBoundaryError";
  }
}
/** Preserve the saved monetary snapshot, never invent a currency, FX or base amount. */
export function savedLabPayableSnapshot(row: {
  cost_minor: unknown; cost_currency: unknown; exchange_rate: unknown; base_amount_minor: unknown;
}): { costMinor: number; currency: Currency; exchangeRate: number; baseAmountMinor: number } {
  const number = (value: unknown) => (typeof value === "number" || typeof value === "string" && value.trim() !== "") ? Number(value) : NaN;
  const costMinor = number(row.cost_minor), exchangeRate = number(row.exchange_rate), baseAmountMinor = number(row.base_amount_minor);
  if (!Number.isSafeInteger(costMinor) || costMinor <= 0 || !isCurrency(row.cost_currency)
    || !isLabAccountingRate(exchangeRate) || (row.cost_currency === CLINIC_BASE_CURRENCY && exchangeRate !== 1)
    || !Number.isSafeInteger(baseAmountMinor) || baseAmountMinor < 0) {
    throw new LabFinancialBoundaryError("lab_saved_money_review");
  }
  // Historical converted amounts are immutable evidence, not recomputed at current rates.
  return { costMinor, currency: row.cost_currency, exchangeRate, baseAmountMinor };
}
