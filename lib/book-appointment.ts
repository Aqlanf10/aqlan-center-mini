/**
 * حجز الموعد — الباب الوحيد.
 *
 * قبل هذه الوحدة كان للحجز بابان: شاشة المواعيد التي تستشير محرّك السعة وتقفل
 * اليوم، والوكيل الذكي الذي كان يكتب في الجدول مباشرةً بلا سعةٍ ولا قفل. وبابٌ
 * ثانٍ بلا حارس ليس ميزةً في المساعد الذكي — هو بالضبط كيف يعود الازدحام بعد أن
 * مُنع، ثم يُلام النظام على جدولٍ لم يحرسه أحد.
 *
 * فالقاعدة هنا واحدة: **الوكيل الذكي ليس مديرًا.** يحجز بصلاحيات الإنسان الموثَّق
 * الذي يحادثه، ويخضع لمحرّك السعة نفسه، وقفل اليوم نفسه، وسجلّ التدقيق نفسه.
 * وقناة الطلب (`channel`) تُسجَّل للتدقيق فقط — لا تغيّر قاعدةً واحدة.
 */
import { isAdmin } from "./roles";
import type { Role } from "./roles";
import {
  insertAppointmentOnClient, recordAudit, writeAppointmentInDay, type DbClient,
} from "./db";
import {
  evaluateCapacity, loadCapacityContext, resolveService, type CapacityContext,
} from "./capacity-context";
import type { CapacityVerdict } from "./capacity";
import { nextFreeTime, type Appointment } from "./schedule";
import {
  MAX_DURATION, MIN_DURATION, type AppointmentService,
} from "./appointment-services";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{1,2}:\d{2}$/;

/** من يحجز — إنسانٌ موثَّق دائمًا، ولو كانت يدُه وكيلًا ذكيًّا. */
export interface BookingActor {
  username: string;
  role: Role | string | null | undefined;
  /** جهة الطبيب حين يكون الفاعل طبيبًا — يُسجّل موعده على نفسه. */
  doctorPartyId?: number | null;
  /** صلاحية تجاوز السعة كما هي في المستخدم، لا كما تدّعيها القناة. */
  canOverrideCapacity?: boolean;
  /** كيف وصل الطلب — للتدقيق فقط. */
  channel: "ui" | "ai" | "portal" | "visit";
}

export interface BookAppointmentInput {
  patientId: number;
  date: string;
  time: string;
  /** تُترك فارغةً فتُؤخذ مدّة الخدمة الافتراضية — ولا تُفترض ٣٠ صامتةً. */
  durationMinutes?: number | null;
  serviceId?: number | null;
  appointmentType?: string | null;
  note?: string | null;
  doctorId?: number | null;
  /** كرسيٌّ بعينه، أو `null` = «لم يُخصَّص» — وهو يستهلك طاقةً عامة لا ينفيها. */
  chairNo?: number | null;
  overrideReason?: string | null;
  isNewPatient?: boolean;
  /**
   * صفُّ الانتظار الذي وَلَد هذا الموعد — يُكتب مع الموعد في المعاملة نفسها.
   *
   * فلا يوجد موعدٌ آتٍ من انتظارٍ بلا وسمٍ يدلّ على صفّه: إعادةُ المحاولة بعد
   * سقوطٍ في منتصف التحويل تجده فتربطه، ولا تكتب للمريض موعدًا ثانيًا.
   */
  waitingListId?: number | null;
}

export interface BookingConflict {
  message: string;
  state: CapacityVerdict["state"];
  reasons: string[];
  dayPercent: number;
  /**
   * هل يملك صاحب الجلسة التجاوز — حقيقةٌ صريحة لا تُستنتج من نصّ الرسالة.
   *
   * كانت الشاشة تقرّر إظهار حقل السبب بمطابقة كلمة «سبب» داخل `overrideHint`.
   * فتحريرُ الرسالة — وهي نصٌّ للعرض يُحرَّر — كان يُخفي الحقل عمّن يملك الصلاحية
   * بلا أن يكسر شيئًا ظاهرًا. والواجهة لا تُبنى على قراءة نثرٍ عربيّ.
   */
  canOverride: boolean;
  overrideHint: string;
  suggestion: string | null;
  suggestionMessage: string;
}

