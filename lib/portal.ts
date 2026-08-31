import { createHmac, timingSafeEqual } from "node:crypto";
import { samePhone } from "./duplicates";

/**
 * بوابة المريض — المنطق الخالص وجلسة معزولة.
 *
 * معيارا القبول في الدستور للمرحلة ١١:
 *  ١) **عزل كامل لصلاحيات بوابة المريض عن بيانات المركز الداخلية** — لا توحيد بين
 *     جلسة المريض وجلسة الطاقم إطلاقًا: كوكي باسم آخر، وتوقيع بمجال منفصل
 *     (Domain Separation)، وأي توكن من جهة لا يُقرأ من الأخرى ولو تسرب.
 *  ٢) **اعتماد نفس مصدر الحقيقة لقاعدة بيانات المريض** — كشف الحساب في البوابة
 *     يستدعي `patientLedger()` نفسها التي تخدم شاشة المريض الداخلية، فلا يُبنى
 *     استعلام موازٍ فيظهر رقم في البوابة وآخر في الصندوق.
 *
 * ولماذا لا كلمة مرور؟ مريض عيادة بكرسيين لا يملك حسابًا يُدار ولا بريدًا يُوثَّق.
 * العاملان اللذان يملكهما المريض الحقيقي حصريًا — تقريبًا — هما رقم هاتفه ورقم
 * ملفه الذي أعطته إياه العيادة. مزاوجتهما مع حد لمحاولات الدخول يوفر ما يكفي
 * لبوابة تُرى ولا تدفع ولا تُعدّل: قراءةٌ للحساب ومواعيد، وتأكيدٌ حضور،
 * واستمارةٌ تعود للطاقم لا للمريض.
 */

export const PORTAL_COOKIE = "aqlan_portal_session";
/**
 * بوابة تُفتح أسبوعًا لا شهرًا: الجلسة الطويلة نافذةٌ مفتوحة على حساب المريض
 * ومواعيده لمن يظفر بجهازه، وسبعة أيام تغطي دورة المتابعة بين زيارتين وتُبقي
 * ما يفقده المريض من انقطاعٍ في حدّ الكلفة صفر — يعيد الدخول بعاملين يعرفهما.
 */
export const PORTAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export interface PortalPayload {
  patientId: number;
  patientNumber: string;
  fullName: string;
  expiresAt: number;
}

function portalSecret(): string {
  const value = process.env.SESSION_SECRET;
  // نفس قاعدة جلسة الطاقم: بلا سرّ لا يوجد توقيع، فالانهيار مقصود.
  if (!value || value.length < 32) {
    throw new Error("SESSION_SECRET مفقود أو قصير — يجب ألا يقل عن 32 حرفًا.");
  }
  return `portal:${value}`;
}

function portalSign(body: string): string {
  return createHmac("sha256", portalSecret()).update(body).digest("base64url");
}

