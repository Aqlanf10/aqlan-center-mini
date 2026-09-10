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

/* ─── (P2-FIX-4) أخطاء مزودي الذكاء الاصطناعي ───────────────────────────────
 *
 * القاعدة: ما يردّه المزود الخارجي (payload.error.message وerr.message)
 * **بيانات غير موثوقة** — قد تحمل روابط داخلية، مسارات، روابط قاعدة، مفاتيح
 * Authorization، أو لمة تشخيصية كاملة من طرفٍ بعيد. لا يُعاد خاماً للعميل
 * ولا يُخزَّن في last_test_message ولا في سجل التدقيق.
 *
 * sanitizeProviderDetail تفحص التفصيلة الخام: إن لم تحمل أي نمط حساس تعيد
 * ملخصاً مُقيَّداً بسطرٍ واحد وطولٍ محدود؛ وإلا تعيد null فيصدر التصنيف
 * العام الآمن (مرفوض/مهلة/غير متاح/إعداد) بلا أي تفصيلة.
 */

/** أنماط الأسرار والتفاصيل الداخلية المحظورة في أي تفصيلة مزود. */
const PROVIDER_DETAIL_FORBIDDEN: RegExp[] = [
  /postgres(ql)?:\/\//i,                    // روابط قاعدة البيانات
  /database[_-]?url/i,
  /session[_-]?secret/i,
  /authorization\s*:\s*bearer/i,            // ترويسات توثيق كاملة
  /bearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bsk-[A-Za-z0-9_-]{8,}/,                 // مفاتيح OpenAI-style
  /\bsk-ant-[A-Za-z0-9_-]{8,}/,
  /\bAIza[A-Za-z0-9_-]{8,}/,                // مفاتيح Google
  /\bgsk_[A-Za-z0-9_-]{8,}/,                // مفاتيح Groq
  /api[_-]?key\s*[:=]/i,
  /(\/home\/|\/var\/|\/app\/|\/root\/|[A-Za-z]:\\)/, // مسارات ملفات
  /at\s+[\w$.<>]+\s+\(?.+:\d+:\d+\)?/,      // أسطر stack trace
  /node_modules/i,
  /BEGIN (RSA )?PRIVATE KEY/,
];

/** الحد الأقصى لطول الملخص الآمن — تلخيص مُقيَّد لا نصٍّ مفتوح. */
const PROVIDER_DETAIL_MAX_LENGTH = 160;

/**
 * تفحص تفصيلة خطأٍ من مزودٍ خارجي وتريحها إن كانت بريئة محدودة، أو null
 * إن حملت سراً/مساراً/تفصيلاً داخلياً — فيصدر التصنيف العام الآمن.
 */
export function sanitizeProviderDetail(
  raw: string | null | undefined,
  maxLength: number = PROVIDER_DETAIL_MAX_LENGTH,
): string | null {
  if (typeof raw !== "string") return null;
  const detail = raw.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (!detail || detail.length === 0) return null;
  if (detail.length > 1000) return null; // لمة تشخيصية ضخمة — لا مجمل لها
  for (const pattern of PROVIDER_DETAIL_FORBIDDEN) {
    if (pattern.test(detail)) return null;
  }
  if (detail.length > maxLength) {
    return `${detail.slice(0, maxLength - 1)}…`;
  }
  return detail;
}

/** تصنيف آمن عام لفشل مزود — بلا أي تفصيلة خام. */
export function providerFailureCategory(status: number | null): string {
  if (status === null) return "تعذّر الوصول إلى خدمة المزوّد.";
  if (status === 401 || status === 403) return "المزوّد رفض بيانات الاعتماد.";
  if (status === 402 || status === 429) return "حصة المزوّد أو حدّ الاستخدام."
  if (status === 404) return "مسار المزوّد أو النموذج غير موجود.";
  if (status >= 500) return "عطل لدى المزوّد.";
  return `المزوّد رفض الطلب (رمز ${status}).`;
}
