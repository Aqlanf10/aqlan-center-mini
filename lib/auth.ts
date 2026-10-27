import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { financeAccessFor, type FinanceAccess } from "./finance-permissions";

export { SESSION_COOKIE, SESSION_DURATION_MS } from "./sessionCookie";

const scrypt = promisify(scryptCb);

/**
 * تسجيل دخول الطاقم.
 *
 * اللوحة تعرض أسماء مرضى وأرقام هواتفهم، وكانت مفتوحة لمن يعرف الرابط. هذا الملف هو
 * ما يغلقها. مكتوب بأدوات Node نفسها بلا مكتبة خارجية: التجزئة والتوقيع من `node:crypto`،
 * فلا اعتمادية جديدة تُراجَع أمنيًا ولا نسخة تتقادم بثغرة.
 */

const SCRYPT_KEY_LENGTH = 64;

/**
 * تجزئة كلمة المرور بـ scrypt وملح عشوائي لكل مستخدم.
 *
 * الملح داخل النص المخزَّن نفسه لا في عمود منفصل، فلا يمكن أن يُنسى أحدهما عند النسخ.
 * scrypt مُكلف بالذاكرة عمدًا: كسر قائمة كلمات مرور مسروقة يصير بطيئًا بدل أن يكون فوريًا.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, SCRYPT_KEY_LENGTH)) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

/**
 * التحقق من كلمة المرور بمقارنة ثابتة الزمن.
 *
 * المقارنة العادية `===` تخرج عند أول حرف مختلف، وفرق التوقيت هذا يُسرّب الجزء الصحيح
 * من التجزئة حرفًا حرفًا. `timingSafeEqual` لا تفعل ذلك — ولهذا السبب وحده هي هنا.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, expected] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const derived = (await scrypt(password, salt, SCRYPT_KEY_LENGTH)) as Buffer;
  const expectedBuffer = Buffer.from(expected, "hex");
  if (expectedBuffer.length !== derived.length) return false;
  return timingSafeEqual(derived, expectedBuffer);
}

export interface SessionPayload {
  /** Signed canonical identity, optional for legacy application compatibility. */
  authority?: import("./staff-authenticated-identity").StaffIdentityClaims;
  userId: number;
  username: string;
  role: string;
  expiresAt: number;
  /** جهة «طبيب» المرتبطة بالحساب (§٣٥) — اختيارية: الجلسات القديمة بلا معنى قديم. */
  partyId?: number | null;
  /** يبطل التوكن عند تغيير كلمة المرور. */
  credentialVersion?: string;
  financeAccess?: FinanceAccess;
  permissionVersion?: string;
}

function secret(): string {
  const value = process.env.SESSION_SECRET;
  // بلا سرّ لا يوجد توقيع، وبلا توقيع يستطيع أي زائر أن يكتب لنفسه جلسة مديرٍ. الانهيار
  // هنا مقصود: تشغيل الأداة بلا حماية أسوأ من عدم تشغيلها.
  if (!value || value.length < 32) {
    throw new Error("SESSION_SECRET مفقود أو قصير — يجب ألا يقل عن 32 حرفًا.");
  }
  return value;
}

function sign(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

export function sessionCredentialVersion(passwordHash: string): string {
  return createHmac("sha256", secret()).update(`credential:${passwordHash}`).digest("base64url");
}

/** A permissions edit revokes existing restricted-role sessions immediately. */
export function sessionPermissionVersion(role: string, raw: unknown): string {
  return createHmac("sha256", secret())
    .update(`permissions:${role}:${JSON.stringify(financeAccessFor(role, raw))}`)
    .digest("base64url");
}

const forbiddenLegacyMarkers = ["authority", "staffAuthority", "durableIdentity"] as const;
export function hasCanonicalSessionMarker(payload: object): boolean {
  return forbiddenLegacyMarkers.some(key => Object.hasOwn(payload, key));
}

/** جلسة موقّعة: البيانات ظاهرة، والتوقيع هو ما يمنع تزويرها. */
export function createSessionToken(payload: SessionPayload): string {
  if (hasCanonicalSessionMarker(payload)) throw new Error("CANONICAL_SESSION_ISSUANCE_UNSUPPORTED");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** Signature envelope only, NOT authentication. Canonical and legacy payloads
 * have separate strict consumers; no caller-provided identity is trusted here. */
export function readSignedSessionEnvelope(token: string | undefined): unknown | null {
  if (typeof token !== "string" || token.length > 32768) return null;
  const segments = token.split(".");
  if (segments.length !== 2) return null;
  const [body, signature] = segments;
  if (!body || !signature || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  const given = Buffer.from(signature);
  const want = Buffer.from(sign(body));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try { return JSON.parse(Buffer.from(body, "base64url").toString()); }
  catch { return null; }
}

export function readSessionToken(token: string | undefined): SessionPayload | null {
  const payload = readSignedSessionEnvelope(token);
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || hasCanonicalSessionMarker(payload)) return null;
  const candidate = payload as Partial<SessionPayload>;
  if (typeof candidate.expiresAt !== "number" || !Number.isFinite(candidate.expiresAt) || candidate.expiresAt <= Date.now()) return null;
  if (!Number.isSafeInteger(candidate.userId) || (candidate.userId ?? 0) < 1) return null;
  return candidate as SessionPayload;
}
