import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dayLoad, withinWorkingHours, checkSlot, type Appointment } from "@/lib/schedule";
import { judgeCapacity, overrideAccepted } from "@/lib/capacity";

/**
 * محرّك الطاقة — الحمل يُقاس بيوم المركز لا بيومٍ مفترض.
 *
 * كانت `dayLoad` تفترض ٠٩:٠٠–٢١:٠٠، ولم يكن أيُّ مستدعٍ يمرّر غيرهما. فمركزٌ مسائيّ
 * يعمل ١٦:٠٠–٢٢:٠٠ يرى حمله **نصف حقيقته**. وفي نظامٍ بُني لحلّ الزحمة، الرقم الذي
 * يقول «اليوم نصف فارغ» وهو ممتلئ ليس رقمًا خاطئًا — هو يومٌ منهار.
 */

const DATE = "2026-09-20";
const appt = (over: Partial<Appointment>): Appointment => ({
  id: 1, patientId: 1, patientName: "مريض", patientPhone: null,
  scheduledDate: DATE, scheduledTime: "16:00", durationMinutes: 60,
  note: null, status: "booked", ...over,
});

describe("الحمل يتبع ساعات المركز", () => {
  it("مركزٌ مسائيّ ٦ ساعات: الطاقة ٧٢٠ دقيقة بكرسيين لا ١٤٤٠", () => {
    const load = dayLoad([appt({})], DATE, 2, "16:00", "22:00");
    expect(load.capacityMinutes).toBe(720);
    expect(load.percent).toBe(8);
  });

  it("ويومٌ أطول يعطي نسبةً أقلّ للحمل نفسه", () => {
    const long = dayLoad([appt({})], DATE, 2, "09:00", "21:00");
    const short = dayLoad([appt({})], DATE, 2, "16:00", "22:00");
    expect(long.bookedMinutes).toBe(short.bookedMinutes);
    expect(long.percent).toBeLessThan(short.percent);
  });

  it("والكراسي تضاعف الطاقة لا الحمل", () => {
    expect(dayLoad([appt({})], DATE, 4, "16:00", "22:00").capacityMinutes).toBe(1440);
    expect(dayLoad([appt({})], DATE, 1, "16:00", "22:00").capacityMinutes).toBe(360);
  });

  it("والملغى ومن لم يحضر لا يشغلان كرسيًا", () => {
    const load = dayLoad([
      appt({ id: 1 }),
      appt({ id: 2, status: "cancelled" }),
      appt({ id: 3, status: "no_show" }),
    ], DATE, 2, "16:00", "22:00");
    expect(load.booked).toBe(1);
    expect(load.bookedMinutes).toBe(60);
  });

  it("ويومٌ مقلوب أو فارغ لا يقسم على صفرٍ ولا يعطي نسبةً خرافية", () => {
    const inverted = dayLoad([appt({})], DATE, 2, "22:00", "16:00");
    expect(inverted.capacityMinutes).toBe(0);
    expect(inverted.percent).toBe(0);
  });
});

describe("الفخّ لا يعود", () => {
  it("لا قيمةَ افتراضية لساعات الدوام في توقيع الدالّة", () => {
    /* الافتراض هو ما أخفى العيب سنةً: مستدعٍ ينسى فيحصل على يومٍ لم يُهيِّئه أحد
       بلا أن يشتكي المُصرِّف. فالتوقيع نفسه هو الحارس — وهذا ما يفحصه هذا البند. */
    const source = readFileSync(
      fileURLToPath(new URL("../lib/schedule.ts", import.meta.url)), "utf8",
    );
    const signature = source.slice(source.indexOf("export function dayLoad("));
    const params = signature.slice(0, signature.indexOf("): DayLoad"));
    expect(params).toContain("dayStartTime: string");
    expect(params).toContain("dayEndTime: string");
    expect(params).not.toMatch(/dayStartTime\s*=/);
    expect(params).not.toMatch(/dayEndTime\s*=/);
    expect(params).not.toContain("09:00");
    expect(params).not.toContain("21:00");
  });
});

