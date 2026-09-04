/**
 * جدولة المواعيد — المنطق الخالص.
 *
 * اللوحة عالجت «يجلسون ساعات» ولم تعالج «ينتظرون أيامًا لموعد»، ومريض التقويم يحتاج
 * زيارة كل ثلاثة أو أربعة أسابيع. هذا الملف هو الجزء الذي يمنع اليوم من الانهيار قبل
 * أن يبدأ: لا يُحجز في ساعةٍ أكثر مما يتسع له عدد الكراسي.
 *
 * السبب المباشر لانهيار يوم عيادة التقويم معروف: شدّ السلك عشر دقائق واللصق ستون،
 * فإذا حُجز الاثنان كأنهما نصف ساعة انهار الجدول قبل الظهر مهما كان النظام سليمًا.
 * لذلك المدة حقلٌ في الموعد لا رقمٌ ثابت.
 */

export type AppointmentStatus = "booked" | "arrived" | "done" | "cancelled" | "no_show";

export type AppointmentType =
  | "consultation"    // كشف واستشارة
  | "follow_up"       // متابعة دورية / شد
  | "surgery"         // إجراء جراحي / خلع
  | "endo"            // علاج عصب وجذور
  | "filling"         // حشوة تجميلية
  | "prosthetics"     // تركيبات وتيجان
  | "cleaning"        // تنظيف وقائي
  | "emergency"       // طوارئ
  | "other";          // أخرى

export interface AppointmentTypeOption {
  id: string;
  label: string;
  shortLabel: string;
  defaultDuration: number;
  badgeClass: string;
  icon?: string;
}

