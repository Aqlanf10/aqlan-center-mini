import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { actorCanOverride, judgeBookingInDay, type BookingActor } from "@/lib/book-appointment";
import type { CapacityContext } from "@/lib/capacity-context";
import type { DbClient } from "@/lib/db";
import type { Appointment } from "@/lib/schedule";

/**
 * «الوكيل الذكي ليس مديرًا» — قرار المالك، وهذا الملف حارسه.
 *
 * كان للحجز بابان: شاشة المواعيد تستشير محرّك السعة وتقفل اليوم، والوكيل الذكي
 * يكتب في الجدول مباشرةً بلا سعةٍ ولا قفل. وبابٌ ثانٍ بلا حارس ليس ميزةً في
 * المساعد الذكي — هو بالضبط كيف يعود الازدحام بعد أن مُنع، ثم يُلام النظام على
 * جدولٍ لم يحرسه أحد.
 *
 * فما يُثبَت هنا ثلاثة: أن الطريق القديم لم يبقَ له مستدعٍ إنتاجيّ، وأن صلاحية
 * التجاوز تُقرأ من الإنسان الموثَّق لا من كون المتحدّث وكيلًا، وأن التجاوز يلزمه
 * سببٌ مكتوب مهما كانت الصلاحية.
 */

const ARABIC = /[؀-ۿ]/;
const root = fileURLToPath(new URL("..", import.meta.url));

/** اتصالٌ لا يُستعمل: الحكم في هذه الحالات لا يلمس القاعدة أصلًا. */
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

const DATE = "2026-10-05";

const booked = (over: Partial<Appointment> = {}): Appointment => ({
  id: 1, patientId: 1, patientName: "مريض", patientPhone: null,
  scheduledDate: DATE, scheduledTime: "10:00", durationMinutes: 60,
  note: null, status: "booked", ...over,
});

const actor = (over: Partial<BookingActor> = {}): BookingActor => ({
  username: "المساعد", role: "reception", channel: "ai", ...over,
});

/* يُجمَع كلُّ ما يُشحن — لا الاختبارات ولا مخرجات البناء. */
function productionFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) found.push(full);
    }
  };
  walk(join(root, "lib"));
  walk(join(root, "app"));
  walk(join(root, "components"));
  return found;
}

/**
 * الباب الخلفي مُغلق.
 *
 * `createAppointment` تكتب في الجدول بلا حكمٍ ولا قفل. بقاؤها مقبولٌ للاختبارات
 * التي تريد صفًّا جاهزًا؛ واستدعاؤها من مسارٍ إنتاجيّ يعيد الثغرة كما كانت. فالحدّ
 * هنا على المستدعي لا على الدالّة.
 */
