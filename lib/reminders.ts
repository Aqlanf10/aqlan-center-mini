import type { Appointment } from "./schedule";

/**
 * تذكير المريض عبر واتساب.
 *
 * سبب وجود هذا الملف بكلمات المالك: «تتشوه سمعتنا أنه ما في أي اهتمام ولا تواصل».
 * وهذه ليست مشكلة برمجية معقدة — إنها رسالة لم تُرسَل.
 *
 * واتساب عبر رابط `wa.me` لا عبر واجهة برمجية: بلا اشتراك ولا مفاتيح ولا تكلفة ولا
 * موافقة مزوّد. النظام الأساسي فيه خدمة رسائل كاملة خلف بوابة `IsConfigured` — وإن لم
 * تُضبط مفاتيحها لا تُرسل رسالة واحدة **بصمت**، وهو أحد أسباب شكوى المرضى أصلًا.
 * الرابط هنا لا يستطيع أن يفشل صامتًا: إما يفتح واتساب أمام الموظفة أو لا يفتح.
 */

/**
 * يحوّل الرقم اليمني إلى الصيغة الدولية التي يقبلها واتساب.
 *
 * أرقام اليمن تُكتب محليًا `770245745` أو `0770245745`، وواتساب يريد `967770245745`.
 * إرسال الرقم المحلي كما هو يفتح محادثة مع رقم خاطئ في بلد آخر — وهو أسوأ من عدم
 * الإرسال، لأن الموظفة تظن أنها ذكّرت المريض.
 */
export function toWhatsAppNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  // الأرقام العربية الهندية تصل من لوحات مفاتيح الهواتف، وتحويلها أولًا يمنع رفض رقم صحيح.
  const western = phone.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  const digits = western.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("967")) return digits.length >= 11 ? digits : null;
  const local = digits.replace(/^0+/, "");
  // الجوال اليمني تسعة أرقام ويبدأ بـ7؛ والأرضي أقصر ولا يصلح لواتساب.
  if (local.length === 9 && local.startsWith("7")) return `967${local}`;
  return null;
}

export interface ClinicIdentity {
  name: string;
  phone: string;
}

export const DEFAULT_CLINIC: ClinicIdentity = {
  name: "مركز الدكتور عقلان الكامل لتقويم وزراعة وتجميل الأسنان",
  phone: "04-253028",
};

const WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

/** «الخميس 27/08» — يوم الأسبوع أولًا لأنه ما يتذكره المريض، لا رقم التاريخ. */
export function friendlyDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  const day = WEEKDAYS[parsed.getDay()];
  return `${day} ${String(parsed.getDate()).padStart(2, "0")}/${String(parsed.getMonth() + 1).padStart(2, "0")}`;
}

/** «10:00» → «10:00 صباحًا» — الصيغة التي يقرأها المريض بلا حساب. */
export function friendlyTime(time: string): string {
  const [rawHour, minute] = time.split(":");
  const hour = Number(rawHour);
  if (!Number.isFinite(hour)) return time;
  const period = hour < 12 ? "صباحًا" : "مساءً";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${minute} ${period}`;
}

/**
 * «الخميس 27/08/2026» — بالسنة، للتاريخ لا للتذكير.
 *
 * رسالة التذكير تتحدث عن موعد هذا الأسبوع فالسنة فيها ضجيج. أما ملف مريض تقويم بعد
 * عامين ففيه زيارات من سنتين، و«27/08» وحدها لا تقول أيّهما.
 */
export function friendlyDateLong(date: string): string {
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return `${friendlyDate(date)}/${parsed.getFullYear()}`;
}

export type ReminderKind = "upcoming" | "missed";

/**
 * نص الرسالة.
 *
 * مكتوبة كما يكتبها إنسان: تحية، ثم الموعد، ثم باب مفتوح للتأجيل. الجملة الأخيرة
 * مقصودة — المريض الذي يستطيع قول «لا أستطيع» يعتذر مسبقًا بدل أن يتغيّب، فيتحرر
 * الكرسي لغيره. ورسالة المتغيّب لا تلومه: اللوم يفقدك المريض نهائيًا.
 */
export function reminderText(
  appointment: Appointment,
  kind: ReminderKind,
  clinic: ClinicIdentity = DEFAULT_CLINIC,
): string {
  const when = `${friendlyDate(appointment.scheduledDate)} الساعة ${friendlyTime(appointment.scheduledTime)}`;
  const name = appointment.patientName;

  if (kind === "missed") {
    return [
      `السلام عليكم ${name}،`,
      ``,
      `افتقدناكم في موعدكم ${when} في ${clinic.name}.`,
      `نأمل أن يكون المانع خيرًا، ونود ترتيب موعد جديد يناسبكم.`,
      ``,
      `للتواصل: ${clinic.phone}`,
    ].join("\n");
  }

  return [
    `السلام عليكم ${name}،`,
    ``,
    `نذكّركم بموعدكم في ${clinic.name}:`,
    `${when}`,
    ``,
    `إن كان الموعد لا يناسبكم، أخبرونا لنؤجله — مكانكم محفوظ.`,
    `للتواصل: ${clinic.phone}`,
  ].join("\n");
}

/** رابط واتساب جاهز، أو null إن كان الرقم لا يصلح. */
export function whatsAppLink(
  appointment: Appointment,
  kind: ReminderKind,
  clinic: ClinicIdentity = DEFAULT_CLINIC,
): string | null {
  const number = toWhatsAppNumber(appointment.patientPhone);
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(reminderText(appointment, kind, clinic))}`;
}

