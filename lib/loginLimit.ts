import { createHmac } from "node:crypto";
import { consumeLoginAttempt } from "./db";

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
export async function consumeLoginAttemptFor(
  scope: "staff" | "portal",
  identifier: string,
  headers: Headers,
): Promise<LoginAttemptResult> {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    // بلا سرٍّ لا بصمة HMAC: نترك الحدّ القديم يعمل بجدوله لا نفتح الباب.
    return { allowed: true, retryAfterSeconds: 0 };
  }
  const hmac = (value: string) =>
    createHmac("sha256", secret).update(value).digest("hex");

  const limits: { key: string; maximum: number }[] = [
    { key: hmac(`${scope}:account:${identifier.trim().toLowerCase()}`), maximum: ACCOUNT_ATTEMPTS },
  ];
  if (process.env.TRUST_PROXY === "true") {
    const address = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (address) {
      limits.push({ key: hmac(`${scope}:source:${address}`), maximum: SOURCE_ATTEMPTS });
    }
  }

  return consumeLoginAttempt(limits, WINDOW_MINUTES);
}
