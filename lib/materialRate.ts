/**
 * نسبةُ إهلاك المواد لكل تخصّص — المنطق الخالص.
 *
 * طلبها المالك بديلًا عن خصم تكلفة المواد الفعلية: «خصم التكلفة من العمولة
 * اجعلني استطيع اطبقه من الاعدادات او بدلا منها اعمل نسبة اهلاك نحدده لكل تخصص».
 *
 * **ولماذا نسبةٌ لا تكلفةٌ فعلية؟** لأنّ التكلفة الفعلية للمواد لا تُنسب إلى عملٍ
 * بعينه في هذا المركز: صرفُ المخزون يُسجَّل على الزيارة حين يُسجَّل، وكثيرٌ منه لا
 * يُسجَّل أصلًا — قفّازٌ ومخدّرٌ وشاشٌ لا يُعدّ. فخصمُ «التكلفة الفعلية» يخصم من
 * طبيبٍ سجّل ولا يخصم من طبيبٍ لم يسجّل، وهو عقابٌ على الدقّة لا حسابٌ للتكلفة.
 *
 * والنسبةُ تعترف بذلك: تقديرٌ متّفقٌ عليه سلفًا، معلومٌ للطبيب قبل أن يعمل، سواءٌ
 * على من سجّل ومن لم يسجّل. **وهي قرار المالك لا حسابُ النظام** — لا رقم افتراضيّ:
 * تخصّصٌ بلا نسبةٍ محدَّدة لا يُخصم منه شيء، ويُقال كم من المحصَّل بلا نسبة.
 *
 * والوحدة **نقطةُ أساس** (basis point) لا نسبةٌ عشرية: ١٠٬٠٠٠ نقطة = ١٠٠٪،
 * فـ٧٫٥٪ = ٧٥٠ نقطة. عددٌ صحيحٌ كالمال، فلا يتسرّب كسرٌ ثنائيّ إلى ما يُصرف.
 */

/** ١٠٠٪ — سقفُ النسبة. */
export const FULL_RATE_BP = 10_000;

/**
 * يقرأ نسبةً كتبها المالك ويعيدها نقاطَ أساس.
 *
 * **والسقف مئةٌ بالمئة**: نسبةٌ فوقها تعني موادَّ كلّفت أكثر ممّا حُصّل من العمل،
 * فتأكل العمولة كلَّها ويبقى فائضٌ يظهر «غير مُغطّى» — رقمٌ لا معنى له إلا أنّ
 * أحدًا كتب ٧٥٠ حيث أراد ٧٫٥.
 */
export function parseRateBp(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) return bpOf(input);
  if (typeof input !== "string") return null;
  // الأرقام العربية والفواصل: الفاصلة العربية العشرية٫ تُصبح نقطةً لا تُمحى،
  // والفاصلة الإنجليزية والآلاف العربية والنسبة تُنزع.
  const text = input
    .replace(/[\u066B]/g, ".")
    .replace(/[\u066C,،٪%\s]/g, "")
    .trim();
  if (text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? bpOf(value) : null;
}

function bpOf(percent: number): number | null {
  const bp = Math.round(percent * 100);
  if (!Number.isInteger(bp) || bp < 0 || bp > FULL_RATE_BP) return null;
  return bp;
}

/** نصُّ النسبة كما تُعرض — من نقاط الأساس. */
export const ratePercentText = (bp: number): string =>
  (bp / 100).toFixed(2).replace(/\.?0+$/, "");

export interface MaterialCost {
  /** تكلفةُ المواد المقدَّرة على ما حُصّل من عمل الطبيب. */
  costMinor: number;
  /**
   * ما حُصّل من عملٍ في تخصّصٍ بلا نسبةٍ محدَّدة.
   *
   * ويُعرض ولا يُقدَّر بمتوسّطٍ ولا بصفرٍ صامت: صفرٌ صامت يقول «لا مواد لهذا
   * العمل»، والحقيقة أنّ أحدًا لم يحدّد نسبته بعد. والفرق بينهما مالٌ يُصرف.
   */
  unratedCoveredMinor: number;
}

/**
 * تكلفةُ المواد المقدَّرة من المحصَّل موزَّعًا على التخصّصات.
 *
 * والأساسُ **المحصَّل لا المفوتَر**: العمولة نفسها على المحصَّل، فلو خُصمت مواد
 * عملٍ لم يُدفع ثمنُه بعد لصار الطبيب مدينًا بمواد مريضٍ لم يدفع — وهو بالضبط ما
 * بُني حساب العمولة كلُّه ليتجنّبه.
 */
export function materialCost(
  coveredByCategory: ReadonlyMap<string | null, number>,
  rateByCategory: ReadonlyMap<string, number>,
): MaterialCost {
  let costMinor = 0;
  let unratedCoveredMinor = 0;
  for (const [category, covered] of coveredByCategory) {
    if (covered <= 0) continue;
    const bp = category === null ? undefined : rateByCategory.get(category);
    if (bp === undefined) { unratedCoveredMinor += covered; continue; }
    costMinor += Math.round((covered * bp) / FULL_RATE_BP);
  }
  return { costMinor, unratedCoveredMinor };
}