/* ─────────────── رسائل جلسات التقويم — السلسلة المغلقة ─────────────── */

/**
 * رسائل التقويم الأربع، بصياغة المالك نفسه:
 *
 * عند الحجز: «تم تأكيد موعد جلسة التقويم القادمة لدى المركز يوم…» — الموعد
 * الجديد يُختم في ذهن المريض لحظة حجزه لا بعد أيام.
 *
 * بعد الجلسة: «سعدنا بزيارتكم اليوم، وتمت جلسة المتابعة بنجاح. موعدكم القادم…»
 * — المريض يخرج من العيادة والرسالة فيه، والموعد القادم مكتوبٌ في جواله لا
 * في ورقةٍ تضيع.
 *
 * وقبل الموعد ولمَ لم يحضر: تُستعمل رسالتا التذكير والغياب العامّتان أعلاه —
 * فصياغتهما تناسب التقويم بلا تغيير.
 */

/** رسالة تأكيد الحجز — تُعرض بعد حفظ الشدّة وحجز الجلسة القادمة مباشرة. */
export function orthoSessionBookedText(input: {
  patientName: string;
  whenText: string;
  clinic: ClinicIdentity;
}): string {
  return [
    `السلام عليكم ${input.patientName}،`,
    ``,
    `تم تأكيد موعد جلسة التقويم القادمة لدى ${input.clinic.name}:`,
    `${input.whenText}`,
    ``,
    `إلى اللقاء، وإن كان الوقت لا يناسبكم أخبرونا لنغيّره — مكانكم محفوظ.`,
    `للتواصل: ${input.clinic.phone}`,
  ].join("\n");
}

/** رسالة ما بعد الجلسة — الموعد القادم فيها لا يضيع لأنه في الجوال لا في الذاكرة. */
export function orthoAfterSessionText(input: {
  patientName: string;
  nextWhenText: string | null;
  clinic: ClinicIdentity;
}): string {
  const lines = [
    `السلام عليكم ${input.patientName}،`,
    ``,
    `سعدنا بزيارتكم اليوم، وتمت جلسة المتابعة بنجاح.`,
  ];
  if (input.nextWhenText) {
    lines.push(`موعدكم القادم: ${input.nextWhenText}`);
    lines.push(``);
    lines.push(`إن كان الموعد لا يناسبكم أخبرونا لنغيّره — مكانكم محفوظ.`);
  } else {
    lines.push(`سنتواصل معكم لتحديد موعد المتابعة القادمة في وقته.`);
  }
  lines.push(``);
  lines.push(`للتواصل: ${input.clinic.phone}`);
  return lines.join("\n");
}

/**
 * قاعدة «لا رسالة مكررة خلال ١٢ ساعة» — دستور المنطقة الأولى.
 *
 * ضغطة مزدوجة على الرابط تُرسل رسالتين متتاليتين لمريضٍ واحد، ورسالتان في دقيقتين
 * تقولان للمريض إن العيادة روبوت. فالواجهة تسأل قبل الثانية: هل مرّت ١٢ ساعة على
 * آخر تذكير؟ ما مرّت فالضغطة تحتاج تأكيدًا صريحًا («أرسل رغم ذلك») — القاعدة تحمي
 * المريض، والتجاوز اليدوي يحمي الموظفة حين يطلب المريض التذكير بنفسه بعد ساعة.
 *
 * نقيّة بلا ساعة ولا شبكة: تُختبر بالكلمة لا بالانتظار.
 */
export const REMINDER_REPEAT_WINDOW_MS = 12 * 60 * 60 * 1000;

export function reminderNeedsOverride(sentAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!sentAt) return false;
  const sent = Date.parse(sentAt);
  if (!Number.isFinite(sent)) return false;
  return now - sent < REMINDER_REPEAT_WINDOW_MS;
}
