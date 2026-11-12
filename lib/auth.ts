import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { financeAccessFor, type FinanceAccess } from "./finance-permissions";
import { classifySessionEnvelope, decodeSessionBody, hasCanonicalSessionMarker, splitSessionEnvelope } from "./session-envelope";

export { hasCanonicalSessionMarker } from "./session-envelope";

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

/** جلسة موقّعة: البيانات ظاهرة، والتوقيع هو ما يمنع تزويرها. */
export function createSessionToken(payload: SessionPayload): string {
  if (hasCanonicalSessionMarker(payload)) throw new Error("CANONICAL_SESSION_ISSUANCE_UNSUPPORTED");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

const durableClaimKeys = ["durableIdentity", "expiresAt", "userId", "username"] as const;
const durableIdentityKeys = ["accountEpoch", "controlEpoch", "credentialVersion", "generationId", "permissionRevision", "policyVersion", "provider", "realmId", "registryRevision", "schemaVersion", "subjectId"] as const;
const exactKeys = (value: unknown, keys: readonly string[]) => !!value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(",") === keys.join(",");
/**
 * PRIVATE durable signer. Only `lib/staff-durable-issuer.ts` may import it; an AST
 * allowlist test enforces that. It reuses the existing signing configuration without
 * exposing it and refuses anything but the exact durable shape (no legacy role,
 * no extra field). The issuer derives every value from a locked, freshly proved
 * account tuple and then round-trips the token through the strict durable parser.
 */
export function signDurableSessionClaims(claims: unknown): string {
  if (!exactKeys(claims, durableClaimKeys) || !exactKeys((claims as { durableIdentity: unknown }).durableIdentity, durableIdentityKeys)) {
    throw new Error("DURABLE_SESSION_SHAPE_INVALID");
  }
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** Signature envelope only, NOT authentication. Canonical and legacy payloads
 * have separate strict consumers; no caller-provided identity is trusted here. */
export function readSignedSessionEnvelope(token: string | undefined): unknown | null {
  const envelope = splitSessionEnvelope(token);
  if (!envelope) return null;
  const { body, signature } = envelope;
  const given = Buffer.from(signature);
  const want = Buffer.from(sign(body));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try { return decodeSessionBody(body); }
  catch { return null; }
}

declare const legacyEvidenceBrand: unique symbol;
export interface VerifiedLegacySession { readonly [legacyEvidenceBrand]: true }
const legacyPayloadSources = new WeakMap<object, string>();
const legacyEvidenceSources = new WeakMap<VerifiedLegacySession, string>();
/** Only an actual verified parser result (or server-derived result retaining its
 * private source) can yield evidence. Copies and request JSON never qualify. */
export function legacySessionEvidence(payload: SessionPayload): VerifiedLegacySession | null {
  const token=legacyPayloadSources.get(payload);
  if(!token || !readSessionToken(token))return null;
  const evidence=Object.freeze({}) as VerifiedLegacySession;
  legacyEvidenceSources.set(evidence,token);return evidence;
}
export function revalidateLegacySessionEvidence(evidence: VerifiedLegacySession): SessionPayload | null {
  const token=legacyEvidenceSources.get(evidence);return token?readSessionToken(token):null;
}
/** Carries original signed provenance, never trust in the caller's overrides. */
export function carryLegacySessionEvidence(source: SessionPayload, derived: SessionPayload): SessionPayload {
  const token=legacyPayloadSources.get(source);
  if(token)legacyPayloadSources.set(derived,token);
  return derived;
}

export function readSessionToken(token: string | undefined): SessionPayload | null {
  const selection = classifySessionEnvelope(readSignedSessionEnvelope(token));
  if (selection?.kind !== "legacy") return null;
  const payload = selection.payload as unknown as SessionPayload;
  legacyPayloadSources.set(payload, token!);
  return payload;
}
