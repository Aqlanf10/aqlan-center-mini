import { describe, expect, it } from "vitest";
import {
  ALL_SETTING_KEYS,
  PUBLIC_SETTING_KEYS,
  SETTING_DEFAULTS,
  chairCount,
  numberSetting,
  publicSubset,
  validateSetting,
  withDefaults,
} from "../lib/settings";

describe("قراءة الإعدادات", () => {
  it("تُكمل الناقص بالافتراضي ولا تترك الشاشة فارغة يوم التنصيب", () => {
    const settings = withDefaults({ "clinic.chairs": "3" });
    expect(settings["clinic.chairs"]).toBe("3");
    expect(settings["clinic.name"]).toBe(SETTING_DEFAULTS["clinic.name"]);
    expect(Object.keys(settings)).toHaveLength(ALL_SETTING_KEYS.length);
  });

  it("تعامل القيمة الفارغة كغائبة", () => {
    // صفٌّ في الجدول بقيمة فارغة كان سيجعل اسم المركز فراغًا على السند المطبوع.
    expect(withDefaults({ "clinic.name": "" })["clinic.name"]).toBe(SETTING_DEFAULTS["clinic.name"]);
  });
});

describe("حماية القيم التالفة", () => {
  it("تردّ عدد الكراسي إلى حدوده بدل تعطيل اللوحة", () => {
    // قيمة تالفة كانت ستعطي جدول كراسٍ فارغًا أو قسمة على صفر في حساب الطاقة.
    expect(chairCount(withDefaults({ "clinic.chairs": "0" }))).toBe(1);
    expect(chairCount(withDefaults({ "clinic.chairs": "abc" }))).toBe(2);
    expect(chairCount(withDefaults({ "clinic.chairs": "999" }))).toBe(20);
    expect(chairCount(withDefaults({ "clinic.chairs": "٣" }))).toBe(3);
  });

  it("تقرأ الأرقام العربية الهندية كما تصل من لوحات مفاتيح الهواتف", () => {
    expect(numberSetting(withDefaults({ "finance.rate.USD": "٥٣٠" }), "finance.rate.USD", 1, 1e6)).toBe(530);
  });
});

describe("التحقق عند الحفظ", () => {
  it("يرفض سعر صرف صفرًا أو سالبًا", () => {
    // سعر صفر يجعل كل دفعة بتلك العملة تساوي صفرًا في التقارير بصمت.
    expect(validateSetting("finance.rate.USD", "0")).not.toBeNull();
    expect(validateSetting("finance.rate.USD", "-5")).not.toBeNull();
    expect(validateSetting("finance.rate.USD", "530")).toBeNull();
  });

  it("يرفض عدد كراسٍ غير منطقي ووقتًا بصيغة خاطئة", () => {
    expect(validateSetting("clinic.chairs", "0")).not.toBeNull();
    expect(validateSetting("clinic.chairs", "2")).toBeNull();
    expect(validateSetting("clinic.day_start", "9")).not.toBeNull();
    expect(validateSetting("clinic.day_start", "09:00")).toBeNull();
  });

  it("يقبل إعدادات شاشة الصالة الصالحة ويرفض ما خرج عن قائمتها", () => {
    expect(validateSetting("display.privacy_mode", "first_initial")).toBeNull();
    expect(validateSetting("display.privacy_mode", "first_only")).toBeNull();
    expect(validateSetting("display.privacy_mode", "الاسم الأول")).not.toBeNull();
    expect(validateSetting("display.voice", "true")).toBeNull();
    expect(validateSetting("display.voice", "نعم")).not.toBeNull();
    expect(validateSetting("display.show_ortho", "false")).toBeNull();
    expect(validateSetting("display.tagline", "ابتسامتك تستحق أفضل عناية")).toBeNull();
  });

  it("يقبض على سطور الإعلانات التالفة ويسمّي رقمها", () => {
    // سطر بلا فاصل: الاستقبال لا تعرف أي سطر أخطأ من رسالة عامة.
    expect(validateSetting("display.announcements", "سطر بلا فاصل")).not.toBeNull();
    expect(validateSetting("display.announcements", "عنوان | نص سليم")).toBeNull();
    expect(validateSetting("display.announcements", "عنوان | نص | فيه فاصل آخر")).toBeNull();
    // الفراغ مقبول: يعني «استعمل النصوص الافتراضية».
    expect(validateSetting("display.announcements", "")).toBeNull();
    const longBody = `${"ط".repeat(201)} | نص`;
    expect(validateSetting("display.announcements", longBody)).not.toBeNull();
  });
});

describe("ما تراه الصفحات العامة", () => {
  it("يخرج المسموح وحده — القائمة مسموح لا ممنوع", () => {
    const settings = withDefaults({});
    const shared = publicSubset(settings);
    expect(Object.keys(shared).sort()).toEqual([...PUBLIC_SETTING_KEYS].sort());
    // أسعار الصرف ليست سرًّا خطيرًا، لكنها ليست من شأن شاشة معلّقة في الصالة.
    expect(shared).not.toHaveProperty("finance.rate.USD");
  });
});
