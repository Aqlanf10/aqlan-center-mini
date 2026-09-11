import { getPool } from "./db";
import { isAdmin } from "./roles";
import { withDefaults, type SettingsMap } from "./settings";
import { readSessionPayload } from "./session";
import { sessionCredentialVersion } from "./auth";

/**
 * الطبقة القرائية الحصرية لنظام النسخ الاحتياطي — هنا سبب أن «لا كتابة في
 * قاعدة الإنتاج» بيانٌ صادق لا شعار.
 *
 * ### لماذا وُجدت هذه الوحدة أصلًا
 *
 * المسارات القائمة للجلسة والإعدادات تمر ضمنيًّا في `ensureSchema()` — أداة
 * الطوارئ التي تنشئ الجداول لو لم تكن. ذلك مقبولٌ في شاشات التطبيق، لكنه في
 * مسار النسخ الإنتاجي يعني أن ضربة مجدولٍ على قاعدةٍ ناقصة الجداول قد تُطلق
 * DDL صامتًا داخل الإنتاج — والعهد هنا عكس ذلك تمامًا: **النسخ تقرأ ولا
 * تُصلح**. إن نقص جدول فذلك فشلٌ مغلق يُدار بيد الإنسان، لا إصلاحٌ يُدار
 * بالكود.
 *
 * فكل ما يلمسه مسار النسخ من القاعدة يمر من هنا: SELECT مباشر عبر
 * `getPool().query()` حصرًا — بلا ensureSchema، بلا saveSettings، بلا أي دالة
 * كتبت يومًا. والنقص أو الخطأ يخرج فشلًا مغلقًا صريحًا لا تخمينًا بصمت.
 */

/* ─── إعدادات النسخ — SELECT قرائي مباشر ───────────────────────────────────── */

export type BackupSettingsReadResult =
  | { ok: true; settings: SettingsMap }
  | { ok: false; error: "settings-unreadable" };

/**
 * إعدادات النسخ قراءةً مباشرة من جدول settings — بلا ensureSchema ولا ذاكرة.
 *
 *  * نجاح: القيم المخزّنة تُدمج فوق الافتراضيات (نفس دمج getSettings بلا أي
 *    من آثاره الجانبية — لا إنشاء جداول، ولا cache مشترك مع بقية التطبيق).
 *  * غياب الجدول أو أي خطأ قراءة ⇒ `{ok:false}` — والمستدعي التنفيذي
 *    (نقطة المجدول، Backup Now) يفشل مغلقًا 503 ولا يجرّب إصلاح شيء.
 */
export async function getBackupSettingsReadOnly(): Promise<BackupSettingsReadResult> {
  try {
    const { rows } = await getPool().query<{ key: string; value: string }>(
      `SELECT key, value FROM settings`,
    );
    const stored: Record<string, string> = {};
    for (const row of rows) stored[row.key] = row.value;
    return { ok: true, settings: withDefaults(stored) };
  } catch {
    // جدول غائب، قاعدة نائمة، صلاحية ناقصة — كلها الفئة نفسها: غير مقروء.
    // لا تخمين بالافتراضيات هنا من طرفنا: قرار الفشل المغلق للمستدعي التنفيذي.
    return { ok: false, error: "settings-unreadable" };
  }
}

/* ─── جلسة المدير — توقيع HMAC ثم SELECT قرائي للمستخدم ──────────────────── */

export interface BackupAdminSession {
  userId: number;
  username: string;
  role: string;
  partyId: number | null;
}

export type BackupAdminAuthResult =
  | { ok: true; session: BackupAdminSession }
  | { ok: false; reason: "no-session" | "user-gone" | "inactive" | "credential-changed" | "users-unreadable" };

/**
 * جلسة مدير النسخ — بلا أي DDL ضمني.
 *
 * الترتيب الصارم:
 * ١) **التوقيع**: الحمولة من الكوكي أو Bearer تُقرأ وتُتحقق بـHMAC-SHA256
 *    (readSessionPayload) — لا جلسة مزوّرة تمر من هنا أبدًا، والإبطال
 *    بالانتهاء كما هو، ولا ضعفٌ في إبطال الجلسات.
 * ٢) **الحساب بSELECT مباشر**: صف المستخدم من جدول users — موجود، نشط،
 *    الدور، وcredential version يطابق بصمة كلمة المرور الحالية (تغيير كلمة
 *    المرور يُبطل التوكن كما في المسار العام).
 * ٣) **النقص فشل مغلق**: جدول users غائب أو أي خطأ قراءة ⇒ users-unreadable —
 *    لا ensureSchema إصلاحًا، ولا جلسة افتراضية مهما كان السبب.
 *
 * الدور نفسه لا يُفتح هنا: المسارات تفحص isAdmin(session.role) لتمييز
 * 403 من 401 كما كان — الفارق الوحيد أن كل قراءة من هذا المسار SELECT حصرًا.
 */
export async function requireBackupAdminReadOnly(): Promise<BackupAdminAuthResult> {
  const payload = await readSessionPayload();
  if (!payload?.credentialVersion) return { ok: false, reason: "no-session" };

  let userRow: {
    id: number;
    username: string;
    password_hash: string;
    role: string;
    is_active: boolean;
    party_id: number | null;
  } | null = null;
  try {
    const { rows } = await getPool().query<{
      id: number;
      username: string;
      password_hash: string;
      role: string;
      is_active: boolean;
      party_id: number | null;
    }>(
      `SELECT id, username, password_hash, role, is_active, party_id
         FROM users
        WHERE LOWER(username) = LOWER($1)
        LIMIT 1`,
      [payload.username],
    );
    userRow = rows[0] ?? null;
  } catch {
    return { ok: false, reason: "users-unreadable" };
  }

  if (!userRow) return { ok: false, reason: "user-gone" };
  if (!userRow.is_active) return { ok: false, reason: "inactive" };
  if (userRow.id !== payload.userId) return { ok: false, reason: "user-gone" };
  if (payload.credentialVersion !== sessionCredentialVersion(userRow.password_hash)) {
    return { ok: false, reason: "credential-changed" };
  }

  return {
    ok: true,
    session: {
      userId: userRow.id,
      username: userRow.username,
      role: userRow.role,
      partyId: userRow.party_id ?? null,
    },
  };
}

/**
 * راحة استعمال للمسارات: جلسة مدير كاملة أو null — بلا تمييز السبب.
 * المسارات التي تريد تفريق 401 عن 403 تستدعي requireBackupAdminReadOnly ثم
 * isAdmin بنفسها؛ هذه لما لا يهم التفريق.
 */
export async function requireBackupAdminSession(): Promise<BackupAdminSession | null> {
  const result = await requireBackupAdminReadOnly();
  if (!result.ok) return null;
  if (!isAdmin(result.session.role)) return null;
  return result.session;
}
