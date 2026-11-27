import { cookies, headers } from "next/headers";
import { SESSION_COOKIE, readSessionToken, readSignedSessionEnvelope, hasCanonicalSessionMarker, type SessionPayload } from "./auth";
import type { VerifiedDurableSession } from "./staff-durable-session";
import type { DbClient } from "./db";
import {
  currentSession,
  revalidateSessionInTransaction,
  revalidateLegacySessionReadOnlySnapshot,
} from "./session-revalidate";

export { revalidateSessionInTransaction, revalidateLegacySessionReadOnlySnapshot };

/**
 * الجلسة الموثوقة — مصادقة رقمية صارمة وموقعة بتوقيع HMAC-SHA256.
 *
 * تقرأ الكوكي الموقّعة أولاً، وتدعم ترويسة Authorization: Bearer كخيار بديل
 * معتمد ومتحقق منه رقمياً للتطبيقات الخارجية ومزامنة الهواتف.
 * لا يُعتمد أي تجاوز غير موقّع، ولا جلسة افتراضية.
 */
/**
 * قراءة الحمولة الموقّعة حصرًا — كوكي ثم Bearer، بتحقق HMAC كامل ولا **أي**
 * وصولٍ إلى قاعدة البيانات.
 *
 * هذه هي الطبقة التي يبني عليها المسار القرائي لنظام النسخ
 * (lib/backupReadOnly): التوقيع يمنع التزوير هنا، وتأكيد الحساب (وجود/نشاط/
 * دور/credential version) يجري بعدها بـSELECT قرائي مباشر بلا ensureSchema —
 * فلا يصل مسار النسخ أبدًا إلى أي DDL ضمني.
 */
export async function readSessionPayload(): Promise<SessionPayload | null> {
  try {
    const store = await cookies();
    const cookieToken=store.get(SESSION_COOKIE)?.value;
    const envelope=readSignedSessionEnvelope(cookieToken);
    // A genuinely signed canonical/obsolete cookie is selected but not eligible
    // for legacy auth. It must not silently fall through to a legacy Bearer.
    if(envelope && typeof envelope === "object" && hasCanonicalSessionMarker(envelope))return null;
    const cookieSession = readSessionToken(cookieToken);
    if (cookieSession) return cookieSession;
  } catch {
    // تجاهل أخطاء قراءة الكوكيز
  }

  try {
    const headerList = await headers();
    const authHeader = headerList.get("authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7).trim();
      const session = readSessionToken(token);
      if (session) return session;
    }
  } catch {
    // تجاهل الأخطاء عند استدعاء headers خارج سياق الطلب
  }

  return null;
}

export async function requireSession(client?: DbClient): Promise<SessionPayload | null> {
  const payload = await readSessionPayload();
  if (!payload?.credentialVersion) return null;
  // فشل التحقق (قاعدة ساقطة مثلًا) فشلٌ مغلق: جلسة null لا استثناء يطيح بالمسار —
  // نفس سلوك النسخة السابقة التي كانت تحيط الاستدعاء كله بالـtry.
  try {
    return await currentSession(payload, client);
  } catch {
    return null;
  }
}

/**
 * الجلسة الصارمة — مطابقة لـ requireSession بتأمين رقمي كامل.
 */
export async function requireSessionStrict(): Promise<SessionPayload | null> {
  return requireSession();
}

export type BoundRequestSession = VerifiedDurableSession;

export async function readBoundRequestSession(): Promise<BoundRequestSession | null> {
  const { selectRequestStaffEnvelope } = await import("./staff-session-admission");
  const selected = await selectRequestStaffEnvelope();
  return selected.kind === "canonical" ? selected.handle : null;
}

export async function revalidateBoundRequestSession(
  _proof: BoundRequestSession, _client: DbClient,
): Promise<{ payload: SessionPayload; sessionBinding: string } | null> {
  // The standalone numbering adapter requires a legacy-shaped SessionPayload.
  // Never convert a durable canonical handle to that shape or fall back to a
  // signed legacy admin. A future canonical writer must prove the owner's
  // subject/enrollment under its lifecycle fence on the shared transaction.
  return null;
}
