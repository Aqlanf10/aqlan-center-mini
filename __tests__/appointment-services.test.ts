import { describe, expect, it } from "vitest";
import {
  MAX_BUFFER,
  MAX_DURATION,
  MAX_PRIORITY,
  MIN_DURATION,
  MIN_PRIORITY,
  SPECIALTIES,
  SPECIALTY_LABEL,
  STARTER_SERVICES,
  effectiveWindow,
  normalizeCode,
  searchServices,
  validateService,
  windowsOverlap,
  type AppointmentService,
  type AppointmentServiceInput,
  type ServiceSpecialty,
  CODE_PATTERN,
} from "@/lib/appointment-services";

/* حرفٌ عربيّ واحد يكفي للحكم بأن الرسالة كُتبت للمستخدم لا للمطوّر. */
const ARABIC = /[؀-ۿ]/;


const input = (over: Partial<AppointmentServiceInput> = {}): AppointmentServiceInput => ({
  code: "ORTHO_FOLLOW_UP",
  nameAr: "متابعة تقويم",
  nameEn: "Ortho follow-up",
  specialty: "orthodontics",
  defaultDurationMinutes: 10,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  requiresProvider: true,
  requiresChair: true,
  allowsConcurrentProviderWork: false,
  consumesEmergencyReserve: false,
  priority: 50,
  badgeClass: null,
  isActive: true,
  sortOrder: 10,
  ...over,
});

const entity = (over: Partial<AppointmentService> = {}): AppointmentService => ({
  id: 1,
  code: "ORTHO_FOLLOW_UP",
  nameAr: "متابعة تقويم / شدّ",
  nameEn: "Ortho follow-up",
  specialty: "orthodontics",
  defaultDurationMinutes: 10,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  requiresProvider: true,
  requiresChair: true,
  allowsConcurrentProviderWork: false,
  consumesEmergencyReserve: false,
  priority: 50,
  badgeClass: null,
  isActive: true,
  sortOrder: 10,
  legacyType: null,
  createdAt: "2026-09-13T09:00:00.000Z",
  createdBy: null,
  updatedAt: "2026-09-13T09:00:00.000Z",
  updatedBy: null,
  ...over,
});

/** الكتالوج الابتدائي كما لو قُرئ من القاعدة — لاختبار البحث على بياناتٍ واقعية. */
const CATALOG: AppointmentService[] = STARTER_SERVICES.map((service, index) => entity({
  ...service,
  id: index + 1,
  specialty: service.specialty as ServiceSpecialty,
  nameEn: null,
  badgeClass: service.badgeClass ?? null,
  legacyType: service.legacyType ?? null,
}));

/**
 * توحيد الرمز — الموظّف لا يكتب رمزًا نظيفًا، والاستقبال ليس محرّر شيفرة.
 *
 * يُكتب «ortho follow up» في خانةٍ عجلى بين مريضين، ويُلصق أحيانًا بمسافةٍ زائدة من
 * ورقةٍ أو رسالة. فإن لم تُوحَّد الكتابة نشأ رمزان لخدمةٍ واحدة، وانقسم تقرير
 * «كم متابعةَ تقويمٍ عملنا هذا الشهر» نصفين لا يجمعهما أحد.
 */
describe("توحيد رمز الخدمة", () => {
  it("الحروف الصغيرة تُرفع إلى كبيرة", () => {
    expect(normalizeCode("ortho_follow_up")).toBe("ORTHO_FOLLOW_UP");
  });

  it("والمسافات والشرطات تصير شرطةً سفلية واحدة مهما تكرّرت", () => {
    expect(normalizeCode("ortho follow up")).toBe("ORTHO_FOLLOW_UP");
    expect(normalizeCode("ortho-follow-up")).toBe("ORTHO_FOLLOW_UP");
    expect(normalizeCode("ortho -  follow \t up")).toBe("ORTHO_FOLLOW_UP");
  });

  it("والمسافات المحيطة تُقتطع فلا يُولد رمزٌ يبدأ بشرطةٍ سفلية", () => {
    expect(normalizeCode("   ortho case   ")).toBe("ORTHO_CASE");
    expect(normalizeCode("\n\t bracket bonding \t\n")).toBe("BRACKET_BONDING");
    expect(normalizeCode("   ")).toBe("");
  });

  it("والحروف الدخيلة تبقى كما هي — التوحيد لا يبتر، والتحقّق هو من يرفض", () => {
    /* لو حذفت `normalizeCode` الحرف الدخيل صامتةً لصار «ortho.case#1» رمزًا مقبولًا
       باسم ORTHOCASE1 لا يعرفه من كتبه. فالبتر الصامت أسوأ من الرفض الصريح. */
    expect(normalizeCode("ortho.case#1")).toBe("ORTHO.CASE#1");
    expect(normalizeCode("متابعة ortho")).toBe("متابعة_ORTHO");
    expect(validateService(input({ code: "ortho.case#1" }))).not.toBeNull();
    expect(validateService(input({ code: "متابعة ortho" }))).not.toBeNull();
  });
});

