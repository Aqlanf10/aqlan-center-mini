import { CLINIC_BASE_CURRENCY, MINOR_UNITS, formatMoney, type Currency } from "./money";

/**
 * (P0-2) مدفوعات الموردين والمختبرات — المنطق الخالص.
 *
 * قرارات المالك (2026-09-22):
 *  1. سند الصرف لجهة مورد/مختبر لا يتجاوز رصيدها المستحق — دائمًا. الاستثناء
 *     الوحيد «دفعة مقدمة» يعلّمها المدير بسببٍ مكتوب، وتُدقَّق.
 *  2. دفع فاتورةٍ بعملةٍ غير عملتها مسموح **بسعر يوم الدفع**، ويُحفظ في السند
 *     لقطةً كاملة لا تتغيّر: عملة الفاتورة وقيمتها، عملة الدفع ومبلغه، السعر
 *     المستعمل، والمكافئ المخصوم من الفاتورة. تغيير السعر غدًا لا يمسّ سند اليوم.
 *  3. المكافئ المحوَّل لا يتجاوز المتبقي على الفاتورة.
 *
 * اصطلاح الأسعار هو اصطلاح النظام كله: `rate` = كم وحدةً من العملة الأساسية
 * (YER) تساوي وحدةً كبرى واحدة من العملة. فالسعر بين عملتين أجنبيتين مشتقّ من
 * سعريهما إلى الأساس — لا سعرٌ ثالث مخترع.
 */

/** أسعار العملات إلى الأساس لحظة الدفع — الأساس نفسه ١ دائمًا. */
export type RateMap = Partial<Record<Currency, number>>;

