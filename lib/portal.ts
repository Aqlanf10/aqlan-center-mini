import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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
 * (0127_patient_portal_security) الدخول المعتمد لبوابة المريض يتم حصريًا عبر
 * اسم مستخدم فريد وكلمة مرور مجزّأة بـ `scrypt` يختارها المريض عبر رابط تفعيل
 * مؤقت أحادي الاستخدام بعد تفعيل موظف مخوّل؛ وأُوقف مسار الدخول القديم برقم
 * الملف والهاتف نهائيًا بلا أي استثناء طوارئ.
 */

export {
  PORTAL_ADMIN_PREVIEW_COOKIE_NAME as PORTAL_ADMIN_PREVIEW_COOKIE,
  PORTAL_COOKIE_NAME as PORTAL_COOKIE,
} from "./sessionCookie";
export const PORTAL_ADMIN_PREVIEW_DURATION_MS = 30 * 60 * 1000;
/**
 * بوابة تُفتح أسبوعًا لا شهرًا: الجلسة الطويلة نافذةٌ مفتوحة على حساب المريض
 * ومواعيده لمن يظفر بجهازه، وسبعة أيام تغطي دورة المتابعة بين زيارتين وتُبقي
 * ما يفقده المريض من انقطاعٍ في حدّ الكلفة صفر — يعيد الدخول بعاملين يعرفهما.
 */
export const PORTAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export interface PortalAdminPreviewContext {
  staffUserId: number;
  staffUsername: string;
  staffDisplayName: string;
  staffRole: string;
  reason: string;
  startedAt: number;
  expiresAt: number;
}

export interface PortalPayload {
  patientId: number;
  patientNumber: string;
  fullName: string;
  expiresAt: number;
  /** رقم نسخة اعتماد الحساب — يُفحص حيًّا في `requirePortalSession()`. */
  credentialVersion?: number;
  /** وقت إصدار الجلسة بالملي ثانية — لإبطال الجلسات الفوري عبر `sessions_revoked_at`. */
  issuedAt?: number;
  /** بصمة رقم الهاتف المسجّل وقت إصدار الجلسة. */
  phoneFingerprint?: string | null;
  /** سياق الدخول الإداري للقراءة فقط («عرض بوابة المريض» باسم الموظف وصلاحياته). */
  adminPreview?: PortalAdminPreviewContext;
}

export interface PortalAdminPreviewTokenPayload {
  patientId: number;
  staffUserId: number;
  staffUsername: string;
  staffDisplayName: string;
  staffRole: string;
  /** بصمة اعتماد جلسة الموظف وقت إصدار المعاينة — لإبطال كوكي المعاينة فور تدوير كلمة مرور الموظف. */
  staffCredentialVersion?: string;
  reason: string;
  startedAt: number;
  expiresAt: number;
}

export function isPortalAdminPreview(
  session: Pick<PortalPayload, "adminPreview"> | null | undefined,
): boolean {
  return Boolean(session?.adminPreview);
}

/** بصمة SHA-256 لآخر 9 أرقام من رقم الهاتف — لا يُخزَّن الهاتف الخام في السجلات أو الرموز. */
export function portalPhoneFingerprint(phone: string | null | undefined): string | null {
  if (typeof phone !== "string") return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return createHash("sha256").update(`portal-phone:${digits.slice(-9)}`).digest("hex");
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
    // لا نسمح أبدًا بحقن adminPreview داخل كوكي المريض العادي.
    if (payload.adminPreview) return null;
    return payload;
  } catch {
    return null;
  }
}

function portalAdminPreviewSecret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error("SESSION_SECRET مفقود أو قصير — يجب ألا يقل عن 32 حرفًا.");
  }
  return `portal-admin-preview:${value}`;
}

function portalAdminPreviewSign(body: string): string {
  return createHmac("sha256", portalAdminPreviewSecret()).update(body).digest("base64url");
}

