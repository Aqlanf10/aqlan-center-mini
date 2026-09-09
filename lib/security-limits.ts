/**
 * حدود الأمان المركزية — P2/S8 وS10.
 *
 * مكان واحد لكل رقم يخص حدود الأجسام وحدود المعدل: قابلة للتهيئة بمتغيرات
 * بيئة صريحة (بدون إعادة نشر في Railway؟ بل تحتاجها — وهو مقصود: رفع الحد
 * قرار تشغيلي مرئي)، والافتراضات محافظة.
 *
 * لا تخزَّن المفاتيح الخام في حدود المعدل: مفتاح الهوية بصمة HMAC
 * (lib/security-rate-limit.ts)، لا كلمات مرور ولا مفاتيح ولا أسرار مرضى.
 */

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/* ── حدود أجسام الطلبات (بايت) ─────────────────────────────────────────── */

/** JSON الداخلي الافتراضي: 256KB — أوسع من أي حمولة شرعية في التطبيق. */
export const JSON_BODY_LIMIT_BYTES = envNumber("JSON_BODY_LIMIT_KB", 256) * 1024;

/**
 * محادثة الذكاء الاصطناعي: أكبر — لكن محدودة. حوار طويل مع تاريخ هو
 * الحمولة الوحيدة المسموح لها هذا الحجم؛ التاريخ غير المحدود باب DoS
 * وتكلفة، وحدّه هنا قرار أمني واقتصادي معًا.
 */
export const AI_CHAT_BODY_LIMIT_BYTES = envNumber("AI_CHAT_BODY_LIMIT_KB", 1024) * 1024;

/** الإعدادات: أصغر — لا شيء شرعي في إعدادات النظام بحاجة إلى حجمًا. */
export const SETTINGS_BODY_LIMIT_BYTES = envNumber("SETTINGS_BODY_LIMIT_KB", 64) * 1024;

/** نماذج HTML (تسجيل الدخول): صغيرة بحكم طبيعتها. */
export const FORM_BODY_LIMIT_BYTES = envNumber("FORM_BODY_LIMIT_KB", 128) * 1024;

/**
 * سقف قراءة رفع المستندات: فوق الحد القابل للتهيئة (20MB افتراضيًّا من
 * إعدادات العيادة) بهامش ترويسات multipart — بلا هامش يُرفض الرفع المشروع
 * حدّه 20MB بالضبط؛ وبسقف كبير نُبطِل الحد أصلًا.
 */
export const UPLOAD_BODY_LIMIT_BYTES = envNumber("UPLOAD_BODY_LIMIT_MB", 25) * 1024 * 1024;

/**
 * رسائل الطاقم/البوابة: الصوت والمرفقات base64 داخل JSON (الملف حتى 10MB
 * منطقيًّا ⇒ ~14MB مشفرًا) — حد القراءة أعلى من JSON العام وأدنى من multipart.
 */
export const MESSAGES_BODY_LIMIT_BYTES = envNumber("MESSAGES_BODY_LIMIT_MB", 16) * 1024 * 1024;

/**
 * سقف Content-Length العام في proxy قبل أي معالجة: يغطي المسارات التي لم
 * تستخدم القارئ المحدود بعد. فوقه يُرفض الطلب من الباب نفسه (413).
 * يسمح برفع المستندات (سقف الرفع أعلى) — التمييز بالمحتوى multipart.
 */
export const PROXY_JSON_DECLARED_LIMIT_BYTES = envNumber("PROXY_JSON_DECLARED_LIMIT_MB", 2) * 1024 * 1024;

/* ── حدود المعدل الموزعة (PostgreSQL-backed) ───────────────────────────── */

/** إعداد الحساب الأول: ضيق عمدًا — نجاح واحد هو الغاية، والبقية إساءة. */
export const SETUP_RATE_LIMIT = {
  maximum: envNumber("SETUP_RATE_MAX", 10),
  windowMinutes: envNumber("SETUP_RATE_WINDOW_MIN", 60),
};

/** حجز موعد عام: هوية الرقم اليومية لها حدّها داخل المسار — هذا حد المصدر. */
export const BOOK_RATE_LIMIT = {
  maximum: envNumber("BOOK_RATE_MAX", 30),
  windowMinutes: envNumber("BOOK_RATE_WINDOW_MIN", 15),
};

/** تسجيل الوصول الذاتي: هادئ بحكم طبيعته، والزحف عليه استطلاع. */
export const CHECKIN_RATE_LIMIT = {
  maximum: envNumber("CHECKIN_RATE_MAX", 60),
  windowMinutes: envNumber("CHECKIN_RATE_WINDOW_MIN", 15),
};

/** محادثة الذكاء الاصطناعي لكل مستخدم موثق: حماية تكلفة وانحدار خدمة. */
export const AI_CHAT_RATE_LIMIT = {
  maximum: envNumber("AI_CHAT_RATE_MAX", 30),
  windowMinutes: envNumber("AI_CHAT_RATE_WINDOW_MIN", 5),
};

/** اختبار اتصال المزود لكل مستخدم: كل اختبار نداء صادر فعلي. */
export const AI_PROVIDER_TEST_RATE_LIMIT = {
  maximum: envNumber("AI_PROVIDER_TEST_RATE_MAX", 10),
  windowMinutes: envNumber("AI_PROVIDER_TEST_RATE_WINDOW_MIN", 5),
};
