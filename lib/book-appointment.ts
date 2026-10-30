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
import { readReturnBookingContext, type ReturnBookingSource } from "./return-booking-context";
import { nearbyPatientBookingWarning, type NearbyPatientAppointment } from "./nearby-patient-booking";
import { isAdmin } from "./roles";
import { FOLLOWUP_SERVICE_REVIEW_MESSAGE, isPeriodicFollowupService } from "./ortho-booking-intent";
import { APPOINTMENT_DOCTOR_UNAVAILABLE_MESSAGE, lockBookableAppointmentDoctor } from "./appointment-doctor";
import type { Role } from "./roles";
import {
  getAppointment, getAppointmentWith, insertAppointmentOnClient, lockAppointmentServiceForBooking, moveAppointmentOnClient, recordAudit,
  writeAppointmentAcrossDays, writeAppointmentInDay, type AuditInput, type DbClient,
} from "./db";
import {
  prepareCapacityEvaluator, loadCapacityContext, resolveService, type CapacityContext,
} from "./capacity-context";
import { usableShifts, type CapacityVerdict } from "./capacity";
import type { Appointment } from "./schedule";
import {
  MAX_DURATION, MIN_DURATION, type AppointmentService,
} from "./appointment-services";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{1,2}:\d{2}$/;

function bookingProposalScope(kind: string, input: object): string {
  return JSON.stringify([kind, Object.fromEntries(Object.entries(input)
    .filter(([key]) => key !== "nearbyAppointmentConfirmation")
    .sort(([a], [b]) => a.localeCompare(b)))]);
}

/** من يحجز — إنسانٌ موثَّق دائمًا، ولو كانت يدُه وكيلًا ذكيًّا. */
export interface BookingActor {
  username: string;
  userId?: number;
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
  /** Restricts the untouched board proposal; never grants extra booking authority. */
  bookingIntent?: "ortho_follow_up" | null;
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
  nearbyAppointmentConfirmation?: string | null;
  /** Exact clinical origin; responsibility is resolved on the server, not picked. */
  returnBookingSource?: ReturnBookingSource | null;
  returnBookingOrigin?: ReturnBookingSource | null;
  returnBookingFingerprint?: string | null;
}

export interface BookingConflict {
  kind?: "nearby_patient_appointments";
  nearbyAppointments?: NearbyPatientAppointment[];
  confirmationToken?: string;
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
  | { ok: false; status: 400; message: string; code?: string }
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
}, audit?: (input: AuditInput) => Promise<void>): Promise<void> {
  // The canonical path passes its transaction's audit writer: the row is atomic with
  // the booking. The legacy path keeps its best-effort write after the commit.
  const row: AuditInput = {
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
  };
  if (audit) await audit(row);
  else await recordAudit(row).catch(() => {});
}

