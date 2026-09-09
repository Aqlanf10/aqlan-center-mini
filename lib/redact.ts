/**
 * تعقيم السجلات والرسائل — P2/S13.
 *
 * القاعدة: ما لا يجوز أن يخرج من الخادم لا يجوز أن يدخل سجل التدقيق
 * أصلًا — التسريب من السجلات أسهل من التسريب من الردود لأنها تُقرأ
 * بتاريخها الكامل، ومن صلاحيات أعرض.
 *
 * هذا المساعد يُستخدم في مواضع التدقيق التي تلمس بيانات مزودين أو
 * أخطاء خام، ويرفض تخزين: كلمات المرور، مفاتيح API، توكن الجلسات،
 * ترويسات Authorization كاملة، وروابط القاعدة والسر.
 */

const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /pass(word)?/i,
  /secret/i,
  /api[-_]?key/i,
  /token/i,
  /authorization/i,
  /cookie/i,
  /credential/i,
  /private[-_]?key/i,
];

const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /^scrypt:/i,          // تجزئة كلمة مرور خام
  /^Bearer\s+[A-Za-z0-9._-]+$/i, // ترويسة توكن كاملة
  /^sk-[A-Za-z0-9_-]{8,}/, // مفاتيح OpenAI-style
  /^sk-ant-[A-Za-z0-9_-]{8,}/, // مفاتيح Anthropic
  /^AIza[A-Za-z0-9_-]{8,}/, // مفاتيح Google
  /^gsk_[A-Za-z0-9]+$/, // مفاتيح Groq
];

const VALUE_PLACEHOLDER = "[معقّم]";

/** هل يبدو نص المفتاح حساسًا؟ */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/** هل تبدو قيمة النص سرًّا معروف الشكل؟ */
function looksLikeSecretValue(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

/** يعقّم أي كائن تفاصيل قبل دخوله سجل التدقيق — نسخة جديدة لا تعديل الأصل. */
export function redactDetails(details: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(details)) {
    if (isSensitiveKey(key)) {
      clean[key] = VALUE_PLACEHOLDER;
      continue;
    }
    if (typeof raw === "string" && looksLikeSecretValue(raw)) {
      clean[key] = VALUE_PLACEHOLDER;
      continue;
    }
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      clean[key] = redactDetails(raw as Record<string, unknown>);
      continue;
    }
    clean[key] = raw;
  }
  return clean;
}

/**
 * رسالة خطأ آمنة للعميل: تسقط stack traces ومسارات ملفات وأسرار البيئة.
 * تُستخدم في المسارات التي كان خطأها الخام يخرج كما هو.
 */
export function sanitizeErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message;
  // أي ذكر لسرٍّ أو رابط قاعدة يُبدَّل بالجواب العام — لا ننقل تفاصيل النقل.
  if (/SESSION_SECRET|DATABASE_URL|DATABASE_SSL|postgres(ql)?:\/\//i.test(message)) {
    return fallback;
  }
  if (message.includes("/") && /\/home\/|\/var\/|\/app\/|\\/.test(message)) {
    return fallback;
  }
  return message.length > 300 ? fallback : message;
}
