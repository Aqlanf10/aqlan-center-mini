import { describe, expect, it } from "vitest";
import { CLINIC_ZONE_FALLBACK, clinicDayStart } from "@/lib/clinicZone";

/**
 * بدايةُ اليوم بتوقيت المركز — الدالّة التي أغلقت إزاحةَ ثلاث ساعات.
 *
 * الفحصُ يقارن باللحظة المطلقة لا بنصٍّ محلّيّ، فيبقى صحيحًا مهما كان توقيت
 * العملية التي تشغّله — وهذا هو المقصود: العطبُ الأصليّ كان يختفي على جهازٍ
 * توقيتُه يطابق المركز ويظهر على الخادم.
 */
describe("بداية يوم المركز", () => {
  it("منتصفُ ليل تعز هو ٢١:٠٠ من اليوم السابق بتوقيت UTC", () => {
    const start = clinicDayStart("2026-10-05", CLINIC_ZONE_FALLBACK);
    expect(start.toISOString()).toBe("2026-10-04T21:00:00.000Z");
  });

  it("ولا تتبع توقيت العملية: UTC يعطي منتصف الليل نفسه", () => {
    expect(clinicDayStart("2026-10-05", "UTC").toISOString())
      .toBe("2026-10-05T00:00:00.000Z");
  });

  /* منطقةٌ ذات توقيتٍ صيفيّ على يومَي التحوّل — الخطوتان في الحساب لهذا. */
  it("تصحّ على حدود التوقيت الصيفيّ", () => {
    /* لندن: ٢٩ مارس ٢٠٢٦ يبدأ بـUTC ثمّ يتقدّم الساعة داخل اليوم. */
    expect(clinicDayStart("2026-03-29", "Europe/London").toISOString())
      .toBe("2026-03-29T00:00:00.000Z");
    /* وفي الصيف يبدأ اليوم قبل منتصف ليل UTC بساعة. */
    expect(clinicDayStart("2026-07-15", "Europe/London").toISOString())
      .toBe("2026-07-14T23:00:00.000Z");
  });

  it("وتاريخٌ غير مقروء يعيد لحظةً غير صالحة لا لحظةً خاطئة", () => {
    expect(Number.isNaN(clinicDayStart("ليس تاريخًا", CLINIC_ZONE_FALLBACK).getTime()))
      .toBe(true);
  });
});
