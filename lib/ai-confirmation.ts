/**
 * رموز تأكيد أدوات الذكاء الاصطناعي (AI Tool Confirmation Tokens)
 *
 * كل أداة تغيّر حالةً عبر المساعد لا تُنفَّذ فورًا: يُبنى لها **عرض تأكيد**
 * (ماذا ستفعل، على أي مريض، بأي قيم حساسة) موقّعٌ برمزٍ مرتبطٍ ارتباطًا
 * كاملًا بالمستخدم والأداة والمعاملات والمريض — ثم لا يُنفَّذ إلا بموافقةٍ
 * صريحة عبر POST /api/ai/confirmation، وبعد إعادة تحميل المستخدم وإعادة فحص
 * الصلاحيات والملكية، وباستهلاكٍ ذرّيٍّ مرةً واحدة.
 *
 * خصائص الرمز:
 * - **موقّع HMAC-SHA256** — التلاعب بالمعاملات أو المستخدم أو المريض يُبطله.
 * - **عمر قصير** (١٠ دقائق) — عرضٌ يُنسى لا صلاحيةٌ تُخزَّن.
 * - **مرة واحدة** — الاستهلاك سجلٌ في قاعدة البيانات بقيادةٍ ذرّية
 *   (INSERT ... ON CONFLICT DO NOTHING)؛ المحاولة الثانية بالرمز نفسه تُرفض.
 * - **عابر للمستخدمين** — رمز مستخدمٍ لا يُنفِّذه مستخدمٌ آخر.
 * - **لا يمرّ في روابط URL** — يُرسل في جسم POST فقط، ولا يُخزَّن في الواجهة.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { ToolConfirmationOffer, ToolConfirmationPayload } from "./ai-tools/types";

/** عمر عرض التأكيد: عشر دقائق — يكفي لقراءة المعاينة وقرارها، ولا يبقي بابًا مفتوحًا. */
export const TOOL_CONFIRMATION_TTL_MS = 10 * 60 * 1000;

/** الحد الأقصى لحجم المعاملات المضمّنة في الرمز — معاملاتٌ أكبر لا تأكيد لها. */
export const TOOL_CONFIRMATION_MAX_PARAMS_JSON = 8000;

/**
 * سرّ توقيع التأكيد: SESSION_SECRET حيثما ضُبط (الإنتاج)، وإلا مفتاحٌ عشوائيّ
 * لعملية الخادم الحالية (بيئة التطوير/الاختبار) — فالتأكيد متاحٌ والرموز لا
 * تعبر عملياتٍ مختلفة. وفي الإنتاج أصلاً لا يعمل النظام بلا SESSION_SECRET.
 */
let volatileSecret: string | null = null;
function confirmationSecret(): string {
  const envSecret = process.env.SESSION_SECRET;
  if (typeof envSecret === "string" && envSecret.length >= 32) return envSecret;
  if (!volatileSecret) {
    volatileSecret = `ai-confirmation-dev-${randomUUID()}-${randomUUID()}`;
  }
  return volatileSecret;
}

function sign(data: string): string {
  return createHmac("sha256", confirmationSecret()).update(data).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** يبني حمولة رمزٍ سارية لمستخدمٍ وأداةٍ ومعاملاتٍ — بلا مريضٍ إن لم تُحلّ هويته بعد. */
export function buildToolConfirmationPayload(input: {
  userId: number;
  username: string;
  tool: string;
  params: Record<string, unknown>;
  patientId?: number | null;
  ttlMs?: number;
}): ToolConfirmationPayload {
  const now = Date.now();
  const ttl = input.ttlMs ?? TOOL_CONFIRMATION_TTL_MS;
  return {
    v: 1,
    jti: randomUUID(),
    userId: input.userId,
    username: input.username,
    tool: input.tool,
    params: input.params,
    patientId: input.patientId ?? null,
    iat: now,
    exp: now + ttl,
  };
}

/** يوقّع الحمولة رمزًا واحدًا — `payload.signature`. */
export function signToolConfirmation(payload: ToolConfirmationPayload): string {
  const body = Buffer.from(JSON.stringify({
    v: payload.v,
    jti: payload.jti,
    userId: payload.userId,
    username: payload.username,
    tool: payload.tool,
    params: payload.params,
    patientId: payload.patientId ?? null,
    iat: payload.iat,
    exp: payload.exp,
  }), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

/**
 * يتحقق من الرمز ويُعيد حمولته — أو null عند تلاعبٍ أو انتهاء عمرٍ أو صيغةٍ
 * فاسدة. لا يتحقق من الاستهلاك (المرة الواحدة): ذاك شأن قاعدة البيانات.
 */
export function verifyToolConfirmation(token: unknown): ToolConfirmationPayload | null {
  if (typeof token !== "string" || token.length === 0 || token.length > 20000) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!safeEqual(signature, sign(body))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.v !== 1) return null;
    if (typeof parsed.jti !== "string" || parsed.jti.length < 20) return null;
    if (typeof parsed.userId !== "number" || !Number.isInteger(parsed.userId)) return null;
    if (typeof parsed.username !== "string") return null;
    if (typeof parsed.tool !== "string" || parsed.tool.length === 0) return null;
    if (!parsed.params || typeof parsed.params !== "object") return null;
    if (typeof parsed.iat !== "number" || typeof parsed.exp !== "number") return null;
    if (parsed.exp <= Date.now()) return null; // انتهى عمر العرض
    if (parsed.patientId !== null && !(Number.isInteger(parsed.patientId) && parsed.patientId > 0)) return null;
    return parsed as ToolConfirmationPayload;
  } catch {
    return null;
  }
}

/** يبني العرض النهائي الذي تعرضه الواجهة — الرمز مع تفاصيل المعاينة. */
export function buildToolConfirmationOffer(
  payload: ToolConfirmationPayload,
  preview: {
    title: string;
    description: string;
    patientLabel?: string | null;
    fields: { label: string; value: string; sensitive?: boolean }[];
  },
): ToolConfirmationOffer {
  return {
    token: signToolConfirmation(payload),
    tool: payload.tool,
    title: preview.title,
    description: preview.description,
    patientLabel: preview.patientLabel ?? null,
    fields: preview.fields,
    expiresAt: payload.exp,
  };
}
