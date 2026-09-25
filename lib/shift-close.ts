import { CURRENCIES, type Currency } from "./money";

/**
 * (P1-3) إغلاق الوردية — القاعدة الواحدة لما «يجب» أن يكون في الدرج.
 *
 * الدرج يحوي **النقد** وحده: الافتتاحي + المقبوض نقدًا − المردود نقدًا − سندات
 * الصرف (تُصرف من الدرج). أما التحويل (الكريمي/البنك) فلا يدخل الدرج أصلًا — وكان
 * يُحسب في «المتوقع» فيبدو كل إغلاقٍ فيه تحويلٌ ناقصًا بمقداره، ويُرحَّل عجزٌ وهميّ
 * إلى القيود. هذه الدالة يستعملها الإغلاق (ويحفظ نتيجتها)، وشاشتا الصندوق، وقيد
 * فرق الصندوق في المحاسبة — فلا يختلف رقمان على وردية واحدة.
 */
export type Amounts = Record<Currency, number>;

export interface ShiftPaymentLike {
  kind: "payment" | "refund" | string;
  currency: Currency;
  amountMinor: number;
  method: string | null;
}

export interface ShiftExpenseLike {
  currency: Currency;
  amountMinor: number;
}

export interface DrawerBreakdown {
  opening: Amounts;
  cashIn: Amounts;
  cashRefunds: Amounts;
  /** يدخل الحساب البنكي لا الدرج — يُعرض للعلم ولا يدخل المتوقع. */
  nonCashIn: Amounts;
  nonCashRefunds: Amounts;
  spent: Amounts;
  expected: Amounts;
}

export const zeroAmounts = (): Amounts => ({ YER: 0, SAR: 0, USD: 0 });

/** النقد وحده يدخل الدرج. غياب الطريقة (بيانات قديمة) = نقد، كما كان يُفترض دائمًا. */
export function isCashMethod(method: string | null | undefined): boolean {
  return method === null || method === undefined || method === "" || method === "cash";
}

export function drawerBreakdown(
  opening: Amounts,
  payments: ShiftPaymentLike[],
  expenses: ShiftExpenseLike[],
): DrawerBreakdown {
  const cashIn = zeroAmounts();
  const cashRefunds = zeroAmounts();
  const nonCashIn = zeroAmounts();
  const nonCashRefunds = zeroAmounts();
  const spent = zeroAmounts();
  for (const payment of payments) {
    const refund = payment.kind === "refund";
    const cash = isCashMethod(payment.method);
    const bucket = cash ? (refund ? cashRefunds : cashIn) : (refund ? nonCashRefunds : nonCashIn);
    bucket[payment.currency] += payment.amountMinor;
  }
  for (const expense of expenses) spent[expense.currency] += expense.amountMinor;
  const expected = zeroAmounts();
  for (const currency of CURRENCIES) {
    expected[currency] = opening[currency] + cashIn[currency] - cashRefunds[currency] - spent[currency];
  }
  return { opening: { ...opening }, cashIn, cashRefunds, nonCashIn, nonCashRefunds, spent, expected };
}

/** المعدود − المتوقع لكل عملة. سالب = عجز، موجب = زيادة. */
export function drawerDifference(expected: Amounts, counted: Amounts): Amounts {
  const difference = zeroAmounts();
  for (const currency of CURRENCIES) difference[currency] = counted[currency] - expected[currency];
  return difference;
}

export function hasDifference(difference: Amounts | null | undefined): boolean {
  return Boolean(difference) && CURRENCIES.some((currency) => difference![currency] !== 0);
}