describe("خارج الدوام — تنبيهٌ لا منع", () => {
  const hours = { start: "16:00", end: "22:00" };

  it("الموعد داخل الدوام سليم", () => {
    expect(withinWorkingHours("16:00", 60, hours)).toBe(true);
    expect(withinWorkingHours("21:00", 60, hours)).toBe(true);
  });

  it("والاعتبار بنهايته لا ببدايته", () => {
    /* موعدٌ يبدأ ٢١:٤٥ ومدّته ساعة ينتهي بعد الإغلاق — طبيبٌ يبقى وحده مع مريض. */
    expect(withinWorkingHours("21:45", 60, hours)).toBe(false);
    expect(withinWorkingHours("21:45", 15, hours)).toBe(true);
  });

  it("وما قبل الفتح خارجٌ أيضًا", () => {
    expect(withinWorkingHours("09:00", 30, hours)).toBe(false);
  });

  it("وساعاتٌ فاسدة أو مقلوبة لا تمنع شيئًا — لا يُعطَّل الحجز بإعدادٍ خاطئ", () => {
    expect(withinWorkingHours("03:00", 30, { start: "", end: "" })).toBe(true);
    expect(withinWorkingHours("03:00", 30, { start: "22:00", end: "16:00" })).toBe(true);
  });

  it("والحجز خارج الدوام **يمرّ** ويُوسم — الطوارئ تقع ليلًا", () => {
    const verdict = checkSlot([], DATE, "23:00", 30, 2, undefined, hours);
    expect(verdict.allowed).toBe(true);
    expect(verdict.outsideHours).toBe(true);
  });

  it("وبلا ساعاتٍ ممرَّرة لا وسمَ ولا تغييرَ في السلوك القائم", () => {
    const verdict = checkSlot([], DATE, "23:00", 30, 2);
    expect(verdict.allowed).toBe(true);
    expect(verdict.outsideHours).toBe(false);
  });

  it("وامتلاء الكراسي يبقى منعًا لا تنبيهًا", () => {
    const full = checkSlot(
      [appt({ id: 1, scheduledTime: "16:00" }), appt({ id: 2, scheduledTime: "16:00" })],
      DATE, "16:30", 30, 2, undefined, hours,
    );
    expect(full.allowed).toBe(false);
    expect(full.reason).toContain("الكراسي ممتلئة");
  });
});