/**
 * شكل الرمز — هويةٌ تُقرأ في تكاملٍ خارجيّ ولا تُترجم.
 *
 * الرمز هو ما يربط الخدمة بمواعيد قديمة وبتصدير CSV وبأي تكاملٍ لاحق. حرفٌ واحد
 * لا يُميّز شيئًا، ورمزٌ يبدأ برقم يكسر مُعرِّفات كثيرٍ من الأنظمة، وأربعون حرفًا
 * حدٌّ يكفي أطول خدمةٍ ويمنع لصقَ جملةٍ كاملة في خانة الهوية.
 */
describe("شكل رمز الخدمة", () => {
  it("رمزٌ يبدأ برقم مرفوض", () => {
    expect(CODE_PATTERN.test("1ORTHO")).toBe(false);
    expect(validateService(input({ code: "1ortho" }))).not.toBeNull();
  });

  it("ورمزٌ من حرفٍ واحد مرفوض", () => {
    expect(CODE_PATTERN.test("A")).toBe(false);
    expect(validateService(input({ code: "a" }))).not.toBeNull();
  });

  it("وأربعون حرفًا مقبولة وواحدٌ وأربعون مرفوض", () => {
    const forty = `A${"B".repeat(39)}`;
    const fortyOne = `A${"B".repeat(40)}`;
    expect(forty).toHaveLength(40);
    expect(CODE_PATTERN.test(forty)).toBe(true);
    expect(CODE_PATTERN.test(fortyOne)).toBe(false);
    expect(validateService(input({ code: forty }))).toBeNull();
    expect(validateService(input({ code: fortyOne }))).not.toBeNull();
  });

  it("ورمزٌ سليم يمرّ ولو كُتب صغيرًا أو بمسافات — التوحيد يسبق الحكم", () => {
    expect(CODE_PATTERN.test("ORTHO_START_2")).toBe(true);
    expect(validateService(input({ code: "ORTHO_START_2" }))).toBeNull();
    expect(validateService(input({ code: "  ortho start 2  " }))).toBeNull();
  });

  it("والنمط يُستورد من الوحدة نفسها — لا نسخةً تنحرف عنه بصمت", () => {
    /* كان هنا نسخةٌ من النمط وحارسٌ يقرأ الملف نصًّا ليمنع افتراقهما. صار النمط
       مُصدَّرًا، فالاستيراد المباشر يجعل الافتراق مستحيلًا لا مكشوفًا بعد وقوعه. */
    expect(CODE_PATTERN.source).toBe("^[A-Z][A-Z0-9_]{1,39}$");
  });
});

/**
 * حدود المدّة — المدّة هي ما يُبنى عليه حساب السعة كلُّه.
 *
 * صفرُ دقائق أو مدّةٌ سالبة تجعل الموعد بلا وزنٍ في اليوم فيُحشر فوقه عشرة غيره،
 * وثمانٍ وأربعون ساعة تلتهم اليوم كلَّه فتُغلق الأجندة أمام مرضى حقيقيين. والحدّان
 * ٥ و٤٨٠ مقبولان لأنهما واقعان فعلًا: مراجعةٌ خمس دقائق، وجراحةُ يومٍ ثمانِ ساعات.
 */
describe("حدود مدّة الخدمة", () => {
  it("أقلّ من خمس دقائق وأكثر من ثماني ساعات مرفوضتان", () => {
    expect(validateService(input({ defaultDurationMinutes: MIN_DURATION - 1 }))).not.toBeNull();
    expect(validateService(input({ defaultDurationMinutes: 0 }))).not.toBeNull();
    expect(validateService(input({ defaultDurationMinutes: -10 }))).not.toBeNull();
    expect(validateService(input({ defaultDurationMinutes: MAX_DURATION + 1 }))).not.toBeNull();
  });

  it("والحدّان نفسهما مقبولان — ٥ و٤٨٠", () => {
    expect(validateService(input({ defaultDurationMinutes: MIN_DURATION }))).toBeNull();
    expect(validateService(input({ defaultDurationMinutes: MAX_DURATION }))).toBeNull();
  });

  it("والمدّة الكسرية مرفوضة — لا نصفَ دقيقةٍ في أجندة", () => {
    expect(validateService(input({ defaultDurationMinutes: 12.5 }))).not.toBeNull();
  });
});

