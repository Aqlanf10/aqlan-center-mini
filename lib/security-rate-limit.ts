/**
 * الحدّ الأمني الموزع العام — P2/S10.
 *
 * على النمط نفسه الذي أخضرّ لحدود الدخول (lib/loginLimit.ts + جدول
 * login_limits في PostgreSQL): بصمة HMAC للمفتاح تعمل بين النسخ ومع
 * إعادة التشغيل، وحدّ المصدر خلف وسيطٍ موثّق فقط. حدود الدخول القائمة
 * **لم تُلمس** — هذا إضافة للمناطق الناقصة فقط (setup، الحجز، الوصول
 * الذاتي، محادثة AI، اختبار اتصال مزود).
 *
 * لا ذاكرة داخلية (in-memory) في أي مكان من هذه الطبقة: الحماية على
 * قاعدة البيانات نفسها — نسخ Railway المتعددة تتقاسم العدّاد.
 *
 * المفاتيح لا تخزن أسرارًا خامًا أبدًا: المعرف يمر ببصمة HMAC قبل أن
 * يلمس الجدول — لا كلمات مرور ولا مفاتيح API ولا هواتف مرضى صريحة.
 */

import { createHmac } from "node:crypto";
import { consumeLoginAttempt } from "./db";
import { clientIpFromForwardedFor } from "./net";

export interface SecurityLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface SecurityLimitSpec {
  /** نطاق الحد — يميز عدادات المناطق المختلفة: "setup" و"ai-chat" وغيرها. */
  scope: string;
  /** هوية من يُحدّ: اسم مستخدم، رقم هاتف، معرف جلسة — بأي شكل خام. */
  identifier: string;
  maximum: number;
  windowMinutes: number;
  /** ترويسات الطلب — لاستخراج المصدر خلف وسيط موثوق. */
  headers: Headers;
}

/**
 * يستهلك محاولة من حدّ أمني عام. فشل قاعدة البيانات في الحدّ = فشل
 * مفتوح هنا؟ لا: نعيد allowed=true (استمرار الخدمة) — نفس قرار حدود
 * الدخول القائمة: الحدّ طبقة حماية ضد الإساءة، وعطل القاعدة لا يوقف
 * العيادة. المسارات الحرجة (الدخول) لديها حدودها الخاصة المتشددة.
 */
export async function consumeSecurityLimit(spec: SecurityLimitSpec): Promise<SecurityLimitResult> {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    // بلا سرّ لا بصمة HMAC — لا نخزن هوية خام بأي حال.
    return { allowed: true, retryAfterSeconds: 0 };
  }
  const hmac = (value: string) => createHmac("sha256", secret).update(value).digest("hex");

  const limits: { key: string; maximum: number }[] = [
    { key: hmac(`sec:${spec.scope}:id:${spec.identifier}`), maximum: spec.maximum },
  ];
  if (process.env.TRUST_PROXY === "true") {
    const address = clientIpFromForwardedFor(spec.headers.get("x-forwarded-for"));
    if (address) {
      limits.push({ key: hmac(`sec:${spec.scope}:source:${address}`), maximum: spec.maximum });
    }
  }

  try {
    return await consumeLoginAttempt(limits, spec.windowMinutes);
  } catch {
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/** استجابة 429 موحدة مع Retry-After — كل مسار يحدّ يرد بها نفس الشكل. */
export function rateLimitResponse(retryAfterSeconds: number, message?: string): Response {
  return new Response(
    JSON.stringify({
      message: message ?? "طلبات كثيرة. أعد المحاولة بعد قليل.",
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Retry-After": String(Math.max(1, retryAfterSeconds)),
        "Cache-Control": "no-store",
      },
    },
  );
}