describe("محرّك السعة — ثلاث حالاتٍ لا اثنتان", () => {
  const hours = { start: "16:00", end: "22:00" };
  const base = {
    date: DATE, time: "18:00", durationMinutes: 30, chairs: 2,
    hours, nearCapacityPercent: 80,
  };

  it("يومٌ فارغ: متاح", () => {
    const verdict = judgeCapacity({ ...base, appointments: [] });
    expect(verdict.state).toBe("AVAILABLE");
    expect(verdict.reasons).toEqual([]);
  });

  it("امتلاء الكراسي في اللحظة: تجاوز", () => {
    const verdict = judgeCapacity({
      ...base,
      appointments: [
        appt({ id: 1, scheduledTime: "18:00", durationMinutes: 60 }),
        appt({ id: 2, scheduledTime: "18:00", durationMinutes: 60 }),
      ],
    });
    expect(verdict.state).toBe("OVER_CAPACITY");
    expect(verdict.message).toContain("الكراسي ممتلئة");
  });

  it("آخر كرسيٍّ متاح: اقترابٌ لا منع", () => {
    const verdict = judgeCapacity({
      ...base,
      appointments: [appt({ id: 1, scheduledTime: "18:00", durationMinutes: 60 })],
    });
    expect(verdict.state).toBe("NEAR_CAPACITY");
    expect(verdict.reasons.join(" ")).toContain("آخر كرسيٍّ");
  });

  it("بلوغ عتبة اليوم يُحذَّر منه قبل الوعد", () => {
    /* ٦ ساعات × كرسيين = ٧٢٠ دقيقة. ٦٠٠ محجوزة + ٣٠ = ٨٧٪ ≥ ٨٠٪. */
    const verdict = judgeCapacity({
      ...base,
      appointments: [
        appt({ id: 1, scheduledTime: "16:00", durationMinutes: 300 }),
        appt({ id: 2, scheduledTime: "16:00", durationMinutes: 300 }),
      ],
      time: "21:30",
    });
    expect(verdict.state).toBe("NEAR_CAPACITY");
    expect(verdict.dayPercent).toBeGreaterThanOrEqual(80);
  });

  it("والعتبة تُقرأ من الإعداد لا من رقمٍ ثابت", () => {
    const crowded = [
      appt({ id: 1, scheduledTime: "16:00", durationMinutes: 240 }),
      appt({ id: 2, scheduledTime: "16:00", durationMinutes: 240 }),
    ];
    const lenient = judgeCapacity({ ...base, appointments: crowded, time: "20:30", nearCapacityPercent: 95 });
    const strict = judgeCapacity({ ...base, appointments: crowded, time: "20:30", nearCapacityPercent: 50 });
    expect(lenient.state).toBe("AVAILABLE");
    expect(strict.state).toBe("NEAR_CAPACITY");
  });

  it("تجاوز طاقة اليوم كلّه منعٌ ولو كان الكرسي فارغًا في تلك اللحظة", () => {
    const verdict = judgeCapacity({
      ...base, chairs: 1, time: "21:30", durationMinutes: 60,
      appointments: [appt({ id: 1, scheduledTime: "16:00", durationMinutes: 350 })],
    });
    expect(verdict.state).toBe("OVER_CAPACITY");
    expect(verdict.message).toContain("طاقة اليوم");
  });

  it("والموعد المُعاد جدولته لا يزاحم نفسه", () => {
    const existing = [
      appt({ id: 7, scheduledTime: "18:00", durationMinutes: 60 }),
      appt({ id: 8, scheduledTime: "18:00", durationMinutes: 60 }),
    ];
    expect(judgeCapacity({ ...base, appointments: existing }).state).toBe("OVER_CAPACITY");
    expect(judgeCapacity({ ...base, appointments: existing, excludeId: 7 }).state)
      .toBe("NEAR_CAPACITY");
  });

  it("والملغى لا يشغل كرسيًا", () => {
    const verdict = judgeCapacity({
      ...base,
      appointments: [
        appt({ id: 1, scheduledTime: "18:00", durationMinutes: 60, status: "cancelled" }),
        appt({ id: 2, scheduledTime: "18:00", durationMinutes: 60, status: "no_show" }),
      ],
    });
    expect(verdict.state).toBe("AVAILABLE");
  });

  it("وساعاتٌ فاسدة لا تُحوّل كل حجزٍ إلى تجاوز", () => {
    const verdict = judgeCapacity({
      ...base, hours: { start: "", end: "" }, appointments: [],
    });
    expect(verdict.state).toBe("AVAILABLE");
    expect(verdict.dayPercent).toBe(0);
  });
});

describe("التجاوز — بصلاحيةٍ وسببٍ موثَّق", () => {
  it("بلا صلاحية لا يمرّ ولو كتب سببًا", () => {
    const result = overrideAccepted({ canOverride: false, reason: "حالة طارئة" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("صلاحيةً أعلى");
  });

  it("وبالصلاحية بلا سببٍ لا يمرّ — تجاوزٌ بلا سبب سجلٌّ بلا فائدة", () => {
    for (const reason of [null, undefined, "", "  ", "أب"]) {
      expect(overrideAccepted({ canOverride: true, reason }).ok, String(reason)).toBe(false);
    }
  });

  it("وبالاثنين معًا يمرّ", () => {
    expect(overrideAccepted({ canOverride: true, reason: "حالة طارئة — ألم حاد" }).ok).toBe(true);
  });
});
