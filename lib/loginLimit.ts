import { createHash, createHmac } from "node:crypto";
import { consumeLoginAttempt } from "./db";
import { clientIpFromForwardedFor } from "./net";

/**
 * حدُّ محاولات الدخول المشترك — الطاقم والبوابة على السواء.
 * (فكرة مستودع الوكيل الآخر aqlan-center-main على جدولنا وبناء حديث.)
 *
 * مفتاحُ الحساب **بصمة HMAC لا هاشٍ مجرّد**: الهشش المفتوح يقول «هذا الاسم
 * حُاول عشر مرات» لمن يقرأ الجدول، والبصمة الممزوجة بسرٍّ لا تقول شيئًا.
 * والمفتاح مشتركٌ بين النسخ ومع إعادة التشغيل — فتدويرُ IP أو إقلاعُ الخادم
 * لا يصفّر العدّاد.
 *
 * وحدُّ المصدر (٦٠ محاولة/١٥ دقيقة) **لا يُفعَّل إلا خلف وسيطٍ موثوق**
 * (`TRUST_PROXY=true`): ترويسةُ `x-forwarded-for` يكتبها العميل، فمن يثق بها
 * بلا وسيطٍ يمنع نفسه ويترك المهاجم.
 */

export const ACCOUNT_ATTEMPTS = 10;
export const SOURCE_ATTEMPTS = 60;
export const WINDOW_MINUTES = 15;

export interface LoginAttemptResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * يستهلك محاولة دخول — للحساب دائمًا، وللمصدر خلف الوسيط الموثوق وحده.
 *
 * والعودة `retryAfterSeconds` لأنّ الشاشة تعرض للمستخدم متى يُعاد المحاولة،
 * لا «حاول لاحقًا» التي تجعله يعيد كل ثانية فيستنفد النافذة.
 */
/** مفتاح عدّاد الحساب (بصمة HMAC) — لتصفيره بعد دخولٍ ناجح؛ null بلا سرّ. */
export function accountLimitKey(scope: "staff" | "portal", identifier: string): string | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  return createHmac("sha256", secret).update(`${scope}:account:${identifier.trim().toLowerCase()}`).digest("hex");
}

/**
 * مفاتيح الحدّ المشترك لمحاولة واحدة — الحساب دائمًا، والمصدر خلف الوسيط الموثوق.
 * null بلا سرّ: يبقى الحدّ القديم وحده يعمل بجدوله (لا يُفتح الباب).
 * المصدر الوحيد للمفاتيح: الدخول القديم والموحّد يستهلكان المفاتيح نفسها.
 */
export function loginLimitKeys(
  scope: "staff" | "portal",
  identifier: string,
  headers: Headers,
): { key: string; maximum: number }[] | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  const hmac = (value: string) =>
    createHmac("sha256", secret).update(value).digest("hex");

  const limits: { key: string; maximum: number }[] = [
    { key: hmac(`${scope}:account:${identifier.trim().toLowerCase()}`), maximum: ACCOUNT_ATTEMPTS },
  ];
  if (process.env.TRUST_PROXY === "true") {
    /* آخر قيمة في السلسلة — التي أضافها الوسيط الموثوق نفسه؛ الأولى يكتبها
       العميل فيمكنه تزويرها (lib/net.ts). */
    const address = clientIpFromForwardedFor(headers.get("x-forwarded-for"));
    if (address) {
      limits.push({ key: hmac(`${scope}:source:${address}`), maximum: SOURCE_ATTEMPTS });
    }
  }
  return limits;
}

/** مفتاح الحدّ القديم لحساب الطاقم (sha256 للاسم بأحرف صغيرة) — كما كان في مسار الدخول. */
export function legacyStaffAccountKey(username: string): string {
  return createHash("sha256").update(username.toLowerCase()).digest("hex");
}

export async function consumeLoginAttemptFor(
  scope: "staff" | "portal",
  identifier: string,
  headers: Headers,
): Promise<LoginAttemptResult> {
  const limits = loginLimitKeys(scope, identifier, headers);
  // بلا سرٍّ لا بصمة HMAC: نترك الحدّ القديم يعمل بجدوله لا نفتح الباب.
  if (!limits) return { allowed: true, retryAfterSeconds: 0 };
  return consumeLoginAttempt(limits, WINDOW_MINUTES);
}
