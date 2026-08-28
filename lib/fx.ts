import { MINOR_UNITS, toBaseAmount, type Currency } from "./money";

/**
 * إعادة تقييم العملات الأجنبية — المنطق الخالص.
 *
 * الدفاتر كلها بعملة واحدة، والدولار الذي قُبض بسعر ٥٤٥ دخلها بـ٥٤٥ ويبقى فيها
 * بـ٥٤٥ إلى الأبد. وهذا صحيح **للحركة** — سند القبض لا يتغيّر بعد طبعه — وخطأ
 * **للرصيد**: مئة دولار في الدرج اليوم تساوي ما تساويه اليوم لا ما ساوته يوم قُبضت.
 *
 * فبلا إعادة تقييم تكذب الميزانية في اتجاه واحد دائمًا في بلدٍ عملته تنزل: النقد
 * الأجنبي مقيّد بأسعار قديمة أقل من سعره، فتظهر العيادة أفقر مما هي، ويظهر ربح
 * التغيّر — وهو ربح حقيقي — كأنه لم يكن.
 *
 * والقاعدة المتعارف عليها عالميًا (IAS 21): البنود النقدية تُعاد ترجمتها بسعر
 * الإقفال في تاريخ التقرير، والفرق يدخل قائمة الدخل لا حقوق الملكية.
 */

/** العملات التي تُعاد ترجمتها — الأساسية لا تُقيَّم بنفسها. */
export function foreignCurrencies(base: Currency): Currency[] {
  return (["YER", "SAR", "USD"] as Currency[]).filter((currency) => currency !== base);
}

export interface FxPosition {
  currency: Currency;
  /** ما في الصندوق من هذه العملة — بوحداتها الصغرى هي، لا بالمكافئ. */
  heldMinor: number;
  /** قيمته في الدفاتر بالعملة الأساسية، بأسعار أيامه. */
  bookValueMinor: number;
  rate: number;
  /** قيمته اليوم بسعر اليوم. */
  revaluedMinor: number;
  /** موجب = ربح تغيّر سعر، سالب = خسارة. */
  differenceMinor: number;
  /**
   * السعر الضمني في الدفاتر: القيمة الدفترية على الوحدات المحتفظ بها.
   *
   * رقمٌ للمراجعة لا للترحيل: سعرٌ ضمني غير منطقي يعني قيدًا يدويًا على صندوق
   * العملة بلا حركة مقابلة — وهو ما يجب أن يُراجَع **قبل** الترحيل لا بعده.
   */
  impliedRate: number | null;
}

export function revaluePosition(input: {
  currency: Currency;
  base: Currency;
  heldMinor: number;
  bookValueMinor: number;
  rate: number;
}): FxPosition {
  const revaluedMinor = toBaseAmount(input.heldMinor, input.currency, input.base, input.rate);
  const major = input.heldMinor / MINOR_UNITS[input.currency];
  return {
    currency: input.currency,
    heldMinor: input.heldMinor,
    bookValueMinor: input.bookValueMinor,
    rate: input.rate,
    revaluedMinor,
    differenceMinor: revaluedMinor - input.bookValueMinor,
    impliedRate: major === 0
      ? null
      : Math.round((input.bookValueMinor / MINOR_UNITS[input.base] / major) * 100) / 100,
  };
}

/**
 * السعر الفعلي لما مرّ من عملة — وزنيًا لا حسابيًا.
 *
 * متوسط الأسعار الحسابي يعطي دفعةَ عشرة دولارات وزن دفعةِ ألف. والفرق ليس نظريًا:
 * الوزني هو السعر الذي دخلت به النقود فعلًا.
 */
export function effectiveRate(
  rows: { amountMinor: number; baseAmountMinor: number }[],
  currency: Currency,
  base: Currency,
  fallback: number,
): number {
  if (currency === base) return 1;
  let amount = 0;
  let baseAmount = 0;
  for (const row of rows) {
    amount += row.amountMinor;
    baseAmount += row.baseAmountMinor;
  }
  const major = amount / MINOR_UNITS[currency];
  if (major === 0) return fallback;
  return (baseAmount / MINOR_UNITS[base]) / major;
}

/** هل يستحق الفرق قيدًا؟ فرقٌ بريال واحد قيدٌ يُتعب الدفاتر بلا فائدة. */
export function isWorthPosting(differenceMinor: number, thresholdMinor = 1): boolean {
  return Math.abs(differenceMinor) >= Math.max(1, thresholdMinor);
}

export function revaluationDescription(currency: Currency, rate: number, date: string): string {
  return `إعادة تقييم ${currency} بسعر ${rate} في ${date}`;
}