function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(total: number): string {
  const hours = Math.floor(total / 60) % 24;
  return `${String(hours).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** الحالات التي لا تشغل وقت المريض: الملغى ومن لم يحضر. */
const INACTIVE_FOR_OVERLAP = new Set(["cancelled", "no_show"]);

/**
 * (P2-3) موعدٌ قائم للمريض نفسه يتداخل مع [الوقت، الوقت + المدة) — أو null.
 * التداخل بالمدّة لا بالبداية فقط: ١٠:٠٠ لساعةٍ يمنع ١٠:٣٠، ويسمح بـ١١:٠٠.
 */
export function patientOverlap(
  sameDay: readonly Appointment[],
  patientId: number,
  time: string,
  durationMinutes: number,
  excludeId?: number,
): Appointment | null {
  const start = timeToMinutes(time);
  const end = start + durationMinutes;
  for (const appointment of sameDay) {
    if (appointment.patientId !== patientId || appointment.id === excludeId) continue;
    if (INACTIVE_FOR_OVERLAP.has(appointment.status)) continue;
    const otherStart = timeToMinutes(appointment.scheduledTime);
    const otherEnd = otherStart + Math.max(1, appointment.durationMinutes);
    if (start < otherEnd && otherStart < end) return appointment;
  }
  return null;
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
  requireAssignedProvider?: boolean;
  chairNo?: number | null;
  excludeId?: number;
  /** مريضٌ جديد — يُقارَن بحدّ اليوم إن ضبط المالك له رقمًا. */
  isNewPatient?: boolean;
  /**
   * (P2-3) صاحب الموعد — لا يُحجز المريض نفسه في وقتين متداخلين. `null` حين لا ملف
   * بعد (طلب حجزٍ لمريضٍ لم يُسجَّل). مطلوبٌ صراحةً في كل باب كي لا ينساه بابٌ جديد.
   */
  patientId: number | null;
  canOverride: boolean;
  overrideReason: string;
  nearbyAppointmentConfirmation?: string | null;
  bookingActor?: string;
  bookingScope?: string;
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

  const evaluateAt = await prepareCapacityEvaluator({
    sameDay: input.sameDay, date: input.date, time: input.time,
    durationMinutes: input.durationMinutes, service: input.service,
    context: input.context, providerId: input.providerId ?? null,
    requireAssignedProvider: input.requireAssignedProvider,
    chairNo: input.chairNo ?? null, excludeId: input.excludeId,
    isNewPatient: input.isNewPatient ?? false, newPatientsBookedToday,
    client: input.client,
  });
  const verdict = evaluateAt(input.time);
  /* (P2-3) المريض لا يكون على كرسيّين في وقتٍ واحد — وهذا ليس «سعة» تُتجاوز بسبب:
     الموعد الثاني خطأ حجزٍ دائمًا، فيُرفض لكل الأدوار ويُعرض الموعد القائم. */
  const clash = input.patientId === null ? null : patientOverlap(
    input.sameDay, input.patientId, input.time, input.durationMinutes, input.excludeId,
  );
  if (clash) {
    const end = minutesToTime(timeToMinutes(clash.scheduledTime) + clash.durationMinutes);
    const message = `المريض محجوزٌ في هذا الوقت: موعدٌ ${clash.scheduledTime}–${end}`
      + `${clash.doctorName ? ` مع ${clash.doctorName}` : ""}. انقل الموعد القائم أو اختر وقتًا آخر.`;
    return {
      ok: false,
      verdict,
      conflict: {
        message,
        state: "OVER_CAPACITY",
        reasons: [message],
        dayPercent: verdict.dayPercent,
        canOverride: false,
        overrideHint: "لا يُتجاوز: المريض نفسه لا يُحجز مرتين في الوقت نفسه.",
        suggestion: null,
        suggestionMessage: "اختر وقتًا لا يتداخل مع موعد المريض القائم.",
      },
    };
  }

  // Acknowledgement is never a capacity or overlap override. Only ask after
  // those existing guards admit this proposal, and re-read on every attempt.
  if (input.patientId !== null && (verdict.state !== "OVER_CAPACITY"
    || (input.canOverride && input.overrideReason.trim().length >= 3))) {
    const warning = await nearbyPatientBookingWarning(input.client, {
      actor: input.bookingActor ?? "", scope: input.bookingScope ?? "booking",
      patientId: input.patientId, date: input.date, time: input.time,
      durationMinutes: input.durationMinutes, serviceId: input.service?.id ?? null,
      doctorId: input.providerId ?? null, chairNo: input.chairNo ?? null,
      excludeId: input.excludeId ?? null,
    }, input.nearbyAppointmentConfirmation);
    if (warning) {
      const message = "للمريض موعد قائم في يوم الحجز المقترح أو خلال اليومين التاليين. هل الموعد الإضافي مقصود؟";
      return { ok: false, verdict, conflict: {
        ...warning, message, state: verdict.state, reasons: [message],
        dayPercent: verdict.dayPercent, canOverride: false,
        overrideHint: "ألغِ المحاولة أو أكّد أن الموعد الإضافي مقصود.",
        suggestion: null, suggestionMessage: "",
      } };
    }
  }
  if (verdict.state !== "OVER_CAPACITY") return { ok: true, verdict, overridden: false };

  /* التجاوز حقٌّ موثَّق: صلاحيةٌ **وسبب**. وغيابُ أيّهما رفضٌ لا استثناء — وهذا
     يسري على الوكيل الذكي كما يسري على الاستقبال حرفًا بحرف. */
  if (input.canOverride && input.overrideReason.trim().length >= 3) {
    return { ok: true, verdict, overridden: true };
  }

  // Use the exact admission policy and one verified provider-block snapshot.
  // Never offer the rejected slot, an out-of-shift slot or a patient collision.
  // Minute precision preserves the earliest valid boundary for arbitrary buffers.
  let suggestion: string | null = null;
  const shifts = usableShifts(input.context.shifts);
  const from = timeToMinutes(input.time) + 1;
  const closing = Math.min(1440, Math.max(0, ...shifts.map(shift => shift.end)));
  for (let minute = from; minute < closing; minute++) {
    if (!shifts.some(shift => minute >= shift.start && minute < shift.end)) continue;
    const time = minutesToTime(minute);
    if (input.patientId !== null && patientOverlap(
      input.sameDay, input.patientId, time, input.durationMinutes, input.excludeId,
    )) continue;
    const candidate = evaluateAt(time);
    if (candidate.state !== "OVER_CAPACITY" && !candidate.outsideHours) {
      suggestion = time;
      break;
    }
  }
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
        : "لم يُعثر على وقت بديل مناسب ضمن الدوام؛ اختر يومًا آخر.",
    },
  };
}

/**
 * الحجز.
 *
 * الترتيب مقصود: تُقرأ التهيئة والخدمة أولًا (خارج القفل، فلا يطول)، ثم يُقفل
 * اليوم، ثم يُحكم على مواعيده كما قرأها القفل نفسه، ثم يُكتب في المعاملة نفسها.
 * لمقترح متابعة التقويم المحميّ تُقرأ الخدمة ثانيةً تحت قفل صفّ يبقى حتى نهاية المعاملة.
 */
export async function bookAppointment(
  input: BookAppointmentInput, actor: BookingActor,
  /** The canonical path (M2 slice 16): its admitted transaction, and an atomic audit
   * writer on it for the capacity override. Without them, as before: the engine owns
   * its transaction and the override audit is written after the commit.
   * assertAssignment sees the resolved clinician under the day/doctor locks,
   * before insertion; it cannot authorize itself through the new appointment. */
  options: { client?: DbClient; audit?: (input: AuditInput) => Promise<void>; assertAssignment?: (patientId: number, doctorId: number | null) => Promise<void> } = {},
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
  let service = await resolveService({
    serviceId: input.serviceId ?? null,
    appointmentType: input.appointmentType ?? null,
  });
  // Fast rejection only. The transaction below must re-read and lock the row
  // before trusting identity or metadata; this preflight object may become stale.
  if (input.bookingIntent === "ortho_follow_up"
    && (!input.serviceId || input.appointmentType !== "follow_up"
      || service?.id !== input.serviceId || !isPeriodicFollowupService(service))) {
    return { ok: false, status: 400, message: FOLLOWUP_SERVICE_REVIEW_MESSAGE };
  }


  const isReturnBooking = input.appointmentType === "follow_up"
    || service?.legacyType === "follow_up" || input.returnBookingSource != null || input.returnBookingOrigin != null;
  if (isReturnBooking && (!input.returnBookingSource
    || typeof input.returnBookingFingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(input.returnBookingFingerprint))) {
    return { ok: false, status: 400, message: "اختر سياق العودة وتحقّق من الطبيب المسؤول الحالي قبل الحجز.", code: "return_booking_context_required" };
  }

  /* المدّة: ما طلبه المستخدم، وإلا مدّة الخدمة، وإلا ثلاثون. والخدمة تُقترح ولا
     تفرض: قد يحتاج مريضٌ بعينه ضعف المدّة. */
  const requested = Number(input.durationMinutes);
  let durationMinutes = Number.isFinite(requested) && requested > 0
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
  let doctorId = actor.role === "doctor" && typeof actor.doctorPartyId === "number"
    && actor.doctorPartyId > 0
    ? actor.doctorPartyId
    : (Number.isInteger(Number(input.doctorId)) && Number(input.doctorId) > 0
      ? Number(input.doctorId) : null);

  const canOverride = actorCanOverride(actor);
  const overrideReason = (input.overrideReason ?? "").trim().slice(0, 300);
  const state: {
    verdict: CapacityVerdict | null; overridden: boolean;
    followupServiceRejected: boolean; doctorRejected: boolean; returnRejected: { message: string; code: string } | null;
  } = { verdict: null, overridden: false, followupServiceRejected: false, doctorRejected: false, returnRejected: null };

  const result = await writeAppointmentInDay({
    date: input.date,
    client: options.client,
    judge: async (sameDay, client) => {
      if (input.bookingIntent === "ortho_follow_up") {
        // Existing order: day advisory lock, then this service row. The row lock
        // lasts through capacity, insertion and owner commit/rollback, so a
        // concurrent catalogue editor cannot invalidate an accepted proposal.
        service = await lockAppointmentServiceForBooking(client, input.serviceId!);
        if (service?.id !== input.serviceId || !isPeriodicFollowupService(service)) {
          state.followupServiceRejected = true;
          return { ok: false as const, conflict: null };
        }
        // Keep an explicit duration; otherwise use the current locked default.
        durationMinutes = Number.isFinite(requested) && requested > 0
          ? Math.round(requested) : service.defaultDurationMinutes;
      }
      if (isReturnBooking) {
        const source = await readReturnBookingContext(client, patientId, input.returnBookingSource!, {
          lock: true, ...(input.returnBookingOrigin ? { origin: input.returnBookingOrigin } : {}),
        });
        if (!source.ok) {
          state.returnRejected = { message: source.message, code: source.code };
          return { ok: false as const, conflict: null };
        }
        if (source.fingerprint !== input.returnBookingFingerprint
          || (input.doctorId != null && Number(input.doctorId) !== source.doctorId)) {
          state.returnRejected = { message: "تغيّر الطبيب المسؤول أو سياق العودة. حدّث الاقتراح؛ تغيير المسؤول من الإعدادات فقط.", code: "return_booking_source_changed" };
          return { ok: false as const, conflict: null };
        }
        // A return belongs to its current case clinician, never the booking
        // actor or an arbitrary picker. This grants no patient access itself.
        doctorId = source.doctorId;
      }
      if (!await lockBookableAppointmentDoctor(client, doctorId)) {
        state.doctorRejected = true;
        return { ok: false as const, conflict: null };
      }
      const judged = await judgeBookingInDay({
        sameDay, client, date: input.date, time: input.time, durationMinutes,
        service, context, providerId: doctorId, chairNo, requireAssignedProvider: isReturnBooking,
        isNewPatient: input.isNewPatient ?? false,
        patientId,
        canOverride, overrideReason,
        nearbyAppointmentConfirmation: input.nearbyAppointmentConfirmation,
        bookingActor: actor.userId === undefined ? actor.username : `${actor.userId}:${actor.username}`, bookingScope: bookingProposalScope("create", input),
      });
      state.verdict = judged.verdict;
      if (!judged.ok) return { ok: false as const, conflict: judged.conflict };
      state.overridden = judged.overridden;
      return { ok: true as const };
    },
    commit: async (client) => {
      await options.assertAssignment?.(patientId, doctorId);
      return insertAppointmentOnClient(client, {
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
      });
    },
  }).catch(error => {
    if (isReturnBooking && (error as { code?: string }).code === "55P03") {
      state.returnRejected = { message: "يجري تحديث مسؤولية الحالة. حدّث اقتراح العودة وأعد المحاولة.", code: "return_booking_source_changed" };
      return { ok: false as const, conflict: null };
    }
    throw error;
  });

  if (!result.ok) {
    if (state.returnRejected) return { ok: false, status: 400, ...state.returnRejected };
    if (state.followupServiceRejected) return { ok: false, status: 400, message: FOLLOWUP_SERVICE_REVIEW_MESSAGE };
    if (state.doctorRejected) return { ok: false, status: 400, message: APPOINTMENT_DOCTOR_UNAVAILABLE_MESSAGE };
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
    }, options.audit);
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

/* ── إعادة الجدولة ──────────────────────────────────────────────────────── */

export interface RescheduleInput {
  appointmentId: number;
  date: string;
  time: string;
  /** تُترك فارغةً فتبقى مدّةُ الموعد كما حُجزت — نقلُ الوقت لا يعيد تسعير المدّة. */
  durationMinutes?: number | null;
  /** تغييرُ الخدمة قرارٌ صريح، ويُنشئ لقطةً جديدة. */
  serviceId?: number | null;
  doctorId?: number | null;
  chairNo?: number | null;
  reason: string;
  overrideReason?: string | null;
  nearbyAppointmentConfirmation?: string | null;
  transferToCurrentResponsibleDoctor?: boolean;
  returnBookingSource?: ReturnBookingSource | null;
  returnBookingOrigin?: ReturnBookingSource | null;
  returnBookingFingerprint?: string | null;
}

export type RescheduleResult =
  | { ok: true; appointment: Appointment; verdict: CapacityVerdict; overridden: boolean; warning: string | null }
  | { ok: false; status: 400 | 404 | 409; message: string; code?: string; conflict?: BookingConflict };

/**
 * نقلُ موعدٍ إلى وقتٍ آخر — عبر محرّك السعة نفسه، لا بابًا ثانيًا.
 *
 * **لماذا لم يكن موجودًا وما أثرُ غيابه:** لا موضعَ في المستودع كان يكتب
 * `scheduled_date`/`scheduled_time` بعد الإنشاء. فنقلُ موعدٍ كان يتمّ بإلغائه
 * وحجزِ غيره — فيُفقد أثرُ الموعد الأوّل، ويُحتسب المريض في «الملغى» وهو لم
 * يُلغِ، وتصير أرقامُ الإلغاء التي يقرأها المالك أكبر من حقيقتها.
 *
 * والترتيب مقصود:
 *   ١) يُقرأ الموعد وتُقرأ التهيئة **خارج** القفل فلا يطول.
 *   ٢) المحجوزُ وحده يُنقل: من وصل صاحبه أو أُنجز أو أُغلق ليس موعدًا يُنقل.
 *   ٣) يُقفل اليومان بترتيبٍ ثابت (انظر `writeAppointmentAcrossDays`).
 *   ٤) يُحكم على اليوم الهدف **باستثناء الموعد نفسه** — وإلّا زاحم نفسَه فرُفض
 *      نقلُه إلى وقتٍ يتّسع له.
 *   ٥) تُكتب النقلةُ بحارسٍ داخل جملة التحديث، فمن غيّره بيننا يفوز.
 *
 * واللقطاتُ تُحفظ حين يُنقل الوقتُ وحده: المدّة والفواصل والكرسيّ وصفةُ «يشغل
 * كرسيًّا». وتغييرُ الخدمة يُنشئ لقطةً جديدة — لأنّه تغييرُ ما يُجرى للمريض لا
 * تغييرُ ساعته.
 */
export async function rescheduleAppointment(
  input: RescheduleInput, actor: BookingActor,
  /** The canonical path (M2 slice 18): its admitted transaction, and an atomic audit
   * writer on it for the reschedule and capacity-override rows. Without them, as
   * before: the engine owns its transaction and both rows are written after commit. */
  options: { client?: DbClient; audit?: (input: AuditInput) => Promise<void> } = {},
): Promise<RescheduleResult> {
  const id = Number(input.appointmentId);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, status: 400, message: "رقم الموعد غير صالح." };
  }
  if (!DATE_PATTERN.test(input.date)) {
    return { ok: false, status: 400, message: "تاريخ غير صالح." };
  }
  if (!TIME_PATTERN.test(input.time)) {
    return { ok: false, status: 400, message: "وقت غير صالح." };
  }
  /* السببُ إلزاميّ: «لماذا نُقل؟» سؤالٌ يُسأل حين يشكو المريض أنّ موعده تغيّر. */
  const reason = (input.reason ?? "").trim();
  if (reason.length < 3) {
    return { ok: false, status: 400, message: "اكتب سبب نقل الموعد." };
  }

  const current = options.client ? await getAppointmentWith(options.client, id) : await getAppointment(id);
  if (!current) return { ok: false, status: 404, message: "الموعد غير موجود." };
  if (current.status !== "booked") {
    return {
      ok: false, status: 409,
      message: "لا يُنقل إلا الموعد المحجوز — هذا الموعد تغيّرت حاله.",
    };
  }

  const context = await loadCapacityContext();
  /* الخدمة: الجديدة إن طُلبت صراحةً، وإلّا خدمةُ الموعد كما حُجز. */
  const changingService = input.serviceId !== undefined && input.serviceId !== null
    && input.serviceId !== current.serviceId;
  const service = await resolveService({
    serviceId: changingService ? input.serviceId! : (current.serviceId ?? null),
    appointmentType: changingService ? null : (current.appointmentType ?? null),
  });

  const requested = Number(input.durationMinutes);
  const durationMinutes = Number.isFinite(requested) && requested > 0
    ? Math.round(requested)
    : (changingService
      ? (service?.defaultDurationMinutes ?? current.durationMinutes)
      : current.durationMinutes);
  if (durationMinutes < MIN_DURATION || durationMinutes > MAX_DURATION) {
    return {
      ok: false, status: 400,
      message: `المدّة يجب أن تكون بين ${MIN_DURATION} و${MAX_DURATION} دقيقة.`,
    };
  }

  const chairNo = input.chairNo === undefined
    ? (current.chairNo ?? null)
    : (input.chairNo === null || Number(input.chairNo) <= 0 ? null : Math.round(Number(input.chairNo)));
  if (chairNo !== null && chairNo > context.chairs) {
    return {
      ok: false, status: 400,
      message: `رقم الكرسي يجب أن يكون بين ١ و${context.chairs}.`,
    };
  }

  let doctorId = input.doctorId === undefined
    ? (current.doctorId ?? null)
    : (Number.isInteger(Number(input.doctorId)) && Number(input.doctorId) > 0
      ? Number(input.doctorId) : null);

  const transferring = input.transferToCurrentResponsibleDoctor === true;
  if ((!transferring && doctorId !== (current.doctorId ?? null))
    || (transferring && (!input.returnBookingSource || typeof input.returnBookingFingerprint !== "string"
      || !/^[a-f0-9]{64}$/.test(input.returnBookingFingerprint)))) {
    return { ok: false, status: 400, code: "return_booking_context_required",
      message: "نقل الطبيب يحتاج اختيارًا صريحًا لسياق الحالة والتحقق من المسؤول الحالي؛ نقل الوقت وحده لا يغيّر الطبيب." };
  }
  const canOverride = actorCanOverride(actor);
  const overrideReason = (input.overrideReason ?? "").trim().slice(0, 300);
  const state: { verdict: CapacityVerdict | null; overridden: boolean; doctorRejected: boolean;
    returnRejected: { message: string; code: string } | null } =
    { verdict: null, overridden: false, doctorRejected: false, returnRejected: null };

  const result = await writeAppointmentAcrossDays({
    client: options.client,
    fromDate: current.scheduledDate,
    toDate: input.date,
    judge: async (targetDay, client) => {
      if (transferring) {
        const source = await readReturnBookingContext(client, current.patientId, input.returnBookingSource!, {
          lock: true, ...(input.returnBookingOrigin ? { origin: input.returnBookingOrigin } : {}),
        });
        if (!source.ok) {
          state.returnRejected = { code: source.code, message: source.message };
          return { ok: false as const, conflict: null };
        }
        if (source.fingerprint !== input.returnBookingFingerprint
          || (input.doctorId != null && Number(input.doctorId) !== source.doctorId)) {
          state.returnRejected = { code: "return_booking_source_changed", message: "تغيّر سياق الحالة أو الطبيب المسؤول. حدّث الاختيار قبل نقل الموعد." };
          return { ok: false as const, conflict: null };
        }
        doctorId = source.doctorId;
      }
      if (!await lockBookableAppointmentDoctor(client, doctorId)) {
        state.doctorRejected = true;
        return { ok: false as const, conflict: null };
      }
      const judged = await judgeBookingInDay({
        sameDay: targetDay, client, date: input.date, time: input.time,
        durationMinutes, service, context, providerId: doctorId, chairNo, requireAssignedProvider: transferring || (!service && doctorId !== null),
        /* الموعد لا يزاحم نفسه. */
        excludeId: id,
        isNewPatient: current.isNewPatient ?? false,
        patientId: current.patientId,
        canOverride, overrideReason,
        nearbyAppointmentConfirmation: input.nearbyAppointmentConfirmation,
        bookingActor: actor.userId === undefined ? actor.username : `${actor.userId}:${actor.username}`, bookingScope: bookingProposalScope("reschedule", input),
      });
      state.verdict = judged.verdict;
      if (!judged.ok) return { ok: false as const, conflict: judged.conflict };
      state.overridden = judged.overridden;
      return { ok: true as const };
    },
    commit: (client) => moveAppointmentOnClient(client, {
      id,
      fromDate: current.scheduledDate,
      fromTime: current.scheduledTime.slice(0, 5),
      toDate: input.date,
      toTime: input.time,
      durationMinutes,
      serviceId: service?.id ?? (changingService ? null : current.serviceId ?? null),
      appointmentType: changingService
        ? (service?.legacyType ?? null) : (current.appointmentType ?? null),
      /* لقطاتٌ تُحفظ عند نقل الوقت، وتُجدَّد عند تغيير الخدمة. */
      bufferBeforeMinutes: changingService
        ? (service?.bufferBeforeMinutes ?? 0) : (current.bufferBeforeMinutes ?? 0),
      bufferAfterMinutes: changingService
        ? (service?.bufferAfterMinutes ?? 0) : (current.bufferAfterMinutes ?? 0),
      occupiesChair: changingService
        ? (service ? service.requiresChair : true) : (current.occupiesChair !== false),
      chairNo,
      doctorId,
      expectedDoctorId: current.doctorId ?? null,
    }),
  }).catch(error => {
    if (transferring && (error as { code?: string }).code === "55P03") {
      state.returnRejected = { code: "return_booking_source_changed", message: "يجري تحديث مسؤولية الحالة. حدّث السياق وأعد المحاولة." };
      return { ok: false as const, conflict: null };
    }
    throw error;
  });

  if (!result.ok) {
    if (state.returnRejected) return { ok: false, status: 409, ...state.returnRejected };
    if (state.doctorRejected) return { ok: false, status: 400, message: APPOINTMENT_DOCTOR_UNAVAILABLE_MESSAGE };
    return {
      ok: false, status: 409,
      message: (result.conflict as BookingConflict).message,
      conflict: result.conflict as BookingConflict,
    };
  }
  const moved = result.value;
  if (!moved) {
    /* الحارسُ داخل الجملة ردّنا: غيرُنا حرّك الموعد بيننا. */
    return {
      ok: false, status: 409,
      message: "تغيّر الموعد أثناء النقل — حدّث القائمة وأعد المحاولة.",
    };
  }

  const verdict = state.verdict;
  const rescheduled: AuditInput = {
    action: "appointment.reschedule",
    entity: "appointment",
    entityId: String(id),
    entityLabel: moved.patientName,
    actor: actor.username,
    actorRole: (actor.role ?? null) as string | null,
    details: {
      من: `${current.scheduledDate} ${current.scheduledTime.slice(0, 5)}`,
      إلى: `${input.date} ${input.time}`,
      المدّة: durationMinutes,
      الخدمة: changingService ? (service?.nameAr ?? "غير محدَّدة") : "كما هي",
      الكرسي: chairNo ?? "لم يُخصَّص",
      السبب: reason.slice(0, 300),
      ...(transferring ? { "نقل مسؤولية الموعد صراحة": true, "الطبيب السابق": current.doctorId ?? null,
        "الطبيب الحالي": doctorId, "سياق المسؤولية": input.returnBookingSource } : {}),
      القناة: actor.channel,
    },
  };
  if (options.audit) await options.audit(rescheduled);
  else await recordAudit(rescheduled).catch(() => {});

  if (state.overridden && verdict) {
    await recordCapacityOverride({
      appointmentId: id, verdict, date: input.date, time: input.time,
      reason: overrideReason, serviceName: service?.nameAr,
      actor: actor.username, actorRole: (actor.role ?? null) as string | null,
      channel: actor.channel,
    }, options.audit);
  }

  return {
    ok: true,
    appointment: moved,
    verdict: verdict ?? {
      state: "AVAILABLE", occupiedChairs: 0, chairs: context.chairs, dayPercent: 0,
      outsideHours: false, message: "متاح", reasons: [],
    },
    overridden: state.overridden,
    warning: verdict && verdict.outsideHours
      ? "الوقت الجديد خارج ورديات المركز — تأكّد قبل أن تَعِد المريض."
      : null,
  };
}
