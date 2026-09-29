import { MINOR_UNITS, toBaseAmount, type Currency } from "./money";

/**
 * العملات الأجنبية في دفترٍ بعملاته الأصلية — المنطق الخالص (TD-REG-028).
 *
 * كان الدفتر كله بالريال اليمني، فكان النقد الأجنبي فيه مكافئًا بسعر يوم قبضه، ويحتاج «إعادة
 * تقييم» تُرحَّل قيدًا لتقريبه إلى سعر اليوم (ترجمة IAS 21 لدفترٍ أساسي).
 *
 * صار الدفتر **بعملاته الأصلية**: صندوق الريال السعودي يحمل ريالات سعودية، والمئة دولار تبقى مئة
 * دولار أيًّا كان السعر. فلا شيء يُعاد تقييمه **داخل الدفاتر** — وترحيل قيد «إعادة تقييم» يمني
 * على صندوقٍ سعودي يعيد بالضبط الخلط الذي أُغلق. ما يبقى مفيدًا هو **عرض ترجمةٍ للعلم**: كم يساوي
 * ما نملكه من كل عملة بسعرٍ مذكور وتاريخٍ مذكور — رقمٌ يُقرأ ولا يُرحَّل.
 *
 * ولا سعر يُخترع: إن لم يُضبط سعر العملة في الإعدادات لا تُعرض لها ترجمة (null) — لا صفر ولا تخمين.
 */

/** العملات الأجنبية — الأساسية لا تُترجم إلى نفسها. */
export function foreignCurrencies(base: Currency): Currency[] {
  return (["YER", "SAR", "USD"] as Currency[]).filter((currency) => currency !== base);
}

export interface FxTranslation {
  currency: Currency;
  /** ما نملكه من هذه العملة في الدفاتر (الصندوق + البنك) — بوحداتها الصغرى هي. */
  cashMinor: number;
  /** مركز مقاصة تحويل العملات (1901) بهذه العملة — بوحداتها هي. */
  clearingMinor: number;
  /** سعر الإعدادات إلى الأساس — null إن لم يُضبط (فلا ترجمة). */
  rate: number | null;
  /** مكافئ النقد بالأساس بذلك السعر — **للعلم، غير مرحَّل**. */
  translatedCashMinor: number | null;
  /** مكافئ مركز المقاصة بالأساس بذلك السعر — للعلم. */
  translatedClearingMinor: number | null;
}

/** ترجمة مركز عملةٍ واحدة بسعرٍ مذكور — بلا ترحيل. */
export function translatePosition(input: {
  currency: Currency;
  base: Currency;
  cashMinor: number;
  clearingMinor: number;
  rate: number | null;
}): FxTranslation {
  const rate = input.rate;
  const usable = rate !== null && Number.isFinite(rate) && rate > 0;
  return {
    currency: input.currency,
    cashMinor: input.cashMinor,
    clearingMinor: input.clearingMinor,
    rate: usable ? rate : null,
    translatedCashMinor: usable ? toBaseAmount(input.cashMinor, input.currency, input.base, rate) : null,
    translatedClearingMinor: usable ? toBaseAmount(input.clearingMinor, input.currency, input.base, rate) : null,
  };
}

/** وحدات صغرى إلى كبرى — للعرض. */
export function majorUnits(minor: number, currency: Currency): number {
  return minor / MINOR_UNITS[currency];
}
