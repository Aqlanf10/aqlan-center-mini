/**
 * شاشة الصالة — المنطق الخالص.
 *
 * شاشة النداء الأولى كانت تقول «من نُودي عليه» فقط، وكانت تكفي يومًا فيه مريضان.
 * يومٌ فيه اثنا عشر مريض تقويم يحتاج أكثر من ذلك: من هو في الدور الآن، ومن أمامه
 * من، وكم انتظار اليوم في المتوسط — بلا أن يخرج من الشاشة ما لا يجوز أن يراه كل
 * من في الصالة.
 *
 * القاعدة التي تحكم هذا الملف: **كل ما يُعرض على التلفاز يُحسب هنا ويُخفى هنا**.
 * الاسم يُقنَّع على الخادم لا في الواجهة، والهاتف والتشخيص والحساب لا يعبرون هذا
 * الملف أصلًا — فلو فتح أحد أدوات المتصفح على التلفاز لم يجد شيئًا يستحق الحفظ.
 */

import type { Visit } from "./flow";
import type { Appointment } from "./schedule";

/**
 * طريقتان لعرض الاسم على شاشة يراها الجميع.
 *
 * `first_initial` هو الافتراضي: «أحمد م.» تعرفه الأسرة التي انتظرته، ولا تعرفه
 * بقية الصالة. و`first_only` يبقى متاحًا للمركز الذي يفضّل الاختصار الأقصى.
 */
export type PrivacyMode = "first_initial" | "first_only";

export function maskName(fullName: string, mode: PrivacyMode): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? fullName;
  if (mode === "first_only" || parts.length === 1) return first;
  // أول حرف من الاسم الأخير كما كُتب — «أحمد ش.» لا «أحمد ش» بلا نقطة، فالنقطة
  // هي ما يقول للمريض أن هذا اختصار لا اسم ناقص. و«ال» التعريف تتجاوز: «الشرعبي»
  // حرفها الأول أل لا يقرؤه أحد، و«أحمد ش.» هو ما تكتبه يد الإنسان.
  const last = parts[parts.length - 1]!;
  const meaningful = last.startsWith("ال") && last.length > 2 ? last.slice(2) : last;
  return `${first} ${meaningful.charAt(0)}.`;
}

/**
 * عبارة الدور كما يقرأها المريض الجالس، لا كما يخزّنها الحاسوب.
 *
 * العربية تثنّي وتجمع: «مريضان» لا «2 مريض»، و«مرضى» للثلاثة إلى العشرة،
 * و«مريضًا» لما بعد الحادي عشر. عبارة مكسورة على شاشةٍ يقرؤها اثنا عشر مريضًا
 * تقول إن النظام هوايةٌ مستوردة.
 */
export function positionPhrase(ahead: number): string {
  if (ahead <= 0) return "الدور القادم";
  if (ahead === 1) return "أمامك مريض واحد";
  if (ahead === 2) return "أمامك مريضان";
  const tens = ahead % 100;
  if (tens >= 3 && tens <= 10) return `أمامك ${ahead} مرضى`;
  return `أمامك ${ahead} مريضًا`;
}