export type BookingResult =
  | {
      ok: true;
      appointment: Appointment;
      verdict: CapacityVerdict;
      overridden: boolean;
      /** تنبيهٌ لا خطأ — الحجز تمّ والمستخدم يُخبَر ليتأكّد قبل أن يَعِد المريض. */
      warning: string | null;
    }
  | { ok: false; status: 400; message: string }
  | { ok: false; status: 409; conflict: BookingConflict };

/** صلاحية التجاوز تُشتقّ من المستخدم لا من القناة — والوكيل الذكي قناة. */
export function actorCanOverride(actor: BookingActor): boolean {
  return isAdmin((actor.role ?? "") as Role) || actor.canOverrideCapacity === true;
}

/**
 * تسجيل تجاوز السعة — بابٌ واحد لكلّ الأبواب.
 *
 * «أي تجاوز يجب أن يسجل السبب والمستخدم والوقت في Audit Log» — خطّة المالك.
 * وكانت ثلاثة أبوابٍ من الأربعة تتجاوز بلا أثر: `judgeBookingInDay` يقول لها
 * `overridden: true` فتُهمله وتكتب. فتجاوزٌ لا يُسأل عنه أحد — وهو أسوأ من منعٍ
 * صريح، لأنّ السجلّ يبدو نظيفًا.
 *
 * ويُستدعى **بعد** نجاح الكتابة: تسجيلُ تجاوزٍ لحجزٍ لم يُكتب يزعم ما لم يحدث.
 */
export async function recordCapacityOverride(input: {
  appointmentId: number | string;
  verdict: CapacityVerdict;
  date: string;
  time: string;
  reason: string;
  serviceName?: string | null;
  actor: string;
  actorRole?: string | null;
  channel: BookingActor["channel"];
}): Promise<void> {
  await recordAudit({
    action: "appointment.capacity_override",
    entity: "appointment",
    entityId: String(input.appointmentId),
    actor: input.actor,
    actorRole: input.actorRole ?? null,
    details: {
      التاريخ: input.date,
      الوقت: input.time,
      الحالة: input.verdict.state,
      "امتلاء اليوم": `${input.verdict.dayPercent}٪`,
      "الكراسي المشغولة": `${input.verdict.occupiedChairs} من ${input.verdict.chairs}`,
      الخدمة: input.serviceName ?? "إجراء عام",
      القناة: input.channel,
      السبب: input.reason,
    },
  }).catch(() => {});
}

/**
 * الحكم داخل قفل اليوم — يستعمله كلُّ باب.
 *
 * الأبواب تختلف فيما تكتبه (موعدٌ جديد، أو طلبُ مريضٍ يُحوَّل، أو زيارةٌ تالية،
 * أو بندُ خطّةٍ يُجدوَل) ولا تختلف فيما تحكم به. فالكتابة تبقى لكلِّ بابٍ وحده،
 * والحكمُ واحد — وإلا صار لكلِّ بابٍ محرّكُ سعةٍ خاصّ به وعاد الازدحام من أوسعها.
 */
export async function judgeBookingInDay(input: {
  sameDay: Appointment[];
  client: DbClient;
  date: string;
  time: string;
  durationMinutes: number;
  service: AppointmentService | null;
  context: CapacityContext;
  providerId?: number | null;
  chairNo?: number | null;
  excludeId?: number;
  /** مريضٌ جديد — يُقارَن بحدّ اليوم إن ضبط المالك له رقمًا. */
  isNewPatient?: boolean;
  canOverride: boolean;
  overrideReason: string;
}): Promise<
  | { ok: true; verdict: CapacityVerdict; overridden: boolean }
  | { ok: false; verdict: CapacityVerdict; conflict: BookingConflict }
