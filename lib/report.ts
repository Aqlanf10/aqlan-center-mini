import { minutesSince, type Visit } from "./flow";
import { dayLoad, occupiesChair, type Appointment } from "./schedule";

/**
 * تقرير اليوم — المنطق الخالص.
 *
 * أول رقم صادق عن يوم في هذا المركز. اليوم يُقاس بالانطباع: «كان زحمة» أو «كان هادئًا»،
 * والانطباع لا يُبنى عليه قرار — لا في عدد الكراسي، ولا في ساعات الدوام، ولا في
 * الاعتذار لمريض انتظر ساعتين.
 *
 * والأرقام هنا مقصودة قليلة: تقرير من عشرين رقمًا لا يُقرأ آخر النهار. ستة أرقام
 * تُقرأ في نصف دقيقة وتُقال لمن سأل «كيف كان اليوم؟».
 */

export interface DayReport {
  arrived: number;
  done: number;
  stillOpen: number;
  noShow: number;
  cancelled: number;
  averageWaitMinutes: number;
  longestWaitMinutes: number;
  averageChairMinutes: number;
  booked: number;
  /** المحجوزون الذين لم يُسجَّل وصولهم ولم يُعلَّموا متغيّبين — العمل غير المُنهى. */
  unresolved: number;
}

/**
 * نهاية انتظار المريض.
 *
 * لحظة النداء لا لحظة الجلوس: من نُودي عليه انتهى انتظاره وإن مشى دقيقة إلى الكرسي.
 * ومن لم يُنادَ ولم يجلس ولم ينتهِ فما زال ينتظر الآن — وهو أهم من يُحسب، لأن
 * استبعاده يجعل متوسط الانتظار يبدو جميلًا في أسوأ الأيام.
 */
function waitEnd(visit: Visit, now: Date): number {
  const marker = visit.calledAt ?? visit.seatedAt ?? visit.finishedAt;
  return marker ? Date.parse(marker) : now.getTime();
}

function waitMinutes(visit: Visit, now: Date): number {
  const started = Date.parse(visit.arrivedAt);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((waitEnd(visit, now) - started) / 60_000));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

export function dayReport(visits: Visit[], appointments: Appointment[], now: Date): DayReport {
  const waits = visits.map((visit) => waitMinutes(visit, now));
  const chairMinutes = visits
    .filter((visit) => visit.seatedAt && visit.finishedAt)
    .map((visit) => Math.max(0, Math.floor(
      (Date.parse(visit.finishedAt as string) - Date.parse(visit.seatedAt as string)) / 60_000,
    )));

  return {
    arrived: visits.length,
    done: visits.filter((visit) => visit.status === "done").length,
    stillOpen: visits.filter((visit) => visit.status !== "done").length,
    noShow: appointments.filter((appointment) => appointment.status === "no_show").length,
    cancelled: appointments.filter((appointment) => appointment.status === "cancelled").length,
    averageWaitMinutes: average(waits),
    longestWaitMinutes: waits.length ? Math.max(...waits) : 0,
    averageChairMinutes: average(chairMinutes),
    booked: appointments.length,
    unresolved: appointments.filter((appointment) => appointment.status === "booked").length,
  };
}

/**
 * حِمل الغد مقابل طاقته.
 *
 * الرقم الوحيد في التقرير الذي ينظر إلى الأمام. معرفة أن الغد ممتلئ ٩٠٪ **الليلة**
 * تعني إعادة ترتيبه الليلة؛ ومعرفتها صباحًا تعني يومًا آخر منهارًا.
 */
export function tomorrowLoad(appointments: Appointment[], date: string, chairs: number) {
  return dayLoad(appointments.filter((a) => occupiesChair(a.status)), date, chairs);
}

/**
 * «موعد» / «موعدان» / «3 مواعيد» / «11 موعدًا».
 *
 * العربية تعدّ على أربع صيغ لا واحدة، و«3 موعدًا» على شاشة يقرأها الطبيب وموظفته كل
 * مساء تُقرأ كإهمال. القاعدة: الواحد والاثنان بلا رقم، والثلاثة إلى العشرة جمعًا،
 * وما فوقها مفردًا منصوبًا.
 */
/**
 * الدقائق بالعربية الصحيحة.
 *
 * كانت تُكتب «0 د» و«12 د» — اختصارٌ لا يقرؤه أحد بلا تخمين، ويبدو على شاشة يراها
 * الطاقم مئة مرة يوميًا كأنه رمزٌ برمجي تسرّب إلى الواجهة. والعربية لا تعدّ كما
 * تعدّ الإنجليزية: «١ دقيقة» و«٢ دقيقتان» و«٣ دقائق» و«١١ دقيقة».
 */
export function minutesText(minutes: number): string {
  const value = Math.max(0, Math.round(minutes));
  if (value === 0) return "لا انتظار";
  if (value === 1) return "دقيقة";
  if (value === 2) return "دقيقتان";
  if (value <= 10) return `${value} دقائق`;
  if (value < 60) return `${value} دقيقة`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  const hoursText = hours === 1 ? "ساعة" : hours === 2 ? "ساعتان" : hours <= 10 ? `${hours} ساعات` : `${hours} ساعة`;
  return rest === 0 ? hoursText : `${hoursText} و${rest} د`;
}

/** المدة كرقمٍ مختصر داخل بطاقة ضيّقة — لا يصلح للجُمل. */
export function shortMinutes(minutes: number): string {
  const value = Math.max(0, Math.round(minutes));
  if (value < 60) return `${value} دقيقة`;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")} ساعة`;
}

export function appointmentsCountText(count: number): string {
  if (count === 0) return "لا مواعيد";
  if (count === 1) return "موعد واحد";
  if (count === 2) return "موعدان";
  if (count <= 10) return `${count} مواعيد`;
  return `${count} موعدًا`;
}

/**
 * ملخص يُرسَل كما هو.
 *
 * التقرير الذي يبقى في الشاشة لا يصل إلى صاحب العيادة. النصّ مكتوب ليُنسخ في واتساب
 * ويُقرأ على الهاتف بلا جدول ولا ألوان.
 */
export function reportText(input: {
  clinicName: string;
  dateText: string;
  report: DayReport;
  tomorrowPercent: number;
  lateLabOrders: number;
}): string {
  const { report } = input;
  return [
    `${input.clinicName}`,
    `تقرير ${input.dateText}`,
    ``,
    `الحضور: ${report.arrived}`,
    `اكتملت زيارتهم: ${report.done}`,
    `لم يحضروا مواعيدهم: ${report.noShow}`,
    `متوسط الانتظار: ${report.averageWaitMinutes} د · أطوله: ${report.longestWaitMinutes} د`,
    `متوسط الوقت على الكرسي: ${report.averageChairMinutes} د`,
    ``,
    `حِمل الغد: ${input.tomorrowPercent}٪ من الطاقة`,
    `تراكيب متأخرة: ${input.lateLabOrders}`,
  ].join("\n");
}