/**
 * فواصل التجهيز — صفرٌ قيمةٌ صحيحة لا خانةٌ منسيّة.
 *
 * متابعةُ تقويمٍ عشر دقائق بلا تجهيزٍ قبلها ولا بعدها أمرٌ واقع في مساءٍ يرى ثلاثين
 * مريضًا؛ فمنعُ الصفر يفرض على المالك كذبًا في الأرقام. وفي المقابل فاصلٌ يفوق
 * ساعتين يعني أن أحدهم كتب المدّة في خانة الفاصل، وذلك يُفرغ اليوم بلا سبب.
 */
describe("فواصل التجهيز حول الموعد", () => {
  it("صفرٌ مقبول قبل الموعد وبعده", () => {
    expect(validateService(input({ bufferBeforeMinutes: 0, bufferAfterMinutes: 0 }))).toBeNull();
  });

  it("وما فوق ساعتين مرفوض في الطرفين", () => {
    expect(validateService(input({ bufferBeforeMinutes: MAX_BUFFER + 1 }))).not.toBeNull();
    expect(validateService(input({ bufferAfterMinutes: MAX_BUFFER + 1 }))).not.toBeNull();
    expect(validateService(input({ bufferBeforeMinutes: MAX_BUFFER }))).toBeNull();
    expect(validateService(input({ bufferAfterMinutes: MAX_BUFFER }))).toBeNull();
  });

  it("والفاصل السالب مرفوض — لا يُسرق وقتٌ من موعدٍ سابق", () => {
    expect(validateService(input({ bufferBeforeMinutes: -1 }))).not.toBeNull();
    expect(validateService(input({ bufferAfterMinutes: -5 }))).not.toBeNull();
  });
});

/**
 * الاسم والتخصّص والأولوية — ما يظهر على الشاشة وما يرتّب الازدحام.
 *
 * خدمةٌ بلا اسمٍ عربيّ تظهر فراغًا في قائمة الحجز فيختار الموظّف غيرها؛ وتخصّصٌ
 * مجهول يكسر التصفية والتلوين في شاشة اليوم؛ والأولوية هي ما يقرّر من يُقدَّم حين
 * يزدحم الوقت، فقيمةٌ خارج المدى تجعل الترتيب عشوائيًّا في أحرج لحظة.
 */
describe("الاسم والتخصّص والأولوية", () => {
  it("اسمٌ عربيّ فارغ أو مسافاتٌ فقط مرفوض", () => {
    expect(validateService(input({ nameAr: "" }))).not.toBeNull();
    expect(validateService(input({ nameAr: "   " }))).not.toBeNull();
    expect(validateService(input({ nameAr: "\t\n " }))).not.toBeNull();
  });

  it("واسمٌ يتجاوز ثمانين حرفًا مرفوض — الشاشة لا تتّسع لجملة", () => {
    expect(validateService(input({ nameAr: "م".repeat(80) }))).toBeNull();
    expect(validateService(input({ nameAr: "م".repeat(81) }))).not.toBeNull();
  });

  it("وتخصّصٌ غير معروف مرفوض", () => {
    expect(validateService(input({ specialty: "dermatology" }))).not.toBeNull();
    expect(validateService(input({ specialty: "" }))).not.toBeNull();
    expect(validateService(input({ specialty: "ORTHODONTICS" }))).not.toBeNull();
    expect(validateService(input({ specialty: "orthodontics" }))).toBeNull();
  });

  it("وأولويةٌ خارج المدى مرفوضة وحدّاها مقبولان", () => {
    expect(validateService(input({ priority: MIN_PRIORITY - 1 }))).not.toBeNull();
    expect(validateService(input({ priority: MAX_PRIORITY + 1 }))).not.toBeNull();
    expect(validateService(input({ priority: MIN_PRIORITY }))).toBeNull();
    expect(validateService(input({ priority: MAX_PRIORITY }))).toBeNull();
  });

  it("وترتيبٌ سالب أو فوق ٩٩٩٩ مرفوض", () => {
    expect(validateService(input({ sortOrder: -1 }))).not.toBeNull();
    expect(validateService(input({ sortOrder: 10_000 }))).not.toBeNull();
    expect(validateService(input({ sortOrder: 0 }))).toBeNull();
  });
});