/** توكن موقّع بمجال البوابة — لا يفتح أي مسار طاقم ولو كان صالحًا. */
export function createPortalToken(payload: PortalPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${portalSign(body)}`;
}

export function readPortalToken(token: string | undefined): PortalPayload | null {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = portalSign(body);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as PortalPayload;
    if (typeof payload.expiresAt !== "number" || payload.expiresAt < Date.now()) return null;
    if (typeof payload.patientId !== "number" || !payload.patientNumber) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── تسجيل الدخول ─────────────────────────────────────────────────────────────

export interface PortalLoginInput {
  phone: string;
  patientNumber: string;
}

export type PortalLoginValidation =
  | { ok: true; value: PortalLoginInput }
  | { ok: false; message: string };

/** أقل ما يُعد هاتفًا — والهاتف هو العامل الأول للمطابقة. */
const MIN_PHONE_DIGITS = 9;

export function validatePortalLogin(raw: unknown): PortalLoginValidation {
  const source = (raw ?? {}) as Record<string, unknown>;
  const phone = typeof source.phone === "string" ? source.phone.trim() : "";
  const patientNumber = typeof source.patientNumber === "string" ? source.patientNumber.trim() : "";
  if (phone.replace(/\D/g, "").length < MIN_PHONE_DIGITS) {
    return { ok: false, message: "أدخل رقم هاتف صحيحًا." };
  }
  if (!patientNumber || patientNumber.length > 20) {
    return { ok: false, message: "أدخل رقم الملف كما أُعطي لك." };
  }
  return { ok: true, value: { phone, patientNumber } };
}

/** مطابقة زوج (هاتف، رقم ملف) على مريض — إعادة استخدام منطق الهاتف نفسه. */
export function portalCredentialsMatch(
  patient: { patientNumber: string; phone: string | null; altPhone: string | null },
  phone: string,
  patientNumber: string,
): boolean {
  const given = patientNumber.trim().toUpperCase();
  const stored = patient.patientNumber.trim().toUpperCase();
  if (given !== stored) return false;
  return samePhone(patient.phone, phone) || samePhone(patient.altPhone, phone);
}

// ── حد محاولات الدخول ────────────────────────────────────────────────────────

/** خمس محاولات خاطئة على الهاتف نفسه في ربع ساعة = إغلاق حتى منتصف النافذة. */
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export function loginLocked(
  failureTimestamps: number[],
  now: number,
): { locked: boolean; retryAfterSeconds: number } {
  const recent = failureTimestamps.filter((time) => now - time < LOGIN_WINDOW_MS);
  if (recent.length < LOGIN_MAX_FAILURES) return { locked: false, retryAfterSeconds: 0 };
  const oldest = Math.min(...recent);
  return { locked: true, retryAfterSeconds: Math.ceil((LOGIN_WINDOW_MS - (now - oldest)) / 1000) };
}

// ── تأكيد الحضور ─────────────────────────────────────────────────────────────

/** ما بعد ثلاثين يومًا تأكيدُه بلا معنى — الموعد بعيد والظروف تتغيّر. */
export const CONFIRM_WINDOW_DAYS = 30;

export type ConfirmVerdict =
  | { ok: true }
  | { ok: false; reason: "not_booked" | "past" | "too_far" };

export function confirmVerdict(appointment: {
  status: string;
  scheduledDate: string;
}, today: string): ConfirmVerdict {
  if (appointment.status !== "booked") return { ok: false, reason: "not_booked" };
  if (appointment.scheduledDate < today) return { ok: false, reason: "past" };
  const limit = addDaysText(today, CONFIRM_WINDOW_DAYS);
  if (appointment.scheduledDate > limit) return { ok: false, reason: "too_far" };
  return { ok: true };
}

function addDaysText(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

// ── الاستمارة الرقمية ────────────────────────────────────────────────────────

/**
 * استمارة الصحة العامة.
 *
 * قائمة شروط ثابتة تُؤشَّر لا حقل حرّ أولًا: الطاقم يقرأ في ثوانٍ، والبيانات تبقى
 * قابلة للعدّ. النص الحر للمضادات والأدوية والملاحظات يأتي بعد القائمة لا قبلها.
 * والاستمارة **تُضاف إليها فقط**: كل إرسال نسخة جديدة، فتاريخ الصحة لا يُستبدل.
 */
export const INTAKE_CONDITIONS: { key: string; label: string }[] = [
  { key: "diabetes", label: "السكري" },
  { key: "hypertension", label: "ارتفاع الضغط" },
  { key: "heart", label: "مرض قلبي" },
  { key: "asthma", label: "الربو" },
  { key: "kidney", label: "مرض كلى" },
  { key: "liver", label: "مرض كبد" },
  { key: "thyroid", label: "خلل الغدة الدرقية" },
  { key: "epilepsy", label: "الصرع" },
  { key: "pregnancy", label: "الحمل" },
  { key: "bleeding", label: "اضطراب نزف أو مضيعات دم" },
  { key: "anesthesia", label: "مضاعفات سابقة من التخدير" },
];

export interface IntakeAnswers {
  conditions: string[];
  allergies: string | null;
  medications: string | null;
  emergencyName: string | null;
  emergencyPhone: string | null;
  note: string | null;
}

export type IntakeValidation =
  | { ok: true; value: IntakeAnswers }
  | { ok: false; message: string };

const VALID_CONDITION_KEYS = new Set(INTAKE_CONDITIONS.map((condition) => condition.key));
const TEXT_LIMIT = 500;

function cleanText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}

export function validateIntake(raw: unknown): IntakeValidation {
  const source = (raw ?? {}) as Record<string, unknown>;
  const conditionsRaw = Array.isArray(source.conditions) ? source.conditions : [];
  const conditions: string[] = [];
  for (const key of conditionsRaw) {
    if (typeof key !== "string" || !VALID_CONDITION_KEYS.has(key)) {
      return { ok: false, message: "قائمة الحالات غير صحيحة." };
    }
    if (!conditions.includes(key)) conditions.push(key);
  }
  const allergies = cleanText(source.allergies, TEXT_LIMIT);
  const medications = cleanText(source.medications, TEXT_LIMIT);
  const emergencyName = cleanText(source.emergencyName, 120);
  const emergencyPhone = cleanText(source.emergencyPhone, 30);
  const note = cleanText(source.note, TEXT_LIMIT);
  if (emergencyPhone && emergencyPhone.replace(/\D/g, "").length < 7) {
    return { ok: false, message: "رقم الطوارئ غير صحيح." };
  }
  return { ok: true, value: { conditions, allergies, medications, emergencyName, emergencyPhone, note } };
}

// ── عرض البوابة ──────────────────────────────────────────────────────────────

/** الموعد الذي تراه البوابة — بما يقوله المريض لا الطاقم. */
export interface PortalAppointmentView {
  id: number;
  scheduledDate: string;
  scheduledTime: string;
  durationMinutes: number;
  appointmentType: string | null;
  note: string | null;
  patientConfirmedAt: string | null;
  confirmable: boolean;
}

export function toPortalAppointment(
  appointment: {
    id: number;
    scheduledDate: string;
    scheduledTime: string;
    durationMinutes: number;
    appointmentType: string | null;
    note: string | null;
    status: string;
  },
  patientConfirmedAt: string | null,
  today: string,
): PortalAppointmentView {
  return {
    id: appointment.id,
    scheduledDate: appointment.scheduledDate,
    scheduledTime: appointment.scheduledTime,
    durationMinutes: appointment.durationMinutes,
    appointmentType: appointment.appointmentType ?? null,
    note: appointment.note ?? null,
    patientConfirmedAt,
    // المؤكد سلفًا لا يعود قابلًا للتأكيد — الزر لا يُعرض مرتين.
    confirmable: !patientConfirmedAt
      && confirmVerdict({ status: appointment.status, scheduledDate: appointment.scheduledDate }, today).ok,
  };
}
