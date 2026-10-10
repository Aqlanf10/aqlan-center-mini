import type { LabOrder } from "./lab";
import { parseAmount, toBaseAmount, toInputAmount, type Currency } from "./money";

export type LabAccountingMoneyEdit =
  | { kind: "unchanged" }
  | { kind: "edited"; costMinor: number; currency: Currency }
  | { kind: "invalid"; message: string };

/** Omitted money preserves the writer's saved order/payable snapshots. */
export function labAccountingMoneyEdit(
  order: Pick<LabOrder, "costMinor" | "costCurrency">,
  text: string,
  currency: Currency,
  baseCurrency: Currency,
  touched: boolean,
): LabAccountingMoneyEdit {
  if (!touched) return { kind: "unchanged" };
  const originalCurrency = order.costCurrency || baseCurrency;
  // Returning to the displayed saved value is metadata-only even at large
  // safe-integer amounts whose decimal text cannot round-trip through a float.
  if (currency === originalCurrency && order.costMinor != null
    && Number.isSafeInteger(order.costMinor) && order.costMinor >= 0
    && text === toInputAmount(order.costMinor, originalCurrency)) {
    return { kind: "unchanged" };
  }
  const minor = text.trim() === "" ? null : parseAmount(text, currency);
  if (currency === originalCurrency
    && ((minor != null && minor === order.costMinor)
      || (text.trim() === "" && (order.costMinor == null || order.costMinor === 0)))) {
    return { kind: "unchanged" };
  }
  // Clearing or zeroing an existing debt needs its own financial workflow.
  if (minor == null || !Number.isSafeInteger(minor) || minor <= 0) {
    return { kind: "invalid", message: "أدخل تكلفة موجبة صحيحة، أو أعد القيمة الأصلية لحفظ الربط فقط. إلغاء التكلفة له إجراء مالي منفصل." };
  }
  return { kind: "edited", costMinor: minor, currency };
}

/** Match the existing writer's NUMERIC(18,6) positive-rate admission. */
export function isLabAccountingRate(rate: unknown): rate is number {
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0
    && rate <= 1_000_000 && Number(rate.toFixed(6)) === rate;
}

export function labAccountingPreviewBase(
  minor: number, currency: Currency, baseCurrency: Currency, rate: number,
): number | null {
  if (!isLabAccountingRate(rate)) return null;
  const amount = toBaseAmount(minor, currency, baseCurrency, rate);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}
