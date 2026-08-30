/**
 * دليل الخدمات الافتراضي — يُزرع مرةً واحدة عند أول إقلاع على دليلٍ فارغ.
 *
 * **لماذا هذا الملف أصلاً**: السلسلة المالية كلها كانت موصولة (زيارة ← إجراءات ←
 * فاتورة ← حساب المريض ← وردية الصندوق) لكن دليل الخدمات كان يبدأ **فارغًا** —
 * وقائمة «أضف إجراءً من دليل الخدمات» الخاوية تعني أن الطبيب لا يستطيع تسجيل نزع
 * عصبٍ ولا وتدًا ولا بناءً بأسعارها، فيبدو المسار كله غير موجود وهو موجود.
 *
 * الأسعار هنا **اقتراحات أولية قابلة للتعديل** من شاشة المالية ← الخدمات، لا حكمًا:
 * سوقٌ يتغيّر كل موسم، والنظام يحفظ سعر لحظة الاتفاق في الفاتورة فيمتنع أثرُ تغيّره.
 *
 * والفئات **ليست حرة تمامًا**: الفئات المعرَّفة في `CATEGORY_TO_CONDITION` هي التي
 * تجعل «حشوة نُفّذت» تصير حشوةً على المخطط السني بلا تسجيلٍ ثانٍ. فأي فئة جديدة
 * خارج الخريطة تعمل تمامًا ماليًّا لكنها لن تُحدّث المخطط — وهو فرقٌ يجب أن يعرفه
 * من يضيف خدمة.
 */

export interface CatalogService {
  name: string;
  category: string | null;
  /** السعر بالوحدات الصغرى للعملة الأساسية — والريال اليمني بوحدته (بلا فلس). */
  priceMinor: number;
  sortOrder: number;
}

/** فئات تُحدّث المخطط السني تلقائيًا عند توقيع الزيارة — نفس مفاتيح clinical.ts. */
export const CHART_CATEGORIES = [
  "filling",
  "rct",
  "crown",
  "bridge",
  "implant",
  "extraction",
  "veneer",
  "sealant",
  "ortho",
] as const;

/**
 * كل الفئات المعروفة — المخططية منها وغير المخططية.
 *
 * «post» (وتدٌ وبناء) عمدًا خارج خريطة المخطط: الوتد وحده لا يغيّر حالة السن النهائية
 * — التاج الذي يأتي بعده هو ما يُحفر على المخطط. وتفاصيلُ ماليّة نظيفة في تقرير الإيراد.
 */
export const CATEGORY_LABEL: Record<string, string> = {
  consultation: "كشف واستشارة",
  cleaning: "تنظيف ولثة",
  filling: "حشوات",
  rct: "علاج جذور",
  post: "وتد وبناء",
  crown: "تيجان",
  bridge: "جسور",
  veneer: "قشور تجميلية",
  implant: "زراعة",
  extraction: "خلع",
  surgery: "جراحة",
  sealant: "وقاية",
  whitening: "تجميض وتبييض",
  ortho: "تقويم",
  xray: "أشعة",
};