/** توكن معاينة إدارية بمجال توقيع منفصل — مقترن بجلسة الموظف الحية ولا يمنح صلاحية مريض. */
export function createPortalAdminPreviewToken(payload: PortalAdminPreviewTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${portalAdminPreviewSign(body)}`;
}

export function readPortalAdminPreviewToken(
  token: string | undefined,
): PortalAdminPreviewTokenPayload | null {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = portalAdminPreviewSign(body);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString(),
    ) as PortalAdminPreviewTokenPayload;
    if (typeof payload.expiresAt !== "number" || payload.expiresAt < Date.now()) return null;
    if (typeof payload.startedAt !== "number") return null;
    if (!Number.isInteger(payload.patientId) || payload.patientId <= 0) return null;
    if (!Number.isInteger(payload.staffUserId) || payload.staffUserId <= 0) return null;
    if (typeof payload.staffUsername !== "string" || !payload.staffUsername) return null;
    if (
      payload.staffCredentialVersion !== undefined &&
      (typeof payload.staffCredentialVersion !== "string" || !payload.staffCredentialVersion.trim())
    ) {
      return null;
    }
    if (typeof payload.reason !== "string" || payload.reason.trim().length < 5) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── تسجيل الدخول المعتمد لبوابة المريض (اسم مستخدم + كلمة مرور قوية) ──────

export const PORTAL_LOGIN_NAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;
export const PORTAL_MIN_PASSWORD_LENGTH = 8;
export const PORTAL_MAX_PASSWORD_LENGTH = 128;

export function normalizePortalLoginName(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

export function validatePortalLoginName(
  raw: unknown,
): { ok: true; value: string } | { ok: false; message: string } {
  const normalized = normalizePortalLoginName(raw);
  if (!normalized || !PORTAL_LOGIN_NAME_PATTERN.test(normalized)) {
    return {
      ok: false,
      message: "اسم المستخدم يجب أن يتكوّن من 3 إلى 64 حرفًا لاتينيًا أو رقمًا أو (._-) بدون مسافات.",
    };
  }
  return { ok: true, value: normalized };
}

export function validatePortalPasswordChoice(
  rawPassword: unknown,
  loginName?: string,
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof rawPassword !== "string") {
    return { ok: false, message: "أدخل كلمة المرور الجديدة." };
  }
  if (rawPassword.length < PORTAL_MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      message: `كلمة المرور يجب ألا تقل عن ${PORTAL_MIN_PASSWORD_LENGTH} خانات.`,
    };
  }
  if (rawPassword.length > PORTAL_MAX_PASSWORD_LENGTH) {
    return { ok: false, message: "كلمة المرور طويلة جدًا." };
  }
  if (!/\p{L}/u.test(rawPassword) || !/\d/.test(rawPassword)) {
    return {
      ok: false,
      message: "اختر كلمة مرور تحتوي على حرف ورقم واحد على الأقل.",
    };
  }
  if (loginName && rawPassword.trim().toLowerCase() === loginName.trim().toLowerCase()) {
    return { ok: false, message: "لا يجوز أن تطابق كلمة المرور اسم المستخدم." };
  }
  return { ok: true, value: rawPassword };
}

export interface PortalAccountLoginInput {
  username: string;
  password: string;
}

export function validatePortalAccountLogin(
  raw: unknown,
): { ok: true; value: PortalAccountLoginInput } | { ok: false; message: string } {
  const source = (raw ?? {}) as Record<string, unknown>;
  const username = normalizePortalLoginName(source.username);
  const password = typeof source.password === "string" ? source.password : "";
  if (!username || !PORTAL_LOGIN_NAME_PATTERN.test(username)) {
    return { ok: false, message: "أدخل اسم المستخدم الخاص ببوابة المريض." };
  }
  if (!password || password.length > PORTAL_MAX_PASSWORD_LENGTH) {
    return { ok: false, message: "أدخل كلمة المرور." };
  }
  return { ok: true, value: { username, password } };
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
  if (!patientNumber || patientNumber.length > 21) {
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
