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

// ─── إعلانات الصالة المنظّمة — سجلٌّ لكل إعلان لا سطرٌ في خانة واحدة ─────────
//
// الخانة النصية الواحدة كانت تكفي ثلاثة إعلانات، ثم اصطدمت بجدارين: حدّ
// الإعداد الكلي (٤٠٠ حرف) يرفض عشرين إعلانًا برسالة «القيمة طويلة أكثر من
// اللازم»، ولا يمكن تعطيل إعلانٍ واحد أو ترتيبه إلا بإعادة كتابة الخانة كلها.
// فصار لكل إعلانٍ سجلّه: عنوانٌ ونصٌّ وترتيبٌ وتفعيل — ولكل سجلٍّ حدّه الخاص.

/** حدّ العنوان لكل إعلان — عنوان الشاشة يُقرأ من خمسة أمتار لا يُقرأ مسردلًا. */
export const MAX_ANNOUNCEMENT_TITLE_LENGTH = 80;
/** حدّ النص لكل إعلان — رسالة توعية لا مقالة. */
export const MAX_ANNOUNCEMENT_BODY_LENGTH = 300;
/**
 * سقف وقائي كبير لا حدٌّ صغير: يمنع مليون سطر من خطأ برمجي أو حلقة رسائل،
 * ولا يقف في وجه خمسين إعلانًا ولا مئة. الوصول إليه من الاستخدام اليدوي
 * الصادق شبه مستحيل — وهو لهذا موجود.
 */
export const MAX_ANNOUNCEMENTS_COUNT = 200;

/**
 * غسل نصّ الإعلان قبل تخزينه وعرضه.
 *
 * الإعلان يُعرض على تلفازٍ عام بلا يدٍّ تراجعه: محارف التحكّم والوسوم لا
 * مكان لها فيه. الوسوم تُنزع لأن العرض نصٌّ خالص (الإطار يهرّب أصلًا)، ونزعها
 * من المخزن يجعل ما في القاعدة هو ما على الشاشة — بلا سلاح مخفيّ يستيقظ يوم
 * يُعرض النص في سياقٍ آخر. ومحارف الاتجاه الخفيّة (RLM/LRM وأخواتها) تُنزع
 * لأنها طريقة معروفة لقلب معنى السطر على قارئٍ لا يراها.
 */