describe("لا مستدعيَ إنتاجيًّا للكتابة المباشرة", () => {
  it("لا ملفَّ في lib أو app أو components يستدعي createAppointment", () => {
    const offenders = productionFiles().filter((file) => {
      const source = readFileSync(file, "utf8");
      /* التعريف نفسه في db.ts ليس استدعاءً، و`createAppointmentService` اسمٌ آخر. */
      return /(?<!function\s)\bcreateAppointment\s*\(/.test(source)
        && !file.endsWith(join("lib", "db.ts"));
    });
    expect(offenders.map((file) => file.slice(root.length))).toEqual([]);
  });

  it("وأداة حجز الوكيل الذكي تمرّ من bookAppointment", () => {
    const source = readFileSync(join(root, "lib", "ai-tools", "action-tools.ts"), "utf8");
    expect(source).toContain('from "../book-appointment"');
    expect(source).toContain("bookAppointment({");
    expect(source).not.toContain("createAppointment({");
  });

  it("وقناة الطلب تُسجَّل ولا تُمنح بها صلاحية", () => {
    const source = readFileSync(join(root, "lib", "ai-tools", "action-tools.ts"), "utf8");
    /* القناة توصيفٌ للتدقيق. ولو مُنحت بها صلاحيةٌ لصار «أنا وكيل» إذنًا. */
    expect(source).toContain('channel: "ai"');
    expect(source).toContain("canOverrideCapacity: context.permissions?.canOverrideCapacity === true");
  });
});

/**
 * الصلاحية تُقرأ من الإنسان لا من القناة.
 *
 * الوكيل يد، والإنسان الموثَّق هو الفاعل. فمُستقبِلةٌ لا تملك التجاوز لا تملكه
 * حين تطلبه بلسان الوكيل — وإلا صار المساعد الذكي طريقًا لترقية النفس.
 */
describe("الوكيل يحجز بصلاحيات من يحادثه", () => {
  it("قناة الوكيل وحدها لا تمنح تجاوزًا", () => {
    expect(actorCanOverride(actor({ channel: "ai" }))).toBe(false);
  });

  it("والمدير يملكه في كل قناة", () => {
    expect(actorCanOverride(actor({ role: "admin", channel: "ai" }))).toBe(true);
    expect(actorCanOverride(actor({ role: "admin", channel: "ui" }))).toBe(true);
  });

  it("وغير المدير يملكه بمنحٍ صريح لا بغيره", () => {
    expect(actorCanOverride(actor({ canOverrideCapacity: true }))).toBe(true);
    expect(actorCanOverride(actor({ canOverrideCapacity: false }))).toBe(false);
  });

  it("والدور المجهول لا يُعامَل مديرًا", () => {
    expect(actorCanOverride(actor({ role: null }))).toBe(false);
    expect(actorCanOverride(actor({ role: undefined }))).toBe(false);
    expect(actorCanOverride(actor({ role: "ai_assistant" }))).toBe(false);
  });
});

/**
 * الحكم واحدٌ لكل الأبواب.
 *
 * `judgeBookingInDay` هو ما يستدعيه الوكيل والاستقبال والزيارة التالية وبند
 * الخطّة. فما يُردّ به أحدُهم يُردّ به الباقون — بالحروف نفسها.
 */
describe("اليوم الممتلئ يُردّ فيه الجميع سواء", () => {
  const full = [booked()];

  it("بلا صلاحية: رفضٌ برسالةٍ عربية وبديلٍ محدَّد", async () => {
    const judged = await judgeBookingInDay({ patientId: null,
      sameDay: full, client: noClient, date: DATE, time: "10:00",
      durationMinutes: 30, service: null, context,
      canOverride: false, overrideReason: "",
    });
    expect(judged.ok).toBe(false);
    if (judged.ok) return;
    expect(judged.conflict.state).toBe("OVER_CAPACITY");
    expect(judged.conflict.message).toMatch(ARABIC);
    expect(judged.conflict.reasons.length).toBeGreaterThan(0);
    expect(judged.conflict.overrideHint).toContain("صلاحية");
    /* الحقيقة صريحةٌ في الحمولة: الشاشة لا تقرأ نثرًا لتعرف ما تعرض. */
    expect(judged.conflict.canOverride).toBe(false);
  });

  it("وبصلاحيةٍ بلا سبب: رفضٌ أيضًا — التجاوز موثَّق أو لا يكون", async () => {
    const judged = await judgeBookingInDay({ patientId: null,
      sameDay: full, client: noClient, date: DATE, time: "10:00",
      durationMinutes: 30, service: null, context,
      canOverride: true, overrideReason: "   ",
    });
    expect(judged.ok).toBe(false);
    if (judged.ok) return;
    /* الرسالة تفرّق: من يملك الصلاحية يُطلب منه سببٌ، لا يُقال له «ليست لك». */
    expect(judged.conflict.overrideHint).toContain("سبب");
    expect(judged.conflict.canOverride).toBe(true);
  });

  it("وبصلاحيةٍ وسبب: يمرّ، ويُعلَّم أنه تجاوز", async () => {
    const judged = await judgeBookingInDay({ patientId: null,
      sameDay: full, client: noClient, date: DATE, time: "10:00",
      durationMinutes: 30, service: null, context,
      canOverride: true, overrideReason: "ألم حادّ لا يحتمل التأجيل",
    });
    expect(judged.ok).toBe(true);
    if (!judged.ok) return;
    expect(judged.overridden).toBe(true);
    expect(judged.verdict.state).toBe("OVER_CAPACITY");
  });

  it("وسببٌ من حرفين لا يكفي — لا يُكتفى بضغطةٍ على المفتاح", async () => {
    const judged = await judgeBookingInDay({ patientId: null,
      sameDay: full, client: noClient, date: DATE, time: "10:00",
      durationMinutes: 30, service: null, context,
      canOverride: true, overrideReason: "أ",
    });
    expect(judged.ok).toBe(false);
  });

  it("والوقت المتاح يمرّ بلا تجاوزٍ ولا علامة", async () => {
    const judged = await judgeBookingInDay({ patientId: null,
      sameDay: [], client: noClient, date: DATE, time: "10:00",
      durationMinutes: 30, service: null, context,
      canOverride: false, overrideReason: "",
    });
    expect(judged.ok).toBe(true);
    if (!judged.ok) return;
    expect(judged.overridden).toBe(false);
  });
});

/**
 * أبواب الحجز الأربعة تستدعي الحكم نفسه.
 *
 * لو حكم بابٌ بقاعدته الخاصة لدخل منه ما مُنع من غيره. وهذا حارسٌ على الملفات
 * نفسها: من يضيف بابًا خامسًا يقرأ هذا البند فيعرف ما يلزمه.
 */
describe("كل باب حجزٍ يستشير المحرّك", () => {
  const doors = [
    join("app", "api", "appointments", "route.ts"),
    join("app", "api", "booking-requests", "[id]", "route.ts"),
    join("app", "api", "visits", "[id]", "next", "route.ts"),
    join("app", "api", "planned-visits", "[id]", "schedule", "route.ts"),
  ];

  for (const door of doors) {
    it(`${door} يمرّ من محرّك السعة لا من فحصٍ خاصّ به`, () => {
      const source = readFileSync(join(root, door), "utf8");
      expect(source).toMatch(/judgeBookingInDay|bookAppointment/);
      /* `checkSlot` هو الفحص الثنائيّ القديم: يقول «ممتلئ أو لا» ولا يعرف
         الفواصل ولا الورديات ولا احتياطي الطوارئ. لا يعود إلى مسار حجز. */
      expect(source).not.toContain("checkSlot(");
    });
  }
});
