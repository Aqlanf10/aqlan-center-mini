import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { vi } from "vitest";
import { judgeFullCapacity } from "@/lib/capacity";
import { judgeBookingInDay } from "@/lib/book-appointment";
import type { CapacityContext } from "@/lib/capacity-context";
import type { DbClient } from "@/lib/db";
import type { Appointment } from "@/lib/schedule";

/**
 * أربعة عيوبٍ كشفتها مراجعةٌ آليّة على البي آر — وحُرّاسها.
 *
 * كلُّها من عائلةٍ واحدة: **المحرّك يسأل عن حقيقةٍ لا يملكها فيفترضها**، أو مسارٌ
 * يعرف الحقيقة ويُهملها. ومثل هذا لا يُسقط اختبارًا ولا يرفع استثناءً — يعمل
 * النظام ويُعطي جوابًا خاطئًا بثقة، وهو أسوأ ما يقع في نظامٍ يُدار به مركز.
 *
 * فكلُّ بندٍ هنا كان **أحمر** قبل إصلاحه.
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const root = fileURLToPath(new URL("..", import.meta.url));
const DATE = "2026-11-08";

const noClient = {
  query: () => { throw new Error("لا يُنتظر استعلامٌ في هذا المسار."); },
} as unknown as DbClient;

const context: CapacityContext = {
  shifts: [{ start: "09:00", end: "13:00" }],
  chairs: 1,
  nearCapacityPercent: 80,
  emergencyReserveMinutes: 0,
  newPatientDailyLimit: 0,
};

const appt = (over: Partial<Appointment> = {}): Appointment => ({
  id: 1, patientId: 1, patientName: "مريض", patientPhone: null,
  scheduledDate: DATE, scheduledTime: "10:00", durationMinutes: 60,
  note: null, status: "booked", ...over,
});

const service = (over: Record<string, unknown> = {}) => ({
  requiresProvider: false, requiresChair: true, allowsConcurrentProviderWork: false,
  consumesEmergencyReserve: false, isActive: true, nameAr: "إجراء", ...over,
} as Parameters<typeof judgeFullCapacity>[0]["service"]);

const judge = (appointments: Appointment[], chairNo: number | null = null) =>
  judgeFullCapacity({
    appointments, date: DATE, time: "10:00", durationMinutes: 30,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, chairs: 1,
    shifts: context.shifts, nearCapacityPercent: 80, service: service(),
    chairNo,
  });

/**
 * (١) الكرسيّ الذي لا يجلس عليه أحد.
 *
 * كان عدُّ الكراسي المشغولة يعدّ **كلّ** موعدٍ متداخل بلا سؤالٍ عمّا إذا كانت
 * خدمته تشغل كرسيًّا أصلًا. فمركزٌ بكرسيٍّ واحد تُرفض فيه حشوةٌ حقيقية لأنّ
 * استشارةً هاتفية «تشغل» الكرسي — رفضُ مريضٍ حاضر من أجل مكالمة.
 */
describe("موعدٌ لا يشغل كرسيًّا لا يُعدّ في الكراسي", () => {
  it("استشارةٌ لا تشغل كرسيًّا لا تمنع حجزًا على الكرسيّ الوحيد", () => {
    const verdict = judge([appt({ occupiesChair: false })]);
    expect(verdict.occupiedChairs).toBe(0);
    expect(verdict.state).not.toBe("OVER_CAPACITY");
  });

  it("وموعدٌ يشغل كرسيًّا يمنعه — الحارس يفرّق ولا يُعطَّل", () => {
    const verdict = judge([appt({ occupiesChair: true })]);
    expect(verdict.occupiedChairs).toBe(1);
    expect(verdict.state).toBe("OVER_CAPACITY");
  });

  it("والموعد السابق لهذا العمود يُعدّ شاغلًا — كلُّ ما حُجز قبله كان يجلس فعلًا", () => {
    /* `occupiesChair` غائبةٌ تمامًا: صفٌّ كُتب قبل الهجرة. الافتراض الآمن أنه شاغل. */
    const verdict = judge([appt({})]);
    expect(verdict.occupiedChairs).toBe(1);
  });

  it("والكرسيّ الصريح لا يتصادم مع موعدٍ لا يشغل كرسيًّا", () => {
    const verdict = judge([appt({ occupiesChair: false, chairNo: 1 })], 1);
    expect(verdict.state).not.toBe("OVER_CAPACITY");
  });
});

/**
 * (٢) حدٌّ لا يمنع شيئًا.
 *
 * `scheduling.new_patient_daily_limit` كان يُقرأ من الإعدادات ويُمرَّر إلى
 * المحرّك، والمحرّك يقارنه بعددٍ **لا أحد يحسبه** — فيبقى صفرًا دائمًا. فمالكٌ
 * يضبط الحدّ على اثنين ويظنّ أنه ضبطه، ولا يُردّ أحد. وإعدادٌ يبدو فاعلًا وهو
 * معطَّل أسوأ من إعدادٍ غير موجود.
 */
