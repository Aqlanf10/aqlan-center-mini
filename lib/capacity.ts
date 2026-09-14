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
import { effectiveWindow, windowsOverlap, type AppointmentService } from "./appointment-services";

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

/* ═══ (المرحلة ٤ب) المحرّك الكامل — يستهلك التهيئة الحيّة ═══════════════════ */


export interface Shift { start: string; end: string }

export interface ProviderBlockWindow { startMinutes: number; endMinutes: number; reason: string }

export interface FullCapacityInput {
  appointments: Appointment[];
  date: string;
  time: string;
  /** المدّة الفعليّة لهذا الموعد — لقطةٌ لا افتراضُ الخدمة اليوم. */
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  chairs: number;
  /** الورديات الحقيقية — واحدةٌ أو أكثر، وما بينها مغلق. */
  shifts: readonly Shift[];
  nearCapacityPercent: number;
  /** متطلّبات الخدمة المطلوبة. */
  service: Pick<AppointmentService,
    "requiresProvider" | "requiresChair" | "allowsConcurrentProviderWork"
    | "consumesEmergencyReserve" | "isActive" | "nameAr">;
  providerId?: number | null;
  chairNo?: number | null;
  providerBlocks?: readonly ProviderBlockWindow[];
  /** دقائقُ تُحجز للطوارئ في كل وردية ولا تُحجز مسبقًا — صفرٌ يعني التعطيل. */
  emergencyReserveMinutesPerShift?: number;
  /** حدّ المرضى الجدد يوميًّا — صفرٌ يعني «بلا حدّ» وهو الافتراضيّ. */
  newPatientDailyLimit?: number;
  isNewPatient?: boolean;
  newPatientsBookedToday?: number;
  excludeId?: number;
}

const toMinutes = (value: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? "").trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
};

/** الورديات الصالحة وحدها — المقلوبة والفاسدة تُهمَل بدل أن تُعطّل الحجز كلَّه. */
export function usableShifts(shifts: readonly Shift[]): { start: number; end: number }[] {
  return shifts
    .map((shift) => ({ start: toMinutes(shift.start), end: toMinutes(shift.end) }))
    .filter((shift): shift is { start: number; end: number } =>
      shift.start !== null && shift.end !== null && shift.end > shift.start)
    .sort((a, b) => a.start - b.start);
}

/**
 * هل تقع النافذة **كاملةً** داخل ورديةٍ واحدة؟
 *
 * الفترة المغلقة بين الورديتين ليست وقتًا متاحًا لأنها بين `day_start` و`day_end`:
 * المركز مغلقٌ فيها فعلًا. وموعدٌ يبدأ ١٢:٤٥ وينتهي ١٣:١٥ يمتدّ عبر الإغلاق —
 * فيُرفض ولو كان طرفاه داخل الدوام.
 */
export function withinAnyShift(
  window: { start: number; end: number }, shifts: readonly Shift[],
): boolean {
  const usable = usableShifts(shifts);
  if (usable.length === 0) return true;
  return usable.some((shift) => window.start >= shift.start && window.end <= shift.end);
}

/** طاقة اليوم بكل ورديّاته، ناقصًا ما يُحجز للطوارئ في كلٍّ منها. */
export function shiftsCapacityMinutes(
  shifts: readonly Shift[], chairs: number, reservePerShift: number,
): number {
  const usable = usableShifts(shifts);
  const seats = Math.max(1, Math.floor(chairs));
  const reserve = Math.max(0, Math.floor(reservePerShift));
  return usable.reduce(
    (total, shift) => total + Math.max(0, (shift.end - shift.start) * seats - reserve),
    0,
  );
}

/** نافذة الإشغال الفعلية لموعدٍ قائم — بلقطته هو لا بإعداد الخدمة اليوم. */
function windowOf(appointment: Appointment): { start: number; end: number } | null {
  const start = toMinutes(appointment.scheduledTime);
  if (start === null) return null;
  return effectiveWindow({
    startMinutes: start,
    durationMinutes: appointment.durationMinutes,
    bufferBeforeMinutes: appointment.bufferBeforeMinutes ?? 0,
    bufferAfterMinutes: appointment.bufferAfterMinutes ?? 0,
  });
}

/**
 * الحكم الكامل.
 *
 * يُقيَّم على نوافذ الإشغال الفعلية لا على عدد المواعيد: الفاصل جزءٌ من الحجز،
 * والنهايةُ الملامسة ليست تزاحمًا.
 */