export function rateOf(currency: Currency, rates: RateMap): number | null {
  if (currency === CLINIC_BASE_CURRENCY) return 1;
  const rate = rates[currency];
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * تحويل مبلغ (وحدات صغرى) من عملة إلى أخرى عبر الأساس بأسعار لحظةٍ واحدة.
 * يعيد null إن غاب سعرٌ لازم — لا يُخمَّن.
 */
export function convertMinor(
  amountMinor: number, from: Currency, to: Currency, rates: RateMap,
): number | null {
  if (from === to) return amountMinor;
  const fromRate = rateOf(from, rates);
  const toRate = rateOf(to, rates);
  if (fromRate === null || toRate === null) return null;
  const baseMajor = (amountMinor / MINOR_UNITS[from]) * fromRate;
  return Math.round((baseMajor / toRate) * MINOR_UNITS[to]);
}

/**
 * أكبر مبلغ بعملة الدفع لا يتجاوز مكافئُه `limitMinor` بعملة الهدف — لتقترحه
 * الشاشة («ادفع حتى …»). يبحث حول القسمة التقريبية فلا يقترح مبلغًا يُرفض.
 */
export function maxPaymentFor(
  limitMinor: number, paymentCurrency: Currency, target: Currency, rates: RateMap,
): number | null {
  if (limitMinor <= 0) return 0;
  if (paymentCurrency === target) return limitMinor;
  const approx = convertMinor(limitMinor, target, paymentCurrency, rates);
  if (approx === null) return null;
  let candidate = approx + 2;
  while (candidate > 0) {
    const back = convertMinor(candidate, paymentCurrency, target, rates);
    if (back === null) return null;
    if (back <= limitMinor) return candidate;
    candidate -= 1;
  }
  return 0;
}

/** رصيد جهةٍ مستحقٌّ بدلو كل عملة: التزاماتها − ما سُدّد منها (بلقطات السندات) − المدفوع لها بلا ربط. */
export interface PartyBucket { currency: Currency; netMinor: number }

/**
 * المستحق لجهةٍ معبَّرًا عنه بعملة الدفع، بأسعار لحظة الدفع. الدلاء لا تُجمع
 * بلا تحويل: كل دلوٍ يُحوَّل بسعر اللحظة ثم يُجمع. null إن غاب سعر دلوٍ غير صفري.
 */
export function partyOutstandingIn(
  target: Currency, buckets: PartyBucket[], rates: RateMap,
): number | null {
  let total = 0;
  for (const bucket of buckets) {
    if (bucket.netMinor === 0) continue;
    const converted = convertMinor(bucket.netMinor, bucket.currency, target, rates);
    if (converted === null) return null;
    total += converted;
  }
  return total;
}

/** نصّ السعر كما يقرؤه المستخدم قبل التأكيد: «1 USD = 535 YER». */
export function crossRateText(paymentCurrency: Currency, billCurrency: Currency, rates: RateMap): string | null {
  if (paymentCurrency === billCurrency) return null;
  const pay = rateOf(paymentCurrency, rates);
  const bill = rateOf(billCurrency, rates);
  if (pay === null || bill === null) return null;
  // العملة الأقوى في الطرف الأيسر — كما تُكتب في الصرافات.
  const [strong, weak, ratio] = bill >= pay
    ? [billCurrency, paymentCurrency, bill / pay]
    : [paymentCurrency, billCurrency, pay / bill];
  const shown = Number(ratio.toFixed(6));
  return `1 ${strong} = ${shown.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${weak}`;
}

/** أسباب رفض سند الصرف — ومعها رسائل عربية تقرؤها الشاشة كما هي. */
export type SupplierPaymentRefusal =
  | "no_shift"
  | "party_not_found"
  | "payable_not_found"
  | "payable_party_mismatch"
  | "missing_rate"
  | "zero_settlement"
  | "exceeds_payable"
  | "exceeds_party_balance";

export interface SettlementQuote {
  paymentCurrency: Currency;
  amountMinor: number;
  /** سعر عملة الدفع إلى الأساس المستعمل — لقطة السند. */
  paymentExchangeRate: number;
  baseAmountMinor: number;
  /** نصّ السعر بين عملة الدفع وعملة الفاتورة، إن اختلفتا. */
  rateText: string | null;
  rateOverridden: boolean;
  payable: null | {
    id: number;
    currency: Currency;
    amountMinor: number;
    /** سعر عملة الفاتورة إلى الأساس لحظة الدفع — لقطة السند. */
    exchangeRate: number;
    remainingBeforeMinor: number;
    settledMinor: number;
    remainingAfterMinor: number;
    /** أكبر مبلغ بعملة الدفع يسدّد المتبقي دون تجاوزه. */
    maxPaymentMinor: number | null;
  };
  party: null | {
    id: number;
    kind: string;
    guarded: boolean;
    /** المستحق للجهة بعملة الدفع قبل السند وبعده. */
    outstandingBeforeMinor: number | null;
    outstandingAfterMinor: number | null;
    prepayment: boolean;
  };
}

export function refusalMessage(reason: SupplierPaymentRefusal, quote?: SettlementQuote | null): string {
  switch (reason) {
    case "no_shift":
      return "لا توجد وردية مفتوحة. افتح الوردية من شاشة الصندوق أولًا.";
    case "party_not_found":
      return "الجهة غير موجودة.";
    case "payable_not_found":
      return "الالتزام (الفاتورة) غير موجود.";
    case "payable_party_mismatch":
      return "هذا الالتزام لجهةٍ أخرى — لا يُسدَّد باسم غير صاحبه.";
    case "missing_rate":
      return "سعر الصرف غير مضبوط لإحدى العملتين. اضبطه في الإعدادات قبل الصرف.";
    case "zero_settlement":
      return "المبلغ أصغر من أن يسدّد شيئًا من الفاتورة بعملتها.";
    case "exceeds_payable": {
      const p = quote?.payable;
      if (!p) return "المبلغ يتجاوز المتبقي على الفاتورة.";
      const max = p.maxPaymentMinor !== null && quote && quote.paymentCurrency !== p.currency
        ? ` (أقصى ما يُدفع بـ${quote.paymentCurrency}: ${formatMoney(p.maxPaymentMinor, quote.paymentCurrency)})`
        : "";
      return `المبلغ يتجاوز المتبقي على الفاتورة: المتبقي ${formatMoney(p.remainingBeforeMinor, p.currency)}${max}.`;
    }
    case "exceeds_party_balance": {
      const outstanding = quote?.party?.outstandingBeforeMinor;
      const text = outstanding === null || outstanding === undefined || !quote
        ? ""
        : ` المستحق لها الآن ${formatMoney(Math.max(0, outstanding), quote.paymentCurrency)}.`;
      return `المبلغ يتجاوز رصيد الجهة المستحق.${text} الدفع الزائد لا يُقبل إلا «دفعةً مقدمة» يعلّمها المدير بسببٍ مكتوب.`;
    }
  }
}

/** الجهات التي يحرسها رصيدها: الموردون والمختبرات (الأطباء لهم تقرير العمولات). */
export function isGuardedPartyKind(kind: string | null | undefined): boolean {
  return kind === "supplier" || kind === "lab";
}