describe("حدّ المرضى الجدد يمنع فعلًا", () => {
  const withLimit = { ...context, chairs: 10, newPatientDailyLimit: 2 };

  it("بلغ اليوم حدَّه: مريضٌ جديدٌ ثالث يُردّ", async () => {
    const judged = await judgeBookingInDay({
      sameDay: [
        appt({ id: 1, isNewPatient: true, scheduledTime: "09:00", durationMinutes: 15 }),
        appt({ id: 2, isNewPatient: true, scheduledTime: "09:30", durationMinutes: 15 }),
      ],
      client: noClient, date: DATE, time: "11:00", durationMinutes: 15,
      service: null, context: withLimit, isNewPatient: true,
      canOverride: false, overrideReason: "",
    });
    expect(judged.ok).toBe(false);
    if (judged.ok) return;
    expect(judged.conflict.reasons.join(" ")).toContain("المرضى الجدد");
  });

  it("ومريضٌ قديم يمرّ في اليوم نفسه — الحدّ على الجدد وحدهم", async () => {
    const judged = await judgeBookingInDay({
      sameDay: [
        appt({ id: 1, isNewPatient: true, scheduledTime: "09:00", durationMinutes: 15 }),
        appt({ id: 2, isNewPatient: true, scheduledTime: "09:30", durationMinutes: 15 }),
      ],
      client: noClient, date: DATE, time: "11:00", durationMinutes: 15,
      service: null, context: withLimit, isNewPatient: false,
      canOverride: false, overrideReason: "",
    });
    expect(judged.ok).toBe(true);
  });

  it("وصفرٌ يعني بلا حدّ — الافتراضيّ لا يمنع أحدًا", async () => {
    const judged = await judgeBookingInDay({
      sameDay: [
        appt({ id: 1, isNewPatient: true, scheduledTime: "09:00", durationMinutes: 15 }),
        appt({ id: 2, isNewPatient: true, scheduledTime: "09:30", durationMinutes: 15 }),
        appt({ id: 3, isNewPatient: true, scheduledTime: "10:30", durationMinutes: 15 }),
      ],
      client: noClient, date: DATE, time: "11:00", durationMinutes: 15,
      service: null, context: { ...context, chairs: 10 }, isNewPatient: true,
      canOverride: false, overrideReason: "",
    });
    expect(judged.ok).toBe(true);
  });

  it("وإعادةُ جدولة موعدٍ لا تعدّه ضدّ نفسه", async () => {
    const judged = await judgeBookingInDay({
      sameDay: [
        appt({ id: 1, isNewPatient: true, scheduledTime: "09:00", durationMinutes: 15 }),
        appt({ id: 2, isNewPatient: true, scheduledTime: "09:30", durationMinutes: 15 }),
      ],
      client: noClient, date: DATE, time: "11:00", durationMinutes: 15,
      service: null, context: withLimit, isNewPatient: true, excludeId: 2,
      canOverride: false, overrideReason: "",
    });
    expect(judged.ok).toBe(true);
  });
});

/**
 * (٣) تجاوزٌ لا يُسأل عنه أحد.
 *
 * ثلاثةٌ من أبواب الحجز الأربعة كانت تتلقّى `overridden: true` من الحكم ثم
 * تُهمله وتكتب. فمديرٌ يتجاوز طاقة اليوم من تأكيد طلب مريض لا يترك أثرًا —
 * والسجلّ يبدو نظيفًا، وهو أسوأ من تجاوزٍ ظاهر.
 */
describe("كلُّ بابٍ يسجّل تجاوزه", () => {
  const doors = [
    join("app", "api", "appointments", "route.ts"),
    join("app", "api", "booking-requests", "[id]", "route.ts"),
    join("app", "api", "visits", "[id]", "next", "route.ts"),
    join("app", "api", "planned-visits", "[id]", "schedule", "route.ts"),
  ];

  for (const door of doors) {
    it(`${door} يترك أثرًا للتجاوز`, () => {
      const source = readFileSync(join(root, door), "utf8");
      /* مسار المواعيد يسجّل عبر `bookAppointment`؛ والبقيّة تستدعي المسجِّل
         المشترك مباشرةً. وأيُّ بابٍ لا يفعل أيًّا منهما يتجاوز بلا أثر. */
      expect(source).toMatch(/recordCapacityOverride|bookAppointment\(/);
    });
  }

  it("والمسجِّل مشتركٌ لا منسوخ — نسخةٌ ثانية تنحرف عن الأولى", () => {
    const source = readFileSync(join(root, "lib", "book-appointment.ts"), "utf8");
    expect(source).toContain("export async function recordCapacityOverride");
    expect(source).toContain('action: "appointment.capacity_override"');
  });
});

/**
 * (٤) كتالوجٌ يُولد فارغًا.
 *
 * الجدول كان يُنشأ في الهجرة وفي `ensureSchema`، ولا يُبذَر في أيّ مسار إنتاجيّ:
 * `seedAppointmentServices` لم يكن لها مستدعٍ غير اختبار. فكلُّ قاعدةٍ جديدة
 * تُقلع بكتالوجٍ فارغ — شاشة الخدمات بلا شيء، والأنواع القديمة لا تجد ما تُحسم
 * إليه. بُني الكتالوج ولم يصل أحدًا.
 */
describe("الكتالوج يُبذَر مع المخطّط", () => {
  it("قاعدةٌ جديدة تُقلع بخدماتٍ حقيقية لا بجدولٍ فارغ", async () => {
    const { ensureSchema, listAppointmentServices, resetPoolForTesting } =
      await import("@/lib/db");
    await ensureSchema();
    const services = await listAppointmentServices({ includeInactive: true });
    expect(services.length).toBeGreaterThan(0);
    /* والجسر إلى الأنواع القديمة قائم: ما بُني قبل هذه المرحلة يبقى عاملًا. */
    expect(services.some((entry) => entry.legacyType === "consultation")).toBe(true);
    await resetPoolForTesting();
  }, 120_000);
});

afterAll(async () => {
  const { resetPoolForTesting } = await import("@/lib/db");
  await resetPoolForTesting().catch(() => {});
});