/**
 * لغة الرفض — رسالةٌ يفهمها الاستقبال أو خانةٌ حمراء بلا معنى.
 *
 * من يملأ هذه الشاشة موظّفُ استقبالٍ لا مطوِّر. رسالةٌ إنجليزية أو رمزُ خطأ يعني
 * أنه سيعيد المحاولة عشوائيًّا ثم يترك الخدمة غير مضافة، فيعود العمل الجديد يُحجز
 * تحت «إجراء عام» — وهو بالضبط العطب الذي بُني هذا الكتالوج ليُنهيه.
 */
describe("قبول المدخل السليم ولغة الرفض", () => {
  it("مدخلٌ سليم بالكامل يعيد null بلا اعتراض", () => {
    expect(validateService(input())).toBeNull();
  });

  it("وكلّ رسالة رفضٍ نصٌّ عربيّ غير فارغ", () => {
    const rejected: Array<[string, Partial<AppointmentServiceInput>]> = [
      ["رمز يبدأ برقم", { code: "1ORTHO" }],
      ["رمز من حرف", { code: "A" }],
      ["رمز طويل", { code: `A${"B".repeat(40)}` }],
      ["رمز بحروف دخيلة", { code: "ortho.case#1" }],
      ["اسم فارغ", { nameAr: "  " }],
      ["اسم طويل", { nameAr: "م".repeat(81) }],
      ["تخصص مجهول", { specialty: "dermatology" }],
      ["مدة قصيرة", { defaultDurationMinutes: MIN_DURATION - 1 }],
      ["مدة طويلة", { defaultDurationMinutes: MAX_DURATION + 1 }],
      ["فاصل قبلي كبير", { bufferBeforeMinutes: MAX_BUFFER + 1 }],
      ["فاصل بعدي سالب", { bufferAfterMinutes: -1 }],
      ["أولوية صفر", { priority: 0 }],
      ["أولوية كبيرة", { priority: MAX_PRIORITY + 1 }],
      ["ترتيب سالب", { sortOrder: -1 }],
    ];
    for (const [label, patch] of rejected) {
      const message = validateService(input(patch));
      expect(message, label).toBeTypeOf("string");
      expect(message?.trim().length ?? 0, label).toBeGreaterThan(0);
      expect(message ?? "", label).toMatch(ARABIC);
    }
  });
});

/**
 * نافذة الإشغال — الفاصل جزءٌ من الحجز لا زينةٌ حوله.
 *
 * الكرسي الذي يُعقَّم عشر دقائق بعد الزراعة مشغولٌ فعلًا في تلك العشر. فإن حسبت
 * النافذة المدّة وحدها بيع الوقت مرّتين، ووقف مريضان أمام كرسيٍّ واحد — وهذه هي
 * الزحمة التي يراها المالك في صالة الانتظار لا في الشاشة.
 */
describe("نافذة الإشغال الفعلية", () => {
  it("الفواصل تمدّ النافذة من الطرفين", () => {
    expect(effectiveWindow({
      startMinutes: 600, durationMinutes: 45, bufferBeforeMinutes: 5, bufferAfterMinutes: 10,
    })).toEqual({ start: 595, end: 655 });
  });

  it("وبلا فواصل النافذة هي المدّة نفسها بالضبط", () => {
    expect(effectiveWindow({
      startMinutes: 600, durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
    })).toEqual({ start: 600, end: 630 });
  });

  it("والفاصل السالب يُعامَل صفرًا فلا يقلب النافذة على نفسها", () => {
    expect(effectiveWindow({
      startMinutes: 600, durationMinutes: 30, bufferBeforeMinutes: -20, bufferAfterMinutes: -20,
    })).toEqual({ start: 600, end: 630 });
  });

  it("والمدّة الصفرية أو السالبة تُعطى دقيقةً واحدة — لا نافذةً بعرض صفر", () => {
    /* نافذةٌ بعرض صفر لا تتداخل مع شيء لأن `windowsOverlap` صارمة، فموعدٌ بمدّة
       صفر كان يمرّ على كرسيٍّ مشغول ويُقال «متاح» — وهو ما يحرسه المحرّك القديم
       بأرضيّةٍ في `overlappingCount`. الأرضيّة هنا تعيد التكافؤ بينهما. */
    expect(effectiveWindow({
      startMinutes: 600, durationMinutes: 0, bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
    })).toEqual({ start: 600, end: 601 });
    expect(effectiveWindow({
      startMinutes: 600, durationMinutes: -30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
    })).toEqual({ start: 600, end: 601 });
  });

  it("والفاصل القبليّ يدفع البداية إلى ما قبل منتصف الليل بلا تثبيتٍ عند الصفر", () => {
    /* سلوكٌ موثَّق كما هو: النافذة إزاحةٌ حسابية لا وقتَ ساعةٍ حقيقيّ، والقيمة
       السالبة تبقى صالحةً للمقارنة مع نوافذ اليوم نفسه. ومن يعرضها على مستخدم
       عليه أن يقصّها عنده لا هنا. */
    expect(effectiveWindow({
      startMinutes: 5, durationMinutes: 30, bufferBeforeMinutes: 10, bufferAfterMinutes: 0,
    })).toEqual({ start: -5, end: 35 });
  });
});

