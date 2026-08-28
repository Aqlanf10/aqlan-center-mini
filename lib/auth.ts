import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

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
  userId: number;
  username: string;
  role: string;
  expiresAt: number;
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

/** جلسة موقّعة: البيانات ظاهرة، والتوقيع هو ما يمنع تزويرها. */
export function createSessionToken(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function readSessionToken(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = sign(body);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    // التوقيع يمنع التزوير، والانتهاء يمنع بقاء جلسة مسروقة صالحة إلى الأبد.
    if (typeof payload.expiresAt !== "number" || payload.expiresAt < Date.now()) return null;
    if (typeof payload.userId !== "number") return null;
    return payload;
  } catch {
    return null;
  }
}