export const APPOINTMENT_TYPES: AppointmentTypeOption[] = [
  { id: "consultation", label: "كشف واستشارة تشخيصية", shortLabel: "كشف واستشارة", defaultDuration: 30, badgeClass: "border-blue-200 bg-blue-50 text-blue-800" },
  { id: "follow_up", label: "متابعة دورية / شد تقويم", shortLabel: "متابعة دورية", defaultDuration: 15, badgeClass: "border-indigo-200 bg-indigo-50 text-indigo-800" },
  { id: "surgery", label: "إجراء جراحي / خلع وزراعة", shortLabel: "إجراء جراحي", defaultDuration: 45, badgeClass: "border-rose-200 bg-rose-50 text-rose-800" },
  { id: "endo", label: "علاج عصب وجذور الأسنان", shortLabel: "علاج عصب", defaultDuration: 45, badgeClass: "border-purple-200 bg-purple-50 text-purple-800" },
  { id: "filling", label: "حشوة تجميلية وترميم", shortLabel: "حشوة تجميلية", defaultDuration: 30, badgeClass: "border-amber-200 bg-amber-50 text-amber-800" },
  { id: "prosthetics", label: "تركيبات وتيجان / قياسات", shortLabel: "تركيبات وتيجان", defaultDuration: 45, badgeClass: "border-teal-200 bg-teal-50 text-teal-800" },
  { id: "cleaning", label: "تنظيف وتبييض وقائي", shortLabel: "تنظيف وقائي", defaultDuration: 30, badgeClass: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  { id: "emergency", label: "طوارئ وألم حاد", shortLabel: "طوارئ", defaultDuration: 20, badgeClass: "border-red-300 bg-red-100 text-red-800" },
  { id: "other", label: "أخرى / إجراء عام", shortLabel: "أخرى", defaultDuration: 30, badgeClass: "border-slate-200 bg-slate-100 text-slate-700" },
];

export function getAppointmentTypeLabel(type: string | null | undefined): string | null {
  if (!type) return null;
  const found = APPOINTMENT_TYPES.find((t) => t.id === type || t.label === type || t.shortLabel === type);
  return found ? found.shortLabel : type;
}

export function getAppointmentTypeBadge(type: string | null | undefined): string {
  if (!type) return "border-slate-200 bg-slate-100 text-slate-700";
  const found = APPOINTMENT_TYPES.find((t) => t.id === type || t.label === type || t.shortLabel === type);
  return found ? found.badgeClass : "border-slate-200 bg-slate-100 text-slate-700";
}

export interface Appointment {
  id: number;
  patientId: number;
  patientName: string;
  patientPhone: string | null;
  scheduledDate: string;   // YYYY-MM-DD بتوقيت العيادة
  scheduledTime: string;   // HH:MM
  durationMinutes: number;
  appointmentType?: string | null;
  note: string | null;
  status: AppointmentStatus;
  reminderSentAt?: string | null;
  /** جهة «طبيب» الموعد (صلاحيات الوكيل المساعد) — null لغير المسند لطبيب. */
  doctorId?: number | null;
}

/** المواعيد التي ما زالت تشغل مكانًا في اليوم. الملغى ومن لم يحضر لا يشغلان كرسيًا. */
export function occupiesChair(status: AppointmentStatus): boolean {
  return status === "booked" || status === "arrived";
}

/** «09:30» → 570 دقيقة من منتصف الليل. */
export function toMinutes(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * تاريخ اليوم بتوقيت العيادة لا بتوقيت الخادم.
 *
 * الخادم يعمل بـ UTC، واليمن عند UTC+3: بعد التاسعة مساءً بتوقيت غرينتش يكون التاريخ
 * في تعز قد انتقل لليوم التالي. حساب «اليوم» بـ `toISOString` كان سيرفض طلب مريض
 * لموعد الغد مساءً بحجة أنه «تاريخ ماضٍ».
 */
export function clinicDateString(now: Date, timeZone: string): string {
  // `en-CA` تُخرج YYYY-MM-DD مباشرة، والمنطقة الزمنية هي المقصود من الدالة كلها.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * يضيف أيامًا إلى تاريخ YYYY-MM-DD بحساب تقويمي بحت.
 *
 * الحساب بـ`Date.UTC` لا بتاريخ محلي: الجمع المحلي عبر حدود التوقيت الصيفي يعيد
 * اليوم نفسه أو يقفز يومين في بعض المناطق. والتاريخ هنا نصّ لا لحظة زمنية.
 */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

/**
 * موعد الجلسة القادمة بعد عدد من الأسابيع.
 *
 * أسابيع لا أيام لأن هكذا يفكّر أخصائي التقويم ويقول للمريض: «بعد أربعة أسابيع».
 * والأسبوع يحفظ يوم الأسبوع نفسه — من جاء الخميس يعود الخميس — وهو أسهل ما يتذكره
 * المريض وأقلّ ما يتعارض مع بقية أيامه.
 */
export function sessionAfterWeeks(fromDate: string, weeks: number): string {
  return addDays(fromDate, Math.round(weeks) * 7);
}

export function toTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * كم موعدًا يتقاطع زمنيًا مع نافذة مقترحة.
 *
 * التقاطع لا التطابق: موعد الساعة 10:00 لستين دقيقة يصطدم بموعد 10:30 حتى وإن اختلف
 * وقت البدء. الفحص بالتطابق وحده كان سيسمح بثلاثة مرضى بين 10:00 و11:00 وعندك كرسيان.
 */
export function overlappingCount(
  appointments: Appointment[],
  date: string,
  time: string,
  durationMinutes: number,
  excludeId?: number,
): number {
  const start = toMinutes(time);
  if (start === null) return 0;
  const end = start + Math.max(1, durationMinutes);

  return appointments.filter((appointment) => {
    if (appointment.id === excludeId) return false;
    if (appointment.scheduledDate !== date) return false;
    if (!occupiesChair(appointment.status)) return false;
    const otherStart = toMinutes(appointment.scheduledTime);
    if (otherStart === null) return false;
    const otherEnd = otherStart + Math.max(1, appointment.durationMinutes);
    // تقاطع حقيقي: نهاية أحدهما بعد بداية الآخر تمامًا. موعد ينتهي 10:00 وآخر يبدأ
    // 10:00 لا يتقاطعان — وهذا هو الحجز المتتالي الصحيح، لا تعارضًا يجب منعه.
    return otherStart < end && start < otherEnd;
  }).length;
}

export interface SlotCheck {
  allowed: boolean;
  conflicting: number;
  chairs: number;
  reason: string | null;
}

/**
 * هل يتسع هذا الوقت لموعد جديد؟
 *
 * الجواب رقم لا شعور: عدد المتقاطعين مقابل عدد الكراسي. حين يمتلئ الكرسيان تُرفض
 * الإضافة برسالة تقول العدد — لأن «الوقت غير متاح» وحدها تدفع الاستقبال إلى الحجز
 * في وقت آخر عشوائيًا بدل رؤية أن اليوم ممتلئ فعلًا.
 */
export function checkSlot(
  appointments: Appointment[],
  date: string,
  time: string,
  durationMinutes: number,
  chairs: number,
  excludeId?: number,
): SlotCheck {
  if (toMinutes(time) === null) {
    return { allowed: false, conflicting: 0, chairs, reason: "وقت غير صالح." };
  }
  if (!Number.isFinite(durationMinutes) || durationMinutes < 5 || durationMinutes > 480) {
    return { allowed: false, conflicting: 0, chairs, reason: "مدة غير منطقية." };
  }
  const conflicting = overlappingCount(appointments, date, time, durationMinutes, excludeId);
  if (conflicting >= chairs) {
    return {
      allowed: false,
      conflicting,
      chairs,
      reason: `الكراسي ممتلئة في هذا الوقت (${conflicting} من ${chairs}). اختر وقتًا آخر.`,
    };
  }
  return { allowed: true, conflicting, chairs, reason: null };
}

/**
 * أقرب وقت فارغ بعد وقتٍ مطلوب.
 *
 * حين يمتلئ الوقت المطلوب، عرضُ بديلٍ محدد أنفع من رفضٍ مجرّد: الاستقبال تقول للمريض
 * «العاشرة ممتلئة، أعطيك 10:45» بدل أن تجرّب أوقاتًا واحدًا واحدًا أمامه.
 */
export function nextFreeTime(
  appointments: Appointment[],
  date: string,
  fromTime: string,
  durationMinutes: number,
  chairs: number,
  dayEndTime = "21:00",
): string | null {
  const start = toMinutes(fromTime);
  const end = toMinutes(dayEndTime);
  if (start === null || end === null) return null;

  for (let candidate = start; candidate + durationMinutes <= end; candidate += 15) {
    if (checkSlot(appointments, date, toTime(candidate), durationMinutes, chairs).allowed) {
      return toTime(candidate);
    }
  }
  return null;
}

export interface DayLoad {
  booked: number;
  bookedMinutes: number;
  capacityMinutes: number;
  percent: number;
}

/**
 * حِمل اليوم مقابل طاقته الحقيقية.
 *
 * الطاقة = عدد الكراسي × ساعات العمل. الرقم يُظهر أن اليوم ممتلئ **قبل** أن يُحجز فيه
 * المزيد، وهو ما لم يكن أحد في العيادة يعرفه.
 */
export function dayLoad(
  appointments: Appointment[],
  date: string,
  chairs: number,
  dayStartTime = "09:00",
  dayEndTime = "21:00",
): DayLoad {
  const start = toMinutes(dayStartTime) ?? 0;
  const end = toMinutes(dayEndTime) ?? 0;
  const capacityMinutes = Math.max(0, end - start) * Math.max(1, chairs);

  const relevant = appointments.filter(
    (appointment) => appointment.scheduledDate === date && occupiesChair(appointment.status),
  );
  const bookedMinutes = relevant.reduce((total, a) => total + Math.max(0, a.durationMinutes), 0);

  return {
    booked: relevant.length,
    bookedMinutes,
    capacityMinutes,
    percent: capacityMinutes === 0 ? 0 : Math.round((bookedMinutes / capacityMinutes) * 100),
  };
}

export interface ChairSchedule {
  chair: number;
  appointments: Appointment[];
}

/**
 * يوزع مواعيد اليوم على كراسي العيادة بنظام الأجندة المتوازية (Multi-Chair Visual Agenda).
 * المواعيد المتزامنة تأخذ كراسي مختلفة لمنع الاصطدام.
 */
export function distributeAppointmentsToChairs(
  appointments: Appointment[],
  date: string,
  chairCount: number,
): ChairSchedule[] {
  const dayAppointments = appointments
    .filter((a) => a.scheduledDate === date)
    .sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime));

  const count = Math.max(1, chairCount);
  const chairs: ChairSchedule[] = Array.from({ length: count }, (_, i) => ({
    chair: i + 1,
    appointments: [],
  }));

  for (const appt of dayAppointments) {
    const apptStart = toMinutes(appt.scheduledTime) ?? 0;
    const apptEnd = apptStart + appt.durationMinutes;

    let placed = false;
    for (const chair of chairs) {
      const hasOverlap = chair.appointments.some((existing) => {
        if (!occupiesChair(existing.status)) return false;
        const existStart = toMinutes(existing.scheduledTime) ?? 0;
        const existEnd = existStart + existing.durationMinutes;
        return apptStart < existEnd && existStart < apptEnd;
      });

      if (!hasOverlap) {
        chair.appointments.push(appt);
        placed = true;
        break;
      }
    }

    if (!placed) {
      const minChair = chairs.reduce((prev, curr) =>
        curr.appointments.length < prev.appointments.length ? curr : prev
      );
      minChair.appointments.push(appt);
    }
  }

  return chairs;
}