> {
  /* عددُ الجدد اليوم يُحسب من لقطات مواعيد اليوم نفسها.
     وكان الحدُّ يُقرأ من الإعدادات ويُمرَّر إلى المحرّك، والمحرّك يقارنه بصفرٍ
     دائمًا لأنّ أحدًا لا يحسب العدد — فحدٌّ لا يمنع شيئًا مهما ضُبط. */
  const newPatientsBookedToday = input.sameDay.filter(
    (appointment) => appointment.isNewPatient === true
      && appointment.id !== input.excludeId,
  ).length;

  const verdict = await evaluateCapacity({
    sameDay: input.sameDay, date: input.date, time: input.time,
    durationMinutes: input.durationMinutes, service: input.service,
    context: input.context, providerId: input.providerId ?? null,
    chairNo: input.chairNo ?? null, excludeId: input.excludeId,
    isNewPatient: input.isNewPatient ?? false, newPatientsBookedToday,
    client: input.client,
  });
  if (verdict.state !== "OVER_CAPACITY") return { ok: true, verdict, overridden: false };

  /* التجاوز حقٌّ موثَّق: صلاحيةٌ **وسبب**. وغيابُ أيّهما رفضٌ لا استثناء — وهذا
     يسري على الوكيل الذكي كما يسري على الاستقبال حرفًا بحرف. */
  if (input.canOverride && input.overrideReason.trim().length >= 3) {
    return { ok: true, verdict, overridden: true };
  }

  const suggestion = nextFreeTime(
    input.sameDay, input.date, input.time, input.durationMinutes, input.context.chairs,
  );
  return {
    ok: false,
    verdict,
    conflict: {
      message: verdict.message,
      state: verdict.state,
      reasons: verdict.reasons,
      dayPercent: verdict.dayPercent,
      canOverride: input.canOverride,
      overrideHint: input.canOverride
        ? "اكتب سبب التجاوز ليُسجَّل في سجلّ التدقيق."
        : "تجاوز السعة يحتاج صلاحيةً أعلى.",
      suggestion,
      suggestionMessage: suggestion
        ? `أقرب وقت متاح: ${suggestion}`
        : "لا يوجد وقت متاح في هذا اليوم.",
    },
  };
}

/**
 * الحجز.
 *
 * الترتيب مقصود: تُقرأ التهيئة والخدمة أولًا (خارج القفل، فلا يطول)، ثم يُقفل
 * اليوم، ثم يُحكم على مواعيده كما قرأها القفل نفسه، ثم يُكتب في المعاملة نفسها.
 */
