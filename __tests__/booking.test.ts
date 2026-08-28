import { describe, expect, it } from "vitest";
import { confirmationText, validateBookingRequest } from "../lib/booking";
import { addDays, clinicDateString } from "../lib/schedule";

const TODAY = "2026-08-27";

const good = {
  fullName: "عبدالله محمد سالم",
  phone: "770245745",
  reason: "متابعة تقويم",
  preferredDate: "2026-08-30",
  preferredPeriod: "evening",
};

describe("تاريخ العيادة", () => {
  it("يقرأ اليوم بتوقيت تعز لا بتوقيت الخادم", () => {
    // 21:30 بتوقيت غرينتش = 00:30 من اليوم التالي في تعز. الخادم يعمل بـUTC، وحسابُ
    // «اليوم» منه كان سيرفض طلب مريض لموعد الغد بحجة أنه تاريخ ماضٍ.
    const night = new Date("2026-08-27T21:30:00.000Z");
    expect(clinicDateString(night, "Asia/Aden")).toBe("2026-08-28");
    expect(clinicDateString(night, "UTC")).toBe("2026-08-27");
  });

  it("يضيف الأيام عبر حدود الشهر", () => {
    expect(addDays("2026-08-30", 3)).toBe("2026-09-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("التحقق من طلب الحجز", () => {
  it("يقبل طلبًا سليمًا ويوحّد الرقم لصيغة واتساب", () => {
    const result = validateBookingRequest(good, TODAY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.phone).toBe("967770245745");
    expect(result.value.preferredPeriod).toBe("evening");
  });

  it("يقبل الأرقام العربية الهندية كما تكتبها لوحات مفاتيح الهواتف", () => {
    const result = validateBookingRequest({ ...good, phone: "٧٧٠٢٤٥٧٤٥" }, TODAY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.phone).toBe("967770245745");
  });

  it("يرفض رقمًا لا يصلح للاتصال — وهو الحقل الحاسم", () => {
    // طلب برقم خاطئ لا يمكن تأكيده أصلًا فيبقى في القائمة إلى الأبد. الرفض هنا
    // بينما المريض أمام الشاشة، لا بعد يومين حين تحاول الاستقبال الاتصال.
    for (const phone of ["123", "0123456789", "", "٧٧٠"]) {
      const result = validateBookingRequest({ ...good, phone }, TODAY);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("جوال");
    }
  });

  it("يرفض اسمًا بلا حروف أو أقصر من ثلاثة", () => {
    expect(validateBookingRequest({ ...good, fullName: "12345" }, TODAY).ok).toBe(false);
    expect(validateBookingRequest({ ...good, fullName: "عب" }, TODAY).ok).toBe(false);
  });

  it("يرفض يومًا مضى أو أبعد من شهرين", () => {
    expect(validateBookingRequest({ ...good, preferredDate: "2026-08-26" }, TODAY).ok).toBe(false);
    expect(validateBookingRequest({ ...good, preferredDate: "2026-12-01" }, TODAY).ok).toBe(false);
    // اليوم نفسه مقبول: من يطلب موعدًا اليوم هو الأكثر استعجالًا.
    expect(validateBookingRequest({ ...good, preferredDate: TODAY }, TODAY).ok).toBe(true);
  });

  it("يقبل بلا يوم مفضل ويجعل الفترة «أي وقت» عند غياب اختيار صالح", () => {
    const result = validateBookingRequest(
      { fullName: "فاطمة علي", phone: "0771234567", preferredPeriod: "لا شيء" },
      TODAY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.preferredDate).toBeNull();
    expect(result.value.preferredPeriod).toBe("any");
    expect(result.value.reason).toBeNull();
  });

  it("يقصّ سبب الزيارة الطويل بدل رفض الطلب", () => {
    const result = validateBookingRequest({ ...good, reason: "ألم ".repeat(200) }, TODAY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.reason!.length).toBeLessThanOrEqual(200);
  });
});

describe("نص التأكيد", () => {
  it("يحمل الاسم والوقت واسم المركز", () => {
    const text = confirmationText({
      patientName: "عبدالله",
      whenText: "الأحد 30/08 الساعة 5:00 مساءً",
      clinicName: "مركز الدكتور عقلان الكامل",
      clinicPhone: "04-253028",
    });
    expect(text).toContain("عبدالله");
    expect(text).toContain("الأحد 30/08");
    expect(text).toContain("04-253028");
  });
});
