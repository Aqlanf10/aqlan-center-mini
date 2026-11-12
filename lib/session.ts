import { cookies, headers } from "next/headers";
import { SESSION_COOKIE, readSessionToken, sessionCredentialVersion, carryLegacySessionEvidence, readSignedSessionEnvelope, hasCanonicalSessionMarker, type SessionPayload } from "./auth";
import { sessionPermissionVersion } from "./auth";
import { financeAccessFor } from "./finance-permissions";
import { findUserByUsername, findLegacyUserByUsernameReadOnlySnapshot, type StaffUser, type DbClient } from "./db";

async function currentSession(payload: SessionPayload | null, client?: DbClient): Promise<SessionPayload | null> {
  if (!payload?.credentialVersion) return null;
  const user = client ? await findUserByUsername(payload.username, client) : await findUserByUsername(payload.username);
  return currentSessionForUser(payload, user);
}

function currentSessionForUser(payload: SessionPayload, user: StaffUser | null): SessionPayload | null {
  if (payload.expiresAt <= Date.now()) return null;
  if (!user || !user.isActive || user.id !== payload.userId
    || payload.credentialVersion !== sessionCredentialVersion(user.passwordHash)) return null;
  /* (P2-1) تغيير الدور يُبطل الجلسة: الباب (proxy) يحرس الكاشير والمحاسب بالدور
     الموقَّع في التوكن، فلا يجوز أن يبقى توكنٌ بدورٍ غير دوره في القاعدة — موظفٌ
     نُقل من «استقبال» إلى «كاشير» يدخل من جديد فيحمل دوره الجديد. */
  if (payload.role !== user.role) return null;
  if ((user.role === "cashier" || user.role === "accountant")
    && payload.permissionVersion !== sessionPermissionVersion(user.role, user.permissions?.financeAccess)) return null;
  return carryLegacySessionEvidence(payload, { ...payload, role: user.role, partyId: user.partyId,
    financeAccess: user.role === "cashier" || user.role === "accountant"
      ? financeAccessFor(user.role, user.permissions?.financeAccess) : undefined });
}

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

/** Revalidate an already authenticated server-side payload under the caller's
 * transaction. The caller must supply the admitted signed session; this does not
 * authenticate arbitrary client JSON. Reuses the canonical account/credential/
 * role/permission checks and held user SHARE lock, without rereading cookies. */
export async function revalidateSessionInTransaction(
  payload: SessionPayload, client: DbClient,
): Promise<SessionPayload | null> {
  return currentSession(payload, client);
}

/** SELECT-only revalidation within an owning, lifecycle-fenced READ ONLY
 * snapshot. Never use this read projection as permission to mutate. */
export async function revalidateLegacySessionReadOnlySnapshot(payload: SessionPayload, client: DbClient): Promise<SessionPayload | null> {
  if (!payload?.credentialVersion) return null;
  return currentSessionForUser(payload, await findLegacyUserByUsernameReadOnlySnapshot(payload.username, client));
}
