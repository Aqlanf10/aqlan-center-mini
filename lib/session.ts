import { cookies, headers } from "next/headers";
import { SESSION_COOKIE, readSessionToken, type SessionPayload } from "./auth";

/**
 * الجلسة الموثوقة — مصادقة رقمية صارمة وموقعة بتوقيع HMAC-SHA256.
 *
 * تقرأ الكوكي الموقّعة أولاً، وتدعم ترويسة Authorization: Bearer كخيار بديل
 * معتمد ومتحقق منه رقمياً للتطبيقات الخارجية ومزامنة الهواتف.
 * لا يُعتمد أي تجاوز غير موقّع، ولا جلسة افتراضية.
 */
export async function requireSession(): Promise<SessionPayload | null> {
  try {
    const store = await cookies();
    const cookieSession = readSessionToken(store.get(SESSION_COOKIE)?.value);
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

/**
 * الجلسة الصارمة — مطابقة لـ requireSession بتأمين رقمي كامل.
 */
export async function requireSessionStrict(): Promise<SessionPayload | null> {
  return requireSession();
}