/** «10:45» → «10:45 ص» — صيغة موحّدة لصفوف القائمة على الشاشة. */
export function compactTime12(time: string): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(time.trim());
  if (!match) return time;
  const hour = Number(match[1]);
  const minute = match[2];
  const period = hour < 12 ? "ص" : "م";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${minute} ${period}`;
}

/** لحظة وصول (UTC) إلى ساعة العيادة «HH:MM» — ثم تُمرَّر على الصيغة المضغوطة. */
export function clockTimeInZone(iso: string, timeZone: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "";
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(parsed));
  return formatted;
}

export interface QueueRow {
  /** الاسم مُقنَّعًا بطريقة الخصوصية المختارة — قبل أن يترك الخادم أصلًا. */
  name: string;
  timeText: string;
  /** `arrived` وصل وسيتصف الانتظار، و`upcoming` موعده اليوم ولم يصل بعد. */
  status: "arrived" | "upcoming";
  /** عبارة الدور للواصلين فقط — للقادمين موعدٌ لا دور. */
  position: string | null;
}

export interface WaitingRoomQueueInput {
  visits: Visit[];
  appointments: Appointment[];
  now?: Date;
  privacy: PrivacyMode;
  timeZone: string;
  /** أقصى صفوف واصلين تُعرض قبل أن يُكتفى بعدّهم في البطاقة العلوية. */
  maxWaitingRows?: number;
  /** أقصى صفوف في الجدول كله. */
  maxRows?: number;
}

/**
 * جدول «القادمون» كما يُعرض على التلفاز.
 *
 * الواصلون أولًا بترتيب الوصول — فهم من سيُنادى عليهم — ثم مواعيد اليوم التي لم
 * تصل بعد بترتيب وقتها. المُنادى عليهم والجالسون والمنتهون لا يُعرضون: دورهم انتهى
 * في القائمة، وحالتهم تُقرأ من بطاقة النداء والكراسي.
 */
export function waitingRoomQueue(input: WaitingRoomQueueInput): QueueRow[] {
  const maxWaitingRows = Math.max(0, input.maxWaitingRows ?? 6);
  const maxRows = Math.max(1, input.maxRows ?? 8);

  const appointmentById = new Map(input.appointments.map((a) => [a.id, a]));
  const waiting = input.visits
    .filter((visit) => visit.status === "waiting")
    .sort((a, b) => a.arrivedAt.localeCompare(b.arrivedAt));

  const arrivedRows: QueueRow[] = waiting.map((visit, index) => {
    const appointment = visit.appointmentId ? appointmentById.get(visit.appointmentId) : undefined;
    const time = appointment?.scheduledTime ?? clockTimeInZone(visit.arrivedAt, input.timeZone);
    return {
      name: maskName(visit.patientName, input.privacy),
      timeText: compactTime12(time),
      status: "arrived" as const,
      position: positionPhrase(index),
    };
  });

  const upcomingRows: QueueRow[] = input.appointments
    .filter((appointment) => appointment.status === "booked")
    .sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime))
    .map((appointment) => ({
      name: maskName(appointment.patientName, input.privacy),
      timeText: compactTime12(appointment.scheduledTime),
      status: "upcoming" as const,
      position: null,
    }));

  // الواصلون حتى السقف، ثم يُكمَّل الباقي بالقادمين — فالموعدُ الذي لم يصل لا
  // يزيح من سبقه إلى الانتظار، لكنه يظهر حين يتّسع الجدول.
  const arrived = arrivedRows.slice(0, maxWaitingRows);
  const remaining = Math.max(0, maxRows - arrived.length);
  return [...arrived, ...upcomingRows.slice(0, remaining)];
}

/**
 * متوسط الانتظار الفعلي اليوم: من لحظة الوصول إلى لحظة النداء.
 *
 * هذا هو الرقم الذي يعرف الإدارة من خلاله إن كان الانتظار مشكلة فعلية أم انطباعًا.
 * يُحسب من الزيارات التي نُودي عليها فعلًا اليوم، ويُقرَّب لعددٍ صحيح، ويُعاد
 * `null` حين لا يوجد قياس — فـ«صفر دقيقة» كذبة، و«—» صدق.
 */
export function averageWaitMinutes(visits: Visit[]): number | null {
  const waits = visits
    .filter((visit) => visit.calledAt !== null)
    .map((visit) => {
      const arrived = Date.parse(visit.arrivedAt);
      const called = visit.calledAt ? Date.parse(visit.calledAt) : NaN;
      if (Number.isNaN(arrived) || Number.isNaN(called)) return null;
      return Math.max(0, called - arrived) / 60_000;
    })
    .filter((value): value is number => value !== null);
  if (waits.length === 0) return null;
  return Math.round(waits.reduce((total, value) => total + value, 0) / waits.length);
}

export interface OrthoSessionsSummary {
  total: number;
  done: number;
  waiting: number;
  upcoming: number;
}

/**
 * جلسات التقويم اليوم: مجموعها الثلاثة لا الرابع.
 *
 * شدّ التقويم يُعرَف من نوع الموعد (متابعة/شد) أو من كون المريض له حالة تقويم
 * قائمة. الملغى ومن لم يحضر لا يُعدّان في المجموع — الرقم الذي يقرؤه المرضى على
 * الشاشة يجب أن تجمع أجزاؤه، وإلا صار شريطًا يقول أرقامًا لا يصدّقها أحد.
 */
export function orthoSessionsToday(
  appointments: Appointment[],
  orthoPatientIds: number[],
): OrthoSessionsSummary | null {
  const orthoPatients = new Set(orthoPatientIds);
  const sessions = appointments.filter(
    (appointment) =>
      appointment.status !== "cancelled" &&
      appointment.status !== "no_show" &&
      (appointment.appointmentType === "follow_up" || orthoPatients.has(appointment.patientId)),
  );
  if (sessions.length === 0) return null;
  return {
    total: sessions.length,
    done: sessions.filter((s) => s.status === "done").length,
    waiting: sessions.filter((s) => s.status === "arrived").length,
    upcoming: sessions.filter((s) => s.status === "booked").length,
  };
}

export interface Announcement {
  title: string;
  body: string;
}

/**
 * الإعلانات الافتراضية — تبدأ بها الشاشة قبل أن يضبط المالك شيئًا.
 *
 * نصوصها من جوهر مركز تقويم: المطاط، وتغيير رقم الهاتف، وخدمات المركز. وتُكتب
 * في الإعداد سطرًا لكل إعلان بصيغة «العنوان | النص» — صيغة يكتبها غير المبرمج
 * من شاشة الإعدادات بلا قوسين ولا فواصل.
 */
export const DEFAULT_ANNOUNCEMENTS: Announcement[] = [
  { title: "العناية بعد التقويم", body: "الالتزام بالمطاط حسب تعليمات الطبيب يسرّع تقدم العلاج." },
  { title: "تذكير", body: "يرجى إبلاغ الاستقبال بأي تغيير في رقم الهاتف." },
  { title: "خدمات المركز", body: "تقويم الأسنان • زراعة الأسنان • تجميل الأسنان • التركيبات الرقمية" },
];

/** كيف يُخزَّن الإعداد: سطر لكل إعلان، والفاصل الأول يفصل العنوان عن النص. */
export const ANNOUNCEMENTS_SEPARATOR = "|";

export function formatAnnouncements(list: Announcement[]): string {
  return list
    .map((item) => `${item.title} ${ANNOUNCEMENTS_SEPARATOR} ${item.body}`)
    .join("\n");
}

/**
 * يقرأ الإعداد المخزَّن ويسقط بسلاسة إلى الافتراضي.
 *
 * سطر تالف — بلا فاصل، أو أطول من حده — يُتخطى لا يُسقط البقية: إعلانٌ كُتب
 * مساءً بخطأ واحد لا يجعل الشاشة صباحًا بلا نصوص تُعرض.
 */
export function parseAnnouncements(raw: string | null | undefined): Announcement[] {
  const text = (raw ?? "").trim();
  if (!text) return DEFAULT_ANNOUNCEMENTS;
  const list: Announcement[] = [];
  for (const line of text.split("\n")) {
    const cleaned = line.trim();
    if (!cleaned) continue;
    const separatorIndex = cleaned.indexOf(ANNOUNCEMENTS_SEPARATOR);
    if (separatorIndex <= 0) continue;
    const title = cleaned.slice(0, separatorIndex).trim();
    const body = cleaned.slice(separatorIndex + ANNOUNCEMENTS_SEPARATOR.length).trim();
    if (!title || !body || title.length > 60 || body.length > 200) continue;
    list.push({ title, body });
    if (list.length >= 10) break;
  }
  return list.length > 0 ? list : DEFAULT_ANNOUNCEMENTS;
}

/** شعار الشاشة الثابت أسفلها — قابل للتغيير من الإعدادات، لكن له وجهٌ واحد. */
export const DEFAULT_TAGLINE = "ابتسامتك تستحق أفضل عناية";
