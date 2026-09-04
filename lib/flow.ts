/**
 * انسياب يوم العيادة — المنطق الخالص.
 *
 * هذه الأداة وُجدت لسبب واحد: مركز بكرسيين، والمرضى ينتظرون ساعات ولا أحد في العيادة
 * يعرف الرقم الحقيقي — كم واحدًا ينتظر، ومنذ متى، وهل الكرسي فارغ الآن. النظام الأساسي
 * يملك هذه القدرات لكنه لم يدخل الخدمة بعد، فهذه أداة مؤقتة مهمتها أن تُستخدم صباح الغد.
 *
 * الحساب هنا منفصل عن الواجهة لأنه الجزء الذي يجب أن يكون صحيحًا: وقت انتظار يُعرض أقل
 * من حقيقته بخمس دقائق أسوأ من عدم عرضه أصلًا — لأنه يقول لموظفة الاستقبال إن المريض
 * الجالس أمامها ليس منتظرًا فعلًا.
 */

/**
 * حالات الزيارة.
 *
 * `called` أُضيفت لأجل شاشة النداء: كان المريض ينتقل من الانتظار إلى الكرسي مباشرة،
 * فلحظة النداء — وهي بالضبط ما تعرضه الشاشة في الصالة — لم تكن مسجّلة في أي مكان.
 * المفردات نفسها الموجودة في النظام الأساسي (Waiting / Called / InRoom) ليطابق الترحيل.
 */
export type VisitStatus = "waiting" | "called" | "in_chair" | "done";

export interface Visit {
  id: number;
  /** سجل المريض إن كانت الزيارة مرتبطة به. المريض المشي يبقى بلا سجل حتى يُحجز له. */
  patientId: number | null;
  patientName: string;
  patientPhone: string | null;
  note: string | null;
  status: VisitStatus;
  chair: number | null;
  arrivedAt: string;
  seatedAt: string | null;
  calledAt: string | null;
  finishedAt: string | null;
  /**
   * موعدها الأصلي إن جاءت من حجز — به تعرف شاشة الصالة وقت الموعد الأصلي الذي
   * انتظره المريض، فتعرض «10:45» لا ساعة وصوله الفعلية وحدها.
   */
  appointmentId?: number | null;
  /** جهة الطبيب المعالج للزيارة (لحساب العمولات والمتابعة السريرية). */
  doctorId?: number | null;
}

/** بعد هذا الحد يكون المريض قد لاحظ الانتظار. */
export const WAIT_WARNING_MINUTES = 15;
/** وبعد هذا الحد صار يحكي عنه لغيره. */
export const WAIT_CRITICAL_MINUTES = 30;

export type WaitLevel = "calm" | "warning" | "critical";

export function waitLevel(minutes: number): WaitLevel {
  if (minutes >= WAIT_CRITICAL_MINUTES) return "critical";
  if (minutes >= WAIT_WARNING_MINUTES) return "warning";
  return "calm";
}

/**
 * الدقائق المنقضية منذ لحظة، وأدناها صفر.
 *
 * الطوابع الزمنية كلها UTC، والفرق بين لحظتين لا يحمل منطقة زمنية — فهذا الحساب الوحيد
 * في الأداة الذي لا يستطيع فارق توقيت اليمن (UTC+3) أن يفسده. وإن سبق ختمُ الوقت الساعةَ
 * لانحراف بسيط في ساعة الجهاز، يُقرأ صفرًا لا رقمًا سالبًا.
 */
export function minutesSince(iso: string | null | undefined, now: Date): number {
  if (!iso) return 0;
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((now.getTime() - started) / 60_000));
}

export interface WaitingRow {
  visit: Visit;
  waitedMinutes: number;
  level: WaitLevel;
}

/**
 * المنتظرون مرتبين بالأطول انتظارًا أولًا — وهو ترتيب النداء الصحيح.
 *
 * الترتيب بالأطول انتظارًا لا بوقت الوصول يعطي النتيجة نفسها اليوم، لكنه يبقى صحيحًا
 * لو أُضيف مريض بأثر رجعي بوقت وصول أقدم — وهو ما يحدث فعلًا حين تُدخل الاستقبال
 * مريضًا تأخرت في تسجيله.
 */
export function waitingRows(visits: Visit[], now: Date): WaitingRow[] {
  return visits
    .filter((visit) => visit.status === "waiting")
    .map((visit) => {
      const waitedMinutes = minutesSince(visit.arrivedAt, now);
      return { visit, waitedMinutes, level: waitLevel(waitedMinutes) };
    })
    .sort((a, b) => b.waitedMinutes - a.waitedMinutes);
}

