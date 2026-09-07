/**
 * أسعارٌ تخمينية — **للتجربة وحدها، وتُوسَم بذلك في كل موضع تُرى فيه**.
 *
 * (منقول من مستودع الوكيل الآخر aqlan-center-main مع تكييف واحد: أسعارنا
 * مفهرسة **بفئة الخدمة** لا برمز دليل، لأن دليلنا يُبذر بالأسماء والفئات.)
 *
 * **وخطرُها أنّها تعمل.** فسعرٌ مخترعٌ يُفوتر مريضًا حقيقيًّا بمبلغٍ لم يُقرّه أحد،
 * ولا شيء في الفاتورة يقول إنّه تخمين. فلا تُحفظ كسعرٍ عاديّ: تُوسَم
 * `price_provisional`، وتقول شاشةُ الأسعار «تخميني» بجانب كلٍّ منها، وتُنبّه شاشةُ
 * الجاهزية عليها بعددها ما بقيت. **وتعديلُ السعر بيد المالك يمسح الوسم** — لأنّه
 * حينها قرارُه هو لا تخميني.
 *
 * والأرقام بالريال اليمني، **وهي تقديرٌ منّي لا قائمةُ سوقٍ ولا سعرُ هذا المركز**.
 * بُنيت على ترتيبٍ نسبيّ معقول (كشفٌ أرخص من حشوة، وحشوةٌ أرخص من عصب، وعصبٌ أرخص
 * من تاج، وزراعةٌ أعلاها) لا على مسحٍ للأسعار. فالنسب بينها أقربُ إلى الصواب من
 * قيمها المطلقة، والمالك يستبدلها.
 */

/** السعر التخميني بالريال اليمني لكل فئة في دليل خدماتنا. */
export const PROVISIONAL_PRICES: Record<string, number> = {
  // الكشف والاستشارة
  consultation: 4_000,
  // التنظيف والوقاية
  cleaning: 8_000,
  // الحشوات
  filling: 12_000,
  // علاج العصب
  rct: 35_000,
  // الأوتاد والبناء
  post: 15_000,
  // التيجان
  crown: 50_000,
  // الجسور
  bridge: 45_000,
  // القشور التجميلية
  veneer: 70_000,
  // الخلع والجراحة
  surgery: 15_000,
  // الزراعة
  implant: 250_000,
  // أطقم الأسنان
  denture: 120_000,
  // اللثة
  perio: 25_000,
  // تقويم الأسنان
  orthodontics: 250_000,
  // الأطفال
  pediatric: 10_000,
  // الأشعة والتشخيص
  radiology: 6_000,
  // التجميل
  cosmetic: 40_000,
  // الطوارئ
  emergency: 8_000,
};

/** السعر التخميني لفئة — أو `null` إن لم يُقدَّر لها سعر. */
export function provisionalPriceOf(category: string | null | undefined): number | null {
  if (!category) return null;
  const price = PROVISIONAL_PRICES[category];
  return typeof price === "number" && price > 0 ? price : null;
}

export interface PriceableService {
  id: number;
  category: string | null;
  priceConfigured: boolean;
  isActive: boolean;
}

/**
 * أيُّ الخدمات تُملأ بسعرٍ تخميني.
 *
 * **وما سُعّر لا يُمسّ**: من سعّر خدمةً بيده قرّر، وكتابةُ تخمينٍ فوقه تمحو قراره.
 * والمعطّلة لا تُفوتر فلا تُسعَّر. والتي بلا فئةٍ في الدليل لا تُقدَّر — أُضيفت
 * بيدٍ ولا يُعرف ما هي.
 */
export function provisionalFills(
  services: readonly PriceableService[],
): { id: number; priceMinor: number }[] {
  const fills: { id: number; priceMinor: number }[] = [];
  for (const service of services) {
    if (!service.isActive || service.priceConfigured) continue;
    const price = provisionalPriceOf(service.category);
    if (price !== null) fills.push({ id: service.id, priceMinor: price });
  }
  return fills;
}