export function judgeFullCapacity(input: FullCapacityInput): CapacityVerdict {
  const {
    appointments, date, time, durationMinutes, bufferBeforeMinutes, bufferAfterMinutes,
    chairs, shifts, nearCapacityPercent, service, providerId, chairNo,
    providerBlocks = [], emergencyReserveMinutesPerShift = 0,
    newPatientDailyLimit = 0, isNewPatient = false, newPatientsBookedToday = 0,
    excludeId,
  } = input;

  const startMinutes = toMinutes(time);
  const reasons: string[] = [];
  const over = (message: string[]): CapacityVerdict => ({
    state: "OVER_CAPACITY", occupiedChairs: 0, chairs, dayPercent: 0,
    outsideHours: false, message: message.join(" "), reasons: message,
  });

  if (startMinutes === null) return over(["وقت غير صالح."]);
  if (!service.isActive) {
    return over([`الخدمة «${service.nameAr}» معطَّلة — لا تُحجز مواعيد جديدة بها.`]);
  }

  const mine = effectiveWindow({
    startMinutes, durationMinutes, bufferBeforeMinutes, bufferAfterMinutes,
  });

  const live = appointments.filter((appointment) =>
    appointment.scheduledDate === date
    && appointment.id !== excludeId
    && occupiesChair(appointment.status));

  /* ١) خارج الورديات — الفترة المغلقة ليست متاحة. */
  const outsideHours = !withinAnyShift(mine, shifts);

  /* ٢) الطبيب: محجوبٌ أو مشغول. */
  if (service.requiresProvider && providerId) {
    const blocked = providerBlocks.find((block) =>
      windowsOverlap(mine, { start: block.startMinutes, end: block.endMinutes }));
    if (blocked) reasons.push(`الطبيب محجوب في هذا الوقت (${blocked.reason}).`);

    if (!service.allowsConcurrentProviderWork) {
      const clash = live.some((appointment) => {
        if (appointment.doctorId !== providerId) return false;
        const other = windowOf(appointment);
        return other ? windowsOverlap(mine, other) : false;
      });
      if (clash) reasons.push("الطبيب لديه موعدٌ آخر يتداخل مع هذا الوقت.");
    }
  }

  /* ٣) الكرسي: تصادمٌ صريح على كرسيٍّ بعينه، أو امتلاء الكراسي عمومًا. */
  let occupiedChairs = 0;
  if (service.requiresChair) {
    if (chairNo != null) {
      const clash = live.some((appointment) => {
        /* الشرطان معًا: كرسيٌّ بعينه، وموعدٌ يشغله فعلًا. وموعدٌ خدمتُه لا تشغل
           كرسيًّا لا يحجز كرسيًّا ولو حُفظ عليه رقمٌ من حجزٍ أسبق. */
        if (appointment.occupiesChair === false) return false;
        if (appointment.chairNo !== chairNo) return false;
        const other = windowOf(appointment);
        return other ? windowsOverlap(mine, other) : false;
      });
      if (clash) reasons.push(`الكرسي رقم ${chairNo} مشغولٌ في هذا الوقت.`);
    }
    /* الكرسي غير المخصَّص يستهلك طاقةً عامة: `null` تعني «لم يُخصَّص» لا «بلا كرسي».
       أمّا موعدٌ خدمتُه لا تشغل كرسيًّا (استشارةٌ هاتفية مثلًا) فلا يُعدّ أصلًا —
       وكان يُعدّ، فيُرفض في مركزٍ بكرسيٍّ واحد حجزٌ حقيقيّ بسبب مكالمة. واللقطة
       من الموعد لا من الخدمة اليوم: ما حُجز يُقاس بما كان. */
    occupiedChairs = live.filter((appointment) => {
      if (appointment.occupiesChair === false) return false;
      const other = windowOf(appointment);
      return other ? windowsOverlap(mine, other) : false;
    }).length;
    if (occupiedChairs >= chairs) {
      reasons.push(`الكراسي ممتلئة في هذا الوقت (${occupiedChairs} من ${chairs}).`);
    }
  }

  /* ٤) حدّ المرضى الجدد — مُعطَّلٌ ما لم يضع له المالك رقمًا. */
  if (isNewPatient && newPatientDailyLimit > 0
    && newPatientsBookedToday >= newPatientDailyLimit) {
    reasons.push(`بلغ اليوم حدّ المرضى الجدد (${newPatientDailyLimit}).`);
  }

  /* ٥) طاقة اليوم — واحتياطي الطوارئ يُنقص المتاح للحجز المسبق. */
  const reserve = service.consumesEmergencyReserve ? 0 : emergencyReserveMinutesPerShift;
  const capacityMinutes = shiftsCapacityMinutes(shifts, chairs, reserve);
  const bookedMinutes = live.reduce((total, appointment) => {
    const other = windowOf(appointment);
    return total + (other ? Math.max(0, other.end - other.start) : 0);
  }, 0);
  const mineMinutes = Math.max(0, mine.end - mine.start);
  const dayPercent = capacityMinutes === 0
    ? 0
    : Math.max(0, Math.round(((bookedMinutes + mineMinutes) / capacityMinutes) * 100));

  if (capacityMinutes > 0 && dayPercent > 100) {
    reasons.push(`هذا الحجز يتجاوز طاقة اليوم (${dayPercent}٪).`);
  }

  if (reasons.length > 0) {
    return {
      state: "OVER_CAPACITY", occupiedChairs, chairs, dayPercent, outsideHours,
      message: reasons.join(" "), reasons,
    };
  }

  /* الاقتراب: يُقال قبل الوعد لا بعده. */
  const near: string[] = [];
  const threshold = Number.isFinite(nearCapacityPercent) && nearCapacityPercent > 0
    ? nearCapacityPercent : 100;
  if (capacityMinutes > 0 && dayPercent >= threshold) {
    near.push(`اليوم ممتلئ ${dayPercent}٪ — تأكّد قبل أن تَعِد المريض.`);
  }
  if (service.requiresChair && chairs > 1 && occupiedChairs === chairs - 1) {
    near.push("هذا آخر كرسيٍّ متاح في هذا الوقت.");
  }
  if (outsideHours) near.push("الوقت خارج ورديات المركز.");

  if (near.length > 0) {
    return {
      state: "NEAR_CAPACITY", occupiedChairs, chairs, dayPercent, outsideHours,
      message: near.join(" "), reasons: near,
    };
  }

  return {
    state: "AVAILABLE", occupiedChairs, chairs, dayPercent, outsideHours,
    message: CAPACITY_LABEL.AVAILABLE, reasons: [],
  };
}
