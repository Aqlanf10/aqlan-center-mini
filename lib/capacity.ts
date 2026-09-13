/**
 * محرّك السعة الذكيّ — المرحلة ٤ من خطّة المالك.
 *
 * «المحرك يمنع الازدحام قبل حدوثه.» والفرق بينه وبين فحص التعارض القديم أنّ القديم
 * يجيب بنعم أو لا، وهذا يجيب بثلاث: متاح، واقترب من الحدّ، وتجاوز.
 *
 *   AVAILABLE      السعة مناسبة        → يُسمح بالحجز
 *   NEAR_CAPACITY  اقتربت من الحدّ      → تحذيرٌ واضح قبل الحجز
 *   OVER_CAPACITY  تجاوز القواعد        → يُمنع، ولا يمرّ إلا بصلاحية `override_capacity`
 *                                         وسببٍ يُسجَّل بالمستخدم والوقت
 *
 * والحالة الوسطى هي الفائدة كلّها: «ممتلئ» بعد فوات الأوان لا يفيد، و«اقترب» قبل أن
 * تَعِد الاستقبالُ المريضَ يفيد. ولذلك يُعرَض الرقم قبل الوعد لا بعده.
 *
 * وهذه الوحدة **تقول ولا تفرض**: الفرض في الخادم داخل قفل اليوم الذرّي كما هو
 * حال بقيّة حرّاس الحجز — انظر `writeAppointmentInDay`.
 */
import { occupiesChair, overlappingCount, withinWorkingHours, type Appointment } from "./schedule";

export type CapacityState = "AVAILABLE" | "NEAR_CAPACITY" | "OVER_CAPACITY";

export const CAPACITY_LABEL: Record<CapacityState, string> = {
  AVAILABLE: "السعة مناسبة",
  NEAR_CAPACITY: "اقتربت السعة من الحدّ",
  OVER_CAPACITY: "تجاوز السعة",
};

export interface CapacityInput {
  appointments: Appointment[];
  date: string;
  time: string;
  durationMinutes: number;
  chairs: number;
  hours: { start: string; end: string };
  /** عتبة التحذير بالنسبة المئوية من طاقة اليوم — من الإعدادات. */
  nearCapacityPercent: number;
  /** موعدٌ يُعاد جدولته لا يُحسب منافسًا لنفسه. */
  excludeId?: number;
}

export interface CapacityVerdict {
  state: CapacityState;
  /** الكراسي المشغولة في أشدّ لحظةٍ يلمسها هذا الموعد. */
  occupiedChairs: number;
  chairs: number;
  /** نسبة امتلاء اليوم بعد إضافة هذا الموعد. */
  dayPercent: number;
  outsideHours: boolean;
  /** رسالةٌ عربية تصف الحال — تُعرض كما هي. */
  message: string;
  /** أسبابٌ تفصيلية تُعرض عند التجاوز أو الاقتراب. */
  reasons: string[];
}

const clampPercent = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

/**
 * يحكم على وقتٍ مقترح.
 *
 * ويُحسب الازدحام على بُعدين لا واحد: **اللحظة** (كم كرسيًّا مشغولًا حين يجلس هذا
 * المريض) و**اليوم** (كم من طاقة اليوم استُهلكت). موعدٌ في ساعةٍ فارغة من يومٍ
 * ممتلئ يمرّ من الأول ويسقط في الثاني — وكلاهما ازدحامٌ يشعر به المريض.
 */
export function judgeCapacity(input: CapacityInput): CapacityVerdict {
  const {
    appointments, date, time, durationMinutes, chairs, hours,
    nearCapacityPercent, excludeId,
  } = input;

  const live = appointments.filter((appointment) =>
    appointment.scheduledDate === date
    && appointment.id !== excludeId
    && occupiesChair(appointment.status));

  const occupiedChairs = overlappingCount(live, date, time, durationMinutes);
  const outsideHours = !withinWorkingHours(time, durationMinutes, hours);

  const bookedMinutes = live.reduce((total, a) => total + Math.max(0, a.durationMinutes), 0);
  const capacityMinutes = dayCapacityMinutes(chairs, hours);
  const dayPercent = capacityMinutes === 0
    ? 0
    : clampPercent(((bookedMinutes + Math.max(0, durationMinutes)) / capacityMinutes) * 100);

  const reasons: string[] = [];

  /* التجاوز: الكراسي ممتلئة في هذه اللحظة، أو اليوم تجاوز طاقته. */
  if (occupiedChairs >= chairs) {
    reasons.push(`الكراسي ممتلئة في هذا الوقت (${occupiedChairs} من ${chairs}).`);
  }
  if (capacityMinutes > 0 && dayPercent > 100) {
    reasons.push(`هذا الحجز يتجاوز طاقة اليوم (${dayPercent}٪).`);
  }
  if (reasons.length > 0) {
    return {
      state: "OVER_CAPACITY", occupiedChairs, chairs, dayPercent, outsideHours,
      message: reasons.join(" "), reasons,
    };
  }

  /* الاقتراب: تحذيرٌ يُقال قبل الوعد لا بعده. */
  const threshold = Number.isFinite(nearCapacityPercent) && nearCapacityPercent > 0
    ? nearCapacityPercent : 100;
  if (capacityMinutes > 0 && dayPercent >= threshold) {
    reasons.push(`اليوم ممتلئ ${dayPercent}٪ — تأكّد قبل أن تَعِد المريض.`);
  }
  if (chairs > 1 && occupiedChairs === chairs - 1) {
    reasons.push("هذا آخر كرسيٍّ متاح في هذا الوقت.");
  }
  if (outsideHours) {
    reasons.push(`الوقت خارج دوام المركز (${hours.start}–${hours.end}).`);
  }

  if (reasons.length > 0) {
    return {
      state: "NEAR_CAPACITY", occupiedChairs, chairs, dayPercent, outsideHours,
      message: reasons.join(" "), reasons,
    };
  }

  return {
    state: "AVAILABLE", occupiedChairs, chairs, dayPercent, outsideHours,
    message: CAPACITY_LABEL.AVAILABLE, reasons: [],
  };
}

/** دقائق الطاقة في يومٍ بساعاته وكراسيه — صفرٌ ليومٍ مقلوبٍ أو ساعاتٍ فاسدة. */
export function dayCapacityMinutes(chairs: number, hours: { start: string; end: string }): number {
  const toMinutes = (value: string): number | null => {
    const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? "").trim());
    if (!match) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
  };
  const start = toMinutes(hours.start);
  const end = toMinutes(hours.end);
  if (start === null || end === null || end <= start) return 0;
  return (end - start) * Math.max(1, Math.floor(chairs));
}

/**
 * هل يُسمح بالمرور رغم التجاوز؟
 *
 * التجاوز لا يُمنع منعًا مطلقًا — يُمنع على المستخدم العادي. ومَن يملك
 * `override_capacity` يمرّ **بسببٍ مكتوب** يُسجَّل باسمه ووقته. وبلا سببٍ لا يمرّ
 * أحد: تجاوزٌ بلا سبب هو بالضبط ما يجعل السجلّ عديم الفائدة بعد شهر.
 */
export function overrideAccepted(input: {
  canOverride: boolean;
  reason: string | null | undefined;
}): { ok: true } | { ok: false; message: string } {
  if (!input.canOverride) {
    return { ok: false, message: "تجاوز السعة يحتاج صلاحيةً أعلى." };
  }
  if ((input.reason ?? "").trim().length < 3) {
    return { ok: false, message: "اكتب سبب تجاوز السعة." };
  }
  return { ok: true };
}