/**
 * التداخل — قرارُ «هل يتزاحمان» هو ما يمنع مريضين على كرسيٍّ واحد.
 *
 * وهو قرارٌ ذو حدّين: تساهلٌ يُجلس اثنين على كرسي، وتشدّدٌ يُهدر فتحةً في كل ساعة.
 * والنهاية الملامسة هي بالضبط موضع الخلاف، فتُثبَّت هنا صراحةً.
 */
describe("تداخل نافذتين", () => {
  it("التداخل الحقيقيّ يُكتشف", () => {
    expect(windowsOverlap({ start: 600, end: 630 }, { start: 620, end: 650 })).toBe(true);
    expect(windowsOverlap({ start: 600, end: 700 }, { start: 620, end: 640 })).toBe(true);
  });

  it("والنهاية الملامسة ليست تزاحمًا — موعدٌ يعقب موعدًا مباشرةً حجزٌ سليم", () => {
    /* قرار تصميمٍ مقصود: الكرسي يخلو ١٠:٢٠ ويُشغل ١٠:٢٠. واعتبارهما متداخلين يعني
       فتحةً ضائعة بين كل موعدين — أي عشرات الدقائق كلَّ مساء في مركزٍ مزدحم. */
    expect(windowsOverlap({ start: 600, end: 620 }, { start: 620, end: 640 })).toBe(false);
    expect(windowsOverlap({ start: 620, end: 640 }, { start: 600, end: 620 })).toBe(false);
  });

  it("والنافذتان المتباعدتان لا تتزاحمان", () => {
    expect(windowsOverlap({ start: 600, end: 620 }, { start: 700, end: 720 })).toBe(false);
    expect(windowsOverlap({ start: 700, end: 720 }, { start: 600, end: 620 })).toBe(false);
  });

  it("والحكم متماثل مهما اختلف ترتيب الطرفين", () => {
    const pairs: Array<[{ start: number; end: number }, { start: number; end: number }]> = [
      [{ start: 600, end: 630 }, { start: 620, end: 650 }],
      [{ start: 600, end: 620 }, { start: 620, end: 640 }],
      [{ start: 600, end: 620 }, { start: 700, end: 720 }],
      [{ start: 600, end: 700 }, { start: 610, end: 620 }],
      [{ start: 600, end: 600 }, { start: 590, end: 610 }],
    ];
    for (const [a, b] of pairs) {
      expect(windowsOverlap(a, b), JSON.stringify([a, b])).toBe(windowsOverlap(b, a));
    }
  });
});

/**
 * الكتالوج الابتدائي — يُزرع مرّةً واحدة، ولا أحد يراجعه بعدها.
 *
 * هذه البذرة تدخل قاعدة الإنتاج عند أوّل تشغيل. رمزٌ مكرّر فيها يعني سطرًا يسقط
 * بخطأ فريدٍ في أوّل دقيقةٍ من عمر المركز، و`legacyType` مكرّر يعني موعدًا قديمًا
 * يُربط بالخدمة الخطأ فيظهر «تنظيف» مكان «حشوة» في سجلّ مريضٍ حقيقيّ.
 */
