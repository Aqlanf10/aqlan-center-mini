/**
 * (LIVE-2) لوحة تشغيل اليوم — مرشّحات الاستقبال وعدّاداتها. منطقٌ خالص يُختبر بلا واجهة.
 *
 * - **المرشّحات** على ما في اللوحة أصلًا: الطبيب (أو «بلا طبيب» لزيارات المشي)، والحالة،
 *   والكرسي. لا طلب خادمٍ إضافي ولا منطق موازٍ: الزيارات من `/api/visits` والمواعيد من
 *   `/api/appointments?date=اليوم` كما كانت.
 * - **العدّادات** تفصل مصدرين لا يُخلطان: حالات **الزيارة** (ينتظر، نُودي، على الكرسي،
 *   أُنجز) وحالات **الموعد** (متبقٍّ لم يصل، لم يحضر، ملغى). «لم يحضر» حالة موعد لا حالة
 *   زيارة — من لم يحضر لا زيارة له أصلًا.
 */
import type { Visit, VisitStatus } from "./flow";
import type { Appointment } from "./schedule";

export type StatusFilter = "all" | VisitStatus;

export const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: "الكل",
  waiting: "ينتظر",
  called: "نُودي",
  in_chair: "على الكرسي",
  done: "أُنجز",
};

/** `null` = كل الأطباء؛ `"none"` = بلا طبيب محدد (زيارات المشي غير المربوطة بطبيب). */
export type DoctorFilter = number | "none" | null;

export interface TodayFilter {
  doctor: DoctorFilter;
  status: StatusFilter;
  chair: number | null;
}

export const NO_FILTER: TodayFilter = { doctor: null, status: "all", chair: null };

export function isFiltered(filter: TodayFilter): boolean {
  return filter.doctor !== null || filter.status !== "all" || filter.chair !== null;
}

function doctorMatches(doctorId: number | null | undefined, filter: DoctorFilter): boolean {
  if (filter === null) return true;
  if (filter === "none") return doctorId == null;
  return doctorId === filter;
}

/** الزيارات التي تُعرض تحت المرشّح. الكرسي يخصّ من نُودي أو جلس أو أُنجز عليه — المنتظر بلا كرسي. */
export function filterVisits(visits: readonly Visit[], filter: TodayFilter): Visit[] {
  return visits.filter((visit) =>
    doctorMatches(visit.doctorId, filter.doctor)
    && (filter.status === "all" || visit.status === filter.status)
    && (filter.chair === null || visit.chair === filter.chair));
}

/** المواعيد تحت مرشّح الطبيب والكرسي — الحالة هنا حالة زيارة فلا تنطبق على الموعد. */
export function filterAppointments(appointments: readonly Appointment[], filter: TodayFilter): Appointment[] {
  return appointments.filter((appointment) =>
    doctorMatches(appointment.doctorId, filter.doctor)
    && (filter.chair === null || appointment.chairNo == null || appointment.chairNo === filter.chair));
}

export interface TodayCounters {
  /* الزيارات */
  waiting: number;
  called: number;
  inChair: number;
  done: number;
  /* المواعيد */
  expected: number;
  late: number;
  noShow: number;
  cancelled: number;
}

/** العدّادات على ما بعد المرشّح — فيقرأ الطبيب أرقام مرضاه هو. */
export function todayCounters(
  visits: readonly Visit[],
  appointments: readonly Appointment[],
  lateCount: number,
): TodayCounters {
  const countVisits = (status: VisitStatus) => visits.filter((visit) => visit.status === status).length;
  const countAppointments = (status: Appointment["status"]) =>
    appointments.filter((appointment) => appointment.status === status).length;
  return {
    waiting: countVisits("waiting"),
    called: countVisits("called"),
    inChair: countVisits("in_chair"),
    done: countVisits("done"),
    expected: countAppointments("booked"),
    late: lateCount,
    noShow: countAppointments("no_show"),
    cancelled: countAppointments("cancelled"),
  };
}

/** الأطباء الظاهرون في اليوم (من زياراته ومواعيده) — قائمة المرشّح لا تعرض من لا مريض له اليوم. */
export function doctorsOfDay(
  visits: readonly Visit[],
  appointments: readonly Appointment[],
  doctors: readonly { id: number; name: string }[],
): { id: number; name: string }[] {
  const ids = new Set<number>();
  for (const visit of visits) if (visit.doctorId != null) ids.add(visit.doctorId);
  for (const appointment of appointments) if (appointment.doctorId != null) ids.add(appointment.doctorId);
  const named = doctors.filter((doctor) => ids.has(doctor.id));
  // طبيبٌ في اليوم بلا اسمٍ في القائمة (موقوف مثلًا) يبقى قابلًا للتصفية برقمه.
  for (const id of ids) if (!named.some((doctor) => doctor.id === id)) named.push({ id, name: `طبيب #${id}` });
  return named.sort((a, b) => a.name.localeCompare(b.name, "ar"));
}
