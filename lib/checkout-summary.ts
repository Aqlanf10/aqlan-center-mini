import { CURRENCIES, type Currency } from "./money";
import type { BillingClassification } from "./billing-classification";

/**
 * (P0-G) شبّاك الاستقبال بعد التوقيع — المنطق الخالص.
 *
 * كل سطر عملٍ يحمل تصنيف فوترته من الخادم (لا تُعاد حسابه في الواجهة):
 * فوتر = NEW_BILLABLE، مشمولٌ باتفاق = INCLUDED، شدّة تقويم سابقة = LEGACY_INCLUDED، وغير ذلك NO_CHARGE.
 * والملخص المالي **بكل عملة على حدة**: الرصيد السابق (من المحرك الكانوني على الدفتر قبل اليوم)، والجديد
 * المستحق اليوم، ومدفوعات اليوم، والرصيد الحالي، وقسط الرصيد القديم المقترح، والمطلوب الآن.
 */

export function walkoutLineClass(input: { invoiced: boolean; included: boolean }): BillingClassification {
  if (input.invoiced) return "NEW_BILLABLE";
  if (input.included) return "INCLUDED";
  return "NO_CHARGE";
}

/**
 * قسط الرصيد السابق المقترح عند الشبّاك بعد ما دُفع عليه اليوم.
 * الشهري: المتأخر محسوبٌ أصلًا بعد كل المدفوعات (ومنها دفعة اليوم) — لا يُطرح منه مرةً ثانية.
 * مع كل زيارة (أو شهري بلا متأخر): القسط ثابت، فيُطرح منه ما دُفع اليوم كي لا يُقترح قسطان.
 */
export function legacyCheckoutSuggestion(input: {
  cadence: "per_visit" | "monthly";
  suggestedMinor: number;
  overdueMinor: number;
  paidTodayMinor: number;
}): number {
  if (input.cadence === "monthly" && input.overdueMinor > 0) return input.overdueMinor;
  return Math.max(0, input.suggestedMinor - Math.max(0, input.paidTodayMinor));
}

export interface CheckoutCurrencyLine {
  currency: Currency;
  previousBalanceMinor: number;
  newBillableMinor: number;
  paymentsTodayMinor: number;
  currentBalanceMinor: number;
  /** المتبقي من فاتورة اليوم وحدها. */
  todayRemainingMinor: number;
  /** قسط الرصيد السابق المقترح (P0-C) — على opening_currency، لا فاتورة جديدة. */
  legacySuggestedMinor: number;
  /** المتبقي من الرصيد القديم المشمول بالترتيب — هدف التحصيل على opening_currency. */
  legacyRemainingMinor: number;
  /** المطلوب الآن = متبقي فاتورة اليوم + قسط الرصيد القديم المقترح — لا يتجاوز الرصيد الحالي. */
  dueNowMinor: number;
}

export function buildCheckoutSummary(input: {
  previous: Partial<Record<Currency, number>>;
  current: Partial<Record<Currency, number>>;
  invoice: { currency: Currency; netMinor: number; paidMinor: number } | null;
  paymentsToday: readonly { currency: Currency; netMinor: number }[];
  legacy: readonly { currency: Currency; suggestedMinor: number; remainingMinor: number }[];
}): CheckoutCurrencyLine[] {
  const lines: CheckoutCurrencyLine[] = [];
  for (const currency of CURRENCIES) {
    const previousBalanceMinor = input.previous[currency] ?? 0;
    const currentBalanceMinor = input.current[currency] ?? 0;
    const newBillableMinor = input.invoice?.currency === currency ? input.invoice.netMinor : 0;
    const paymentsTodayMinor = input.paymentsToday
      .filter((row) => row.currency === currency)
      .reduce((sum, row) => sum + row.netMinor, 0);
    const todayRemainingMinor = input.invoice?.currency === currency
      ? Math.max(0, input.invoice.netMinor - input.invoice.paidMinor) : 0;
    const legacyRow = input.legacy.find((row) => row.currency === currency);
    const legacyRemainingMinor = Math.max(0, legacyRow?.remainingMinor ?? 0);
    const legacySuggestedMinor = Math.min(legacyRemainingMinor, Math.max(0, legacyRow?.suggestedMinor ?? 0));
    const dueNowMinor = Math.max(0, Math.min(Math.max(0, currentBalanceMinor), todayRemainingMinor + legacySuggestedMinor));
    if (previousBalanceMinor === 0 && currentBalanceMinor === 0 && newBillableMinor === 0
      && paymentsTodayMinor === 0 && legacySuggestedMinor === 0) continue;
    lines.push({
      currency, previousBalanceMinor, newBillableMinor, paymentsTodayMinor, currentBalanceMinor,
      todayRemainingMinor, legacySuggestedMinor, legacyRemainingMinor, dueNowMinor,
    });
  }
  return lines;
}