describe("سلامة الكتالوج الابتدائي", () => {
  it("لا رمزَ مكرّرًا", () => {
    const codes = STARTER_SERVICES.map((service) => service.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("وكلّ رمزٍ مطابقٌ لنمط الرموز ومُوحَّدٌ أصلًا", () => {
    for (const service of STARTER_SERVICES) {
      expect(CODE_PATTERN.test(service.code), service.code).toBe(true);
      expect(normalizeCode(service.code), service.code).toBe(service.code);
    }
  });

  it("وكلّ مدخلٍ يجتاز التحقّق بلا اعتراض", () => {
    for (const service of STARTER_SERVICES) {
      expect(validateService(service), service.code).toBeNull();
    }
  });

  it("وكلّ تخصّصٍ مذكورٍ فيها معروفٌ وله تسمية", () => {
    for (const service of STARTER_SERVICES) {
      expect(SPECIALTIES, service.code).toContain(service.specialty);
      expect(SPECIALTY_LABEL[service.specialty as ServiceSpecialty], service.code).toMatch(ARABIC);
    }
  });

  it("و`legacyType` لا يتكرّر بين المدخلات التي تحمله", () => {
    const legacy = STARTER_SERVICES
      .map((service) => service.legacyType)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    expect(legacy.length).toBeGreaterThan(0);
    expect(new Set(legacy).size).toBe(legacy.length);
  });
});

/**
 * البحث — الموظّف يكتب بالعربية وهو واقفٌ أمام مريض.
 *
 * كتالوجٌ من عشرين خدمةً فأكثر لا يُتصفَّح بالعين في لحظة حجز. فإن لم يجد الاسم
 * العربيّ عاد الموظّف إلى «إجراء عام» ليُنهي الطابور، فتُكسر إحصاءات الخدمات من
 * حيث أُريد إصلاحها.
 */
describe("البحث في الخدمات", () => {
  it("يجد بجزءٍ من الاسم العربيّ", () => {
    const found = searchServices(CATALOG, "براكيت").map((service) => service.code);
    expect(found).toContain("BRACKET_REBOND");
    expect(found).toContain("BRACKET_BONDING");
    expect(found).not.toContain("CLEANING");
  });

  it("ويجد بالرمز بلا حساسيةٍ لحالة الأحرف", () => {
    const lower = searchServices(CATALOG, "ortho_start").map((service) => service.code);
    const upper = searchServices(CATALOG, "ORTHO_START").map((service) => service.code);
    expect(lower).toEqual(["ORTHO_START"]);
    expect(upper).toEqual(lower);
  });

  it("ويجد بتسمية التخصّص العربية أيضًا", () => {
    const found = searchServices(CATALOG, "تركيبات").map((service) => service.code);
    expect(found).toContain("PROSTHETIC_IMPRESSION");
    expect(found).toContain("PROSTHETIC_TRY_IN");
    expect(found).toContain("PROSTHETIC_DELIVERY");
  });

  it("وما لا مقابلَ له يعيد قائمةً فارغة لا كلَّ الكتالوج", () => {
    expect(searchServices(CATALOG, "زرافة")).toEqual([]);
    expect(searchServices(CATALOG, "zzzz")).toEqual([]);
  });

  it("والبحث الفارغ أو بمسافاتٍ فقط يعيد الكتالوج كلَّه", () => {
    /* الشاشة تفتح بخانة بحثٍ فارغة؛ فلو أعادت فارغًا لظنّ الموظّف أن لا خدمات. */
    expect(searchServices(CATALOG, "")).toHaveLength(CATALOG.length);
    expect(searchServices(CATALOG, "   ")).toHaveLength(CATALOG.length);
    expect(searchServices(CATALOG, "\t\n")).toHaveLength(CATALOG.length);
  });
});

/**
 * تسميات التخصّصات — ما يقرؤه الطبيب والموظّف في الفلترة والوسم.
 *
 * تخصّصٌ بلا تسميةٍ عربية يظهر مفتاحًا لاتينيًّا («prosthodontics») في واجهةٍ عربية،
 * أو يظهر فراغًا فلا يُفلتَر أصلًا. والقائمة تنمو بالتخصّصات، فالحارس لازم.
 */
describe("تسميات التخصّصات", () => {
  it("لكلّ تخصّصٍ تسميةٌ عربية غير فارغة", () => {
    expect(SPECIALTIES.length).toBeGreaterThan(0);
    for (const specialty of SPECIALTIES) {
      const label = SPECIALTY_LABEL[specialty];
      expect(label, specialty).toBeTypeOf("string");
      expect(label.trim().length, specialty).toBeGreaterThan(0);
      expect(label, specialty).toMatch(ARABIC);
    }
    expect(Object.keys(SPECIALTY_LABEL).sort()).toEqual([...SPECIALTIES].sort());
  });
});