export async function bookAppointment(
  input: BookAppointmentInput, actor: BookingActor,
): Promise<BookingResult> {
  const patientId = Number(input.patientId);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return { ok: false, status: 400, message: "اختر المريض أولًا." };
  }
  if (!DATE_PATTERN.test(input.date)) {
    return { ok: false, status: 400, message: "تاريخ غير صالح." };
  }
  if (!TIME_PATTERN.test(input.time)) {
    return { ok: false, status: 400, message: "وقت غير صالح." };
  }

  const context = await loadCapacityContext();
  const service = await resolveService({
    serviceId: input.serviceId ?? null,
    appointmentType: input.appointmentType ?? null,
  });

  /* المدّة: ما طلبه المستخدم، وإلا مدّة الخدمة، وإلا ثلاثون. والخدمة تُقترح ولا
     تفرض: قد يحتاج مريضٌ بعينه ضعف المدّة. */
  const requested = Number(input.durationMinutes);
  const durationMinutes = Number.isFinite(requested) && requested > 0
    ? Math.round(requested)
    : (service?.defaultDurationMinutes ?? 30);
  if (durationMinutes < MIN_DURATION || durationMinutes > MAX_DURATION) {
    return {
      ok: false, status: 400,
      message: `المدّة يجب أن تكون بين ${MIN_DURATION} و${MAX_DURATION} دقيقة.`,
    };
  }

  /* الكرسي الصريح يُقاس بعدد كراسي المركز من الإعدادات — لا برقمٍ ثابت. */
  const chairNo = input.chairNo == null || Number(input.chairNo) <= 0
    ? null : Math.round(Number(input.chairNo));
  if (chairNo !== null && chairNo > context.chairs) {
    return {
      ok: false, status: 400,
      message: `رقم الكرسي يجب أن يكون بين ١ و${context.chairs}.`,
    };
  }

  /* الطبيب يحجز لنفسه؛ وغيرُه يحدّد الطبيب صراحةً. */
  const doctorId = actor.role === "doctor" && typeof actor.doctorPartyId === "number"
    && actor.doctorPartyId > 0
    ? actor.doctorPartyId
    : (Number.isInteger(Number(input.doctorId)) && Number(input.doctorId) > 0
      ? Number(input.doctorId) : null);

  const canOverride = actorCanOverride(actor);
  const overrideReason = (input.overrideReason ?? "").trim().slice(0, 300);
  const state: { verdict: CapacityVerdict | null; overridden: boolean } =
    { verdict: null, overridden: false };

  const result = await writeAppointmentInDay({
    date: input.date,
    judge: async (sameDay, client) => {
      const judged = await judgeBookingInDay({
        sameDay, client, date: input.date, time: input.time, durationMinutes,
        service, context, providerId: doctorId, chairNo,
        isNewPatient: input.isNewPatient ?? false,
        canOverride, overrideReason,
      });
      state.verdict = judged.verdict;
      if (!judged.ok) return { ok: false as const, conflict: judged.conflict };
      state.overridden = judged.overridden;
      return { ok: true as const };
    },
    commit: (client) => insertAppointmentOnClient(client, {
      patientId,
      date: input.date,
      time: input.time,
      durationMinutes,
      appointmentType: input.appointmentType ?? service?.legacyType ?? null,
      note: input.note ? input.note.slice(0, 300) : null,
      doctorId,
      serviceId: service?.id ?? null,
      /* لقطةُ الفواصل تُكتب مع الموعد: تغييرُ الخدمة غدًا لا يعيد حساب ما حُجز. */
      bufferBeforeMinutes: service?.bufferBeforeMinutes ?? 0,
      bufferAfterMinutes: service?.bufferAfterMinutes ?? 0,
      chairNo,
      /* لقطتان يسألُ عنهما المحرّك لاحقًا: هل شغل هذا الموعد كرسيًّا، وهل كان
         صاحبه مريضًا جديدًا. وقراءتهما من الخدمة الحاضرة تُعيد رسم ما مضى. */
      occupiesChair: service ? service.requiresChair : true,
      isNewPatient: input.isNewPatient ?? false,
      waitingListId: input.waitingListId ?? null,
    }),
  });

  if (!result.ok) {
    return { ok: false, status: 409, conflict: result.conflict as BookingConflict };
  }
  const appointment = result.value;
  if (!appointment) {
    return { ok: false, status: 400, message: "تعذّر حجز الموعد. أعد المحاولة." };
  }

  const verdict = state.verdict;
  if (state.overridden && verdict) {
    await recordCapacityOverride({
      appointmentId: appointment.id, verdict, date: input.date, time: input.time,
      reason: overrideReason, serviceName: service?.nameAr,
      actor: actor.username, actorRole: (actor.role ?? null) as string | null,
      channel: actor.channel,
    });
  }

  return {
    ok: true,
    appointment,
    verdict: verdict ?? {
      state: "AVAILABLE", occupiedChairs: 0, chairs: context.chairs, dayPercent: 0,
      outsideHours: false, message: "متاح", reasons: [],
    },
    overridden: state.overridden,
    warning: verdict && verdict.outsideHours
      ? "هذا الوقت خارج ورديات المركز — تأكّد قبل أن تَعِد المريض."
      : (verdict && verdict.state === "NEAR_CAPACITY" ? verdict.message : null),
  };
}
