import { describe, expect, it } from "vitest";
import {
  SETTING_DEFINITIONS,
  normalizeArabic,
  searchDefinitions,
} from "@/lib/settings-definitions";

/**
 * بحث الإعدادات — بلغة من يبحث لا بلغة من كتب التسمية.
 *
 * المالك يكتب ما يدور في رأسه: «صرف» لا «سعر الريال السعودي»، و«زحمة» لا «تحذير
 * الانتظار»، و«تاخير» بلا همزة لأنّ لوحة المفاتيح أسرع من الإملاء. وبحثٌ لا يجد
 * إلا من يكتب التسمية الرسمية كاملةً مشكولةً ليس بحثًا — هو امتحان.
 */

const keysFor = (term: string) => searchDefinitions(term).map((d) => d.key);

describe("تسوية النصّ العربي", () => {
  it("تُسقط الحركات والتطويل", () => {
    expect(normalizeArabic("مُتَأَخِّرًا")).toBe(normalizeArabic("متأخرا"));
    expect(normalizeArabic("مـــتأخر")).toBe(normalizeArabic("متأخر"));
  });

  it("توحّد صور الألف والياء والتاء المربوطة", () => {
    expect(normalizeArabic("أحمد")).toBe(normalizeArabic("احمد"));
    expect(normalizeArabic("إقفال")).toBe(normalizeArabic("اقفال"));
    expect(normalizeArabic("مبنى")).toBe(normalizeArabic("مبني"));
    expect(normalizeArabic("عملة")).toBe(normalizeArabic("عمله"));
  });

  it("ولا تفسد النصّ اللاتيني", () => {
    expect(normalizeArabic("Late")).toBe("late");
  });
});

describe("ما يكتبه المالك يصل إلى ما يقصده", () => {
  it.each([
    ["تأخير", "ops.late_tolerance_minutes"],
    ["تاخير", "ops.late_tolerance_minutes"],
    ["متأخر", "ops.late_tolerance_minutes"],
    ["late", "ops.late_tolerance_minutes"],
    ["زحمة", "ops.wait_warning_minutes"],
    ["انتظار", "ops.wait_critical_minutes"],
    ["صرف", "finance.rate.SAR"],
    ["سعودي", "finance.rate.SAR"],
    ["دولار", "finance.rate.USD"],
    ["عمولة", "finance.commission_material_rate"],
    ["إقفال", "finance.locked_before"],
    ["اقفال", "finance.locked_before"],
    ["كراسي", "clinic.chairs"],
    ["حجز", "scheduling.max_days_ahead"],
    ["صلاحية", "inventory.expiry_soon_days"],
    ["متابعة", "ops.follow_up_lookback_days"],
    ["لم يحضر", "ops.follow_up_lookback_days"],
    ["نداء", "display.voice"],
    ["دوام", "clinic.day_start"],
    ["نسخ", "backup.enabled"],
  ])("«%s» تجد %s", (term, key) => {
    expect(keysFor(term)).toContain(key);
  });

  it("«زحمة» تجمع العتبتين معًا لا واحدة", () => {
    const hits = keysFor("زحمة");
    expect(hits).toContain("ops.wait_warning_minutes");
    expect(hits).toContain("ops.wait_critical_minutes");
  });

  it("«صرف» تجمع العملتين", () => {
    const hits = keysFor("صرف");
    expect(hits).toContain("finance.rate.SAR");
    expect(hits).toContain("finance.rate.USD");
  });
});

describe("البحث يبقى دقيقًا", () => {
  it("بحثٌ فارغ يعيد كل التعريفات", () => {
    expect(searchDefinitions("")).toHaveLength(SETTING_DEFINITIONS.length);
    expect(searchDefinitions("   ")).toHaveLength(SETTING_DEFINITIONS.length);
  });

  it("كلمةٌ لا صلة لها لا تعيد شيئًا — لا كلَّ شيء", () => {
    expect(keysFor("زرافة")).toEqual([]);
  });

  it("المفتاح الداخليّ يبقى قابلًا للبحث لمن يعرفه", () => {
    expect(keysFor("ops.late_tolerance")).toContain("ops.late_tolerance_minutes");
  });

  it("المرادفات لا تُعرض للمالك — هي جسرُ بحثٍ لا نصُّ شاشة", () => {
    const late = SETTING_DEFINITIONS.find((d) => d.key === "ops.late_tolerance_minutes");
    expect(late?.keywords).toContain("تأخير");
    expect(late?.label).not.toContain("تأخير");
  });

  it("كل مرادفٍ مسجَّل يجد مفتاحه فعلًا — لا مرادفَ ميت", () => {
    for (const definition of SETTING_DEFINITIONS) {
      for (const keyword of definition.keywords ?? []) {
        expect(keysFor(keyword), `${definition.key} ← ${keyword}`).toContain(definition.key);
      }
    }
  });
});