/** الدليل الافتراضي — الأسماء بالعربية كما تُكتب في وصفة العيادة لا كما تُكتب في الكتب. */
export const DEFAULT_SERVICES: CatalogService[] = [
  // الكشف
  { name: "كشف واستشارة",              category: "consultation", priceMinor: 5_000,   sortOrder: 10 },
  { name: "زيارة متابعة",              category: "consultation", priceMinor: 3_000,   sortOrder: 11 },

  // التنظيف واللثة
  { name: "تنظيف جير كامل",            category: "cleaning",     priceMinor: 10_000,  sortOrder: 20 },
  { name: "تنظيف جير (جلسة)",          category: "cleaning",     priceMinor: 5_000,   sortOrder: 21 },

  // الحشوات
  { name: "حشوة ضوئية",                category: "filling",      priceMinor: 25_000,  sortOrder: 30 },
  { name: "حشوة عادية (أمالغم)",       category: "filling",      priceMinor: 12_000,  sortOrder: 31 },
  { name: "حشوة مؤقتة",                category: "filling",      priceMinor: 5_000,   sortOrder: 32 },

  // علاج الجذور
  { name: "نزع عصب — سن أمامي",        category: "rct",          priceMinor: 30_000,  sortOrder: 40 },
  { name: "نزع عصب — ضاحك",            category: "rct",          priceMinor: 35_000,  sortOrder: 41 },
  { name: "نزع عصب — طاحونة",          category: "rct",          priceMinor: 40_000,  sortOrder: 42 },
  { name: "نزع عصب — رحى أولى",        category: "rct",          priceMinor: 45_000,  sortOrder: 43 },
  { name: "إعادة نزع عصب",             category: "rct",          priceMinor: 50_000,  sortOrder: 44 },

  // وتد وبناء — خارج خريطة المخطط عمدًا (انظر أعلاه)
  { name: "وتد ألياف زجاجية",          category: "post",         priceMinor: 20_000,  sortOrder: 50 },
  { name: "وتد معدني",                 category: "post",         priceMinor: 15_000,  sortOrder: 51 },
  { name: "بناء نواة (Core)",          category: "post",         priceMinor: 20_000,  sortOrder: 52 },

  // التيجان
  { name: "تاج معدني",                 category: "crown",        priceMinor: 40_000,  sortOrder: 60 },
  { name: "تاج خزفي",                  category: "crown",        priceMinor: 60_000,  sortOrder: 61 },
  { name: "تاج زركونيا",               category: "crown",        priceMinor: 100_000, sortOrder: 62 },
  { name: "تاج مؤقت",                  category: "crown",        priceMinor: 10_000,  sortOrder: 63 },

  // الجسور — لكل سنّ، والكمية تحمل عدد الوحدات
  { name: "جسر معدني (لكل سن)",        category: "bridge",       priceMinor: 40_000,  sortOrder: 70 },
  { name: "جسر زركونيا (لكل سن)",      category: "bridge",       priceMinor: 100_000, sortOrder: 71 },

  // القشور
  { name: "قشرة تجميلية (فينير)",      category: "veneer",       priceMinor: 80_000,  sortOrder: 80 },

  // الزراعة
  { name: "زراعة سنّ واحدة (غرسة)",    category: "implant",      priceMinor: 150_000, sortOrder: 90 },

  // الخلع
  { name: "خلع بسيط",                  category: "extraction",   priceMinor: 10_000,  sortOrder: 100 },
  { name: "خلع جذور متبقية",           category: "extraction",   priceMinor: 8_000,   sortOrder: 101 },
  { name: "خلع جراحي",                 category: "surgery",      priceMinor: 25_000,  sortOrder: 110 },
  { name: "خلع ضرس عقل مدفون",         category: "surgery",      priceMinor: 35_000,  sortOrder: 111 },

  // الوقاية
  { name: "سدّ شقوق وقائي",            category: "sealant",      priceMinor: 8_000,   sortOrder: 120 },

  // التبييض
  { name: "تبييض جلسة كاملة",          category: "whitening",    priceMinor: 40_000,  sortOrder: 130 },

  // التقويم
  { name: "تركيب تقويم ثابت (فكّان)",  category: "ortho",        priceMinor: 250_000, sortOrder: 140 },
  { name: "تركيب تقويم ثابت (فكّ واحد)", category: "ortho",      priceMinor: 150_000, sortOrder: 141 },
  { name: "شدّة تقويم (زيارة)",        category: "ortho",        priceMinor: 10_000,  sortOrder: 142 },
  { name: "مثبت ثابت (Retainer)",      category: "ortho",        priceMinor: 40_000,  sortOrder: 143 },
  { name: "إزالة تقويم",               category: "ortho",        priceMinor: 30_000,  sortOrder: 144 },

  // الأشعة
  { name: "أشعة سينية محيطية",         category: "xray",         priceMinor: 5_000,   sortOrder: 150 },
  { name: "أشعة بانورامية",            category: "xray",         priceMinor: 20_000,  sortOrder: 151 },
];

/**
 * فحص سلامة الدليل قبل زرعه — يُستدعى في الاختبارات ولا يُستدعى في الإقلاع.
 *
 * اسمٌ مكرّر يعني اختيارًا غامضًا للموظفة (أيّ «حشوة ضوئية»؟) وسعرٌ سالب يعني خصمًا
 * صامتًا يظهر بعد شهر في تقرير الإيراد. وخارجُ الفئات المعروفة يعني فئةً لن تظهر
 * في أي تجميعة ولا تُحدّث المخطط — فنكتشفها هنا لا في شاشة التقرير.
 */
export function validateCatalog(catalog: CatalogService[] = DEFAULT_SERVICES): string[] {
  const problems: string[] = [];
  const knownCategories = new Set(Object.keys(CATEGORY_LABEL));

  const names = new Set<string>();
  const orders = new Set<number>();

  catalog.forEach((service, index) => {
    const label = `الخدمة #${index + 1} «${service.name}»`;
    const name = service.name.trim();
    if (!name) problems.push(`${label}: الاسم فارغ.`);
    else if (names.has(name)) problems.push(`${label}: الاسم مكرّر.`);
    else names.add(name);

    if (!Number.isInteger(service.priceMinor) || service.priceMinor < 0) {
      problems.push(`${label}: السعر سالب أو ليس عددًا صحيحًا.`);
    }
    if (!Number.isInteger(service.sortOrder) || service.sortOrder < 0) {
      problems.push(`${label}: ترتيب العرض غير صالح.`);
    } else if (orders.has(service.sortOrder)) {
      problems.push(`${label}: ترتيب العرض مكرّر (${service.sortOrder}).`);
    } else {
      orders.add(service.sortOrder);
    }

    if (service.category !== null && !knownCategories.has(service.category)) {
      problems.push(`${label}: الفئة «${service.category}» غير معروفة.`);
    }
  });

  return problems;
}