export function sanitizeAnnouncementText(raw: string): string {
  return raw
    // محارف التحكم C0/C1 والفواصل الصفرية ومحارف الاتجاه — بلا استثناء.
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    // وسوم HTML أينما وقعت — «<b>عاجل</b>» تُقرأ «عاجل».
    .replace(/<[^>]*>/g, "")
    // الفراغات المتكررة فراغٌ واحد، والأسطر الفارغة المتتالية سطرٌ واحد.
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** العنوان سطرٌ واحد دائمًا: سطرٌ ثانٍ في العنوان يكسر بطاقة الإعلان على الشاشة. */
function singleLine(text: string): string {
  return text.replace(/\n+/g, " ").trim();
}

export type CleanVerdict =
  | { ok: true; value: string }
  | { ok: false; message: string };

/** تنظيف عنوان إعلان وتحديه — الحدّ على النص بعد الغسل لأنه هو ما يُخزَّن. */
export function cleanAnnouncementTitle(raw: string): CleanVerdict {
  const title = singleLine(sanitizeAnnouncementText(raw));
  if (!title) return { ok: false, message: "اكتب عنوانًا للإعلان — لا يُحفظ إعلان بلا عنوان." };
  if (title.length > MAX_ANNOUNCEMENT_TITLE_LENGTH) {
    return { ok: false, message: `العنوان أطول من ${MAX_ANNOUNCEMENT_TITLE_LENGTH} حرفًا (الآن ${title.length}).` };
  }
  return { ok: true, value: title };
}

/** تنظيف نصّ إعلان وتحديه. */
export function cleanAnnouncementBody(raw: string): CleanVerdict {
  const body = sanitizeAnnouncementText(raw);
  if (!body) return { ok: false, message: "اكتب نصّ الإعلان — لا يُحفظ إعلان بلا نص." };
  if (body.length > MAX_ANNOUNCEMENT_BODY_LENGTH) {
    return { ok: false, message: `النص أطول من ${MAX_ANNOUNCEMENT_BODY_LENGTH} حرفًا (الآن ${body.length}).` };
  }
  return { ok: true, value: body };
}

export type AnnouncementInputVerdict =
  | { ok: true; value: { title: string; body: string } }
  | { ok: false; message: string };

/** تحدي إعلان جديد: العنوان والنص مطلوبان، مقصوصان، وبحديهما. */
export function validateAnnouncementInput(raw: {
  title?: unknown;
  body?: unknown;
}): AnnouncementInputVerdict {
  if (typeof raw.title !== "string" || typeof raw.body !== "string") {
    return { ok: false, message: "العنوان والنص مطلوبان." };
  }
  const title = cleanAnnouncementTitle(raw.title);
  if (!title.ok) return title;
  const body = cleanAnnouncementBody(raw.body);
  if (!body.ok) return body;
  return { ok: true, value: { title: title.value, body: body.value } };
}

/** ما يجوز تعديله في إعلانٍ قائم — كل حقلٍ مستقل، والحضور وحده يُحدَّث. */
export interface AnnouncementPatch {
  title?: string;
  body?: string;
  isActive?: boolean;
}

export type AnnouncementPatchVerdict =
  | { ok: true; value: AnnouncementPatch }
  | { ok: false; message: string };

/**
 * تحدي تعديلٍ جزئي: الحقل المُرسَل وحده يتغيّر والباقي يبقى كما كان. تعطيل
 * إعلانٍ (isActive وحده) لا يمرّ فوق العنوان والنص في كل مرة — فلا يمسّ «آخر
 * تعديل» ولا من عدّله بلا سبب.
 */
export function validateAnnouncementPatch(raw: {
  title?: unknown;
  body?: unknown;
  isActive?: unknown;
}): AnnouncementPatchVerdict {
  const patch: AnnouncementPatch = {};
  if (raw.title !== undefined) {
    if (typeof raw.title !== "string") return { ok: false, message: "العنوان نصٌّ لا غير." };
    const title = cleanAnnouncementTitle(raw.title);
    if (!title.ok) return title;
    patch.title = title.value;
  }
  if (raw.body !== undefined) {
    if (typeof raw.body !== "string") return { ok: false, message: "النص نصٌّ لا غير." };
    const body = cleanAnnouncementBody(raw.body);
    if (!body.ok) return body;
    patch.body = body.value;
  }
  if (raw.isActive !== undefined) {
    if (typeof raw.isActive !== "boolean") {
      return { ok: false, message: "حالة التفعيل true أو false." };
    }
    patch.isActive = raw.isActive;
  }
  if (patch.title === undefined && patch.body === undefined && patch.isActive === undefined) {
    return { ok: false, message: "لا يوجد ما يُحدَّث." };
  }
  return { ok: true, value: patch };
}

/** معرّف إعلان من مسارٍ ديناميكي — رقم صحيح موجب أو لا شيء. */
export function parseAnnouncementId(raw: unknown): number | null {
  const id = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** قائمة ترتيب كاملة: أرقام موجبة فريدة — تكرارٌ أو فراغٌ أو غريبٌ يُرفض. */
export function parseAnnouncementReorder(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const ids: number[] = [];
  for (const item of raw) {
    const id = parseAnnouncementId(item);
    if (id === null || ids.includes(id)) return null;
    ids.push(id);
  }
  return ids;
}

/**
 * قارئ الترحيلة: كل سطر «العنوان | النص» يصبح إعلانًا — بلا سقف العشرة.
 *
 * هذه للترحيلة من الخانة القديمة مرة واحدة، لا للعرض: غرضها ألّا يضيع
 * إعلانٌ واحد، فتقرأ كل السطور الصالحة مهما كثرت. السطر التالف (بلا فاصل أو
 * بنصٍّ فارغ) يتخطى كما كان يتخطى العرض القديم نفسه — فما لم يكن يُعرض
 * أمس لا تعنيه الترحيلة. والحدود الجديدة أوسع من القديمة (٨٠/٣٠٠ بعد
 * ٦٠/٢٠٠) فلا يُقطع نصٌّ سليم، والقصّ بقاءُ حارسٍ لقيمٍ كُتبت في القاعدة
 * يدًا خارجية.
 */
export function parseAnnouncementsForMigration(raw: string | null | undefined): Announcement[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  const list: Announcement[] = [];
  for (const line of text.split("\n")) {
    const cleaned = line.trim();
    if (!cleaned) continue;
    const separatorIndex = cleaned.indexOf(ANNOUNCEMENTS_SEPARATOR);
    if (separatorIndex <= 0) continue;
    const title = singleLine(sanitizeAnnouncementText(cleaned.slice(0, separatorIndex)));
    const body = sanitizeAnnouncementText(cleaned.slice(separatorIndex + ANNOUNCEMENTS_SEPARATOR.length));
    if (!title || !body) continue;
    list.push({
      title: title.slice(0, MAX_ANNOUNCEMENT_TITLE_LENGTH),
      body: body.slice(0, MAX_ANNOUNCEMENT_BODY_LENGTH),
    });
  }
  return list;
}