export interface ChairRow {
  chair: number;
  occupant: Visit | null;
  /** من نُودي عليه إلى هذا الكرسي ولم يجلس بعد. */
  calledFor: Visit | null;
  busyMinutes: number;
}

/**
 * حالة كل كرسي، مشغولًا كان أو فارغًا.
 *
 * الكراسي تأتي من عددها المُهيّأ لا ممن يجلس عليها، حتى يظهر الكرسي الفارغ كفارغ. وهذا
 * هو بيت القصيد حين يكون هناك منتظرون: كرسي شاغر لم ينتبه إليه أحد هو أرخص دقيقة
 * يمكن استرجاعها في العيادة.
 */
export function chairRows(chairCount: number, visits: Visit[], now: Date): ChairRow[] {
  const seated = visits.filter((visit) => visit.status === "in_chair");
  const called = visits.filter((visit) => visit.status === "called");
  return Array.from({ length: chairCount }, (_, index) => {
    const chair = index + 1;
    const occupant = seated.find((visit) => visit.chair === chair) ?? null;
    const calledFor = occupant ? null : called.find((visit) => visit.chair === chair) ?? null;
    return {
      chair,
      occupant,
      calledFor,
      busyMinutes: occupant ? minutesSince(occupant.seatedAt, now) : 0,
    };
  });
}

/**
 * الكراسي غير المتاحة للنداء: المشغولة، والمحجوزة لمريض نُودي عليه ولم يصل بعد.
 *
 * حجز الكرسي لحظةَ النداء هو الفرق بين «نظام نداء» و«شاشة تعرض أسماء»: بين نداء
 * المريض وجلوسه دقيقة يمشي فيها من الصالة، ولو بقي الكرسي محسوبًا فارغًا لنودي عليه
 * مريض ثانٍ في تلك الدقيقة — فيصل اثنان إلى كرسي واحد أمام الجميع.
 */
function heldChairs(visits: Visit[]): Set<number> {
  const held = new Set<number>();
  for (const visit of visits) {
    if (visit.chair === null) continue;
    if (visit.status === "in_chair" || visit.status === "called") held.add(visit.chair);
  }
  return held;
}

/** أول كرسي فارغ، أو null إن كان الكرسيان مشغولين. */
export function firstFreeChair(chairCount: number, visits: Visit[]): number | null {
  const taken = heldChairs(visits);
  for (let chair = 1; chair <= chairCount; chair += 1) {
    if (!taken.has(chair)) return chair;
  }
  return null;
}

export interface DaySummary {
  waiting: number;
  called: number;
  inChair: number;
  done: number;
  longestWaitMinutes: number;
  freeChairs: number;
}

export function daySummary(chairCount: number, visits: Visit[], now: Date): DaySummary {
  const waiting = waitingRows(visits, now);
  const inChair = visits.filter((visit) => visit.status === "in_chair").length;
  // الكرسي المحجوز لمريض نُودي عليه ليس فارغًا: لو حُسب فارغًا لظهر تنبيه «كرسي فارغ
  // ومريض ينتظر» في كل مرة يُنادى فيها مريض — والتنبيه الذي يكذب يُتجاهَل ثم يُطفَأ.
  const held = heldChairs(visits);
  return {
    waiting: waiting.length,
    called: visits.filter((visit) => visit.status === "called").length,
    inChair,
    done: visits.filter((visit) => visit.status === "done").length,
    longestWaitMinutes: waiting[0]?.waitedMinutes ?? 0,
    freeChairs: Math.max(0, chairCount - held.size),
  };
}


/**
 * من نُودي عليه ولم يجلس بعد — وهو ما تعرضه شاشة الصالة.
 *
 * الأحدث أولًا: المريض الذي نُودي عليه الآن هو من يبحث عن اسمه على الشاشة، لا من
 * نُودي عليه قبل ربع ساعة.
 */
export function calledVisits(visits: Visit[]): Visit[] {
  return visits
    .filter((visit) => visit.status === "called")
    .sort((a, b) => (b.calledAt ?? "").localeCompare(a.calledAt ?? ""));
}

/**
 * الاسم الأول وحده.
 *
 * الشاشة معلّقة في صالة يراها كل مريض ومرافق. الاسم الكامل مع رقم الهاتف في النظام
 * يجعل الشاشة سجلًا عامًا لمرضى العيادة؛ والاسم الأول يكفي ليعرف صاحبه أنه المقصود،
 * وهو ما يُنادى به صوتًا في الصالة أصلًا.
 */
export function firstNameOnly(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[0] || fullName;
}
