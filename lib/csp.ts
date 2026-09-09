/**
 * بناء سياسة Content Security Policy (CSP) — المصدر الواحد للحقيقة.
 *
 * تبني هنا فيُشاركها proxy (يضيف nonce لكل طلب) واختبارات الانحدار (S17)
 * والاختبارات على HTTP الحقيقي (S14). تغيير السياسة = تغيير هذا الملف وحده.
 *
 * القرارات الكبرى موثقة هنا لأنها قرارات أمنية لا تفاصيل شكلية:
 *
 * 1. `script-src` بـ nonce + `strict-dynamic` — لا `unsafe-inline` ولا `unsafe-eval`
 *    في الإنتاج إطلاقًا. الـnonce يُولَّد عشوائيًّا لكل طلب صفحة، و`strict-dynamic`
 *    يسمح للسكربت المحمّل بـnonce أن يحمّل تبعاته — وهذا نمط Next.js الرسمي.
 *    التطوير فقط يضيف `unsafe-eval` (يتطلبها React Refresh) — لا إنتاج.
 *
 * 2. `style-src 'unsafe-inline'` — Next.js وTailwind يحقنان أنماطًا داخلية؛
 *    حماية الأنماط بـnonce ممكنة لكنها هشة هنا ولا تحمي من هجوم فعلي ذي معنى
 *    (السكربت هو الخطر، لا اللون). قرار مقصود وموثَّق.
 *
 * 3. `media-src 'self' blob:` — التسجيل الصوتي للرسائل يصنع Blob URLs.
 * 4. `img-src 'self' data: blob:` — الصور السريرية من خادمنا + أيقونات data URI.
 * 5. `connect-src 'self'` — لا اتصال خارجي من المتصفح إطلاقًا: لا تحليلات ولا
 *    خطوط خارجية ولا CDN. تطبيق intranet طبي.
 * 6. `frame-ancestors` — قرار مبني على فحص الكود الفعلي: لا توجد أي صفحة HTML
 *    تُضمَّن في iframe، لكن يوجد استخدام إنتاجي حقيقي واحد: معاينة PDF داخل
 *    لوحة الطاقم عبر <iframe src="/api/documents/{id}"> (components/PatientDocuments.tsx)
 *    — تضمين نفس-الأصل لمسار API واحد لا لصفحات. فالسياسة: كل الصفحات
 *    `frame-ancestors 'none'` (لا أحد يضمّن لوحة الطاقم)، ومسار مستند واحد
 *    يُسمح له بـ`'self'` حصرًا — لا wildcard ولا أصل خارجي في أي حال.
 */

export interface CspOptions {
  /** قيمة عشوائية لكل طلب — يولدها proxy بـ crypto.randomUUID (متاح في Edge). */
  nonce: string;
  /** الإنتاج أم لا؟ التطوير يضيف 'unsafe-eval' لـReact Refresh. */
  isProduction: boolean;
  /**
   * من يُسمح له بتضمين هذا المورد؟ الافتراضي 'none' لكل شيء، ما عدا مسار
   * معاينة المستندات نفسه حيث يسمح التطبيق لنفسه ('self') بلا أي أصل خارجي.
   */
  frameAncestors?: "'none'" | "'self'";
}

/** هل قيمة nonce آمنة للاستخدام داخل الترويسة؟ (لا CRLF ولا فواصل.) */
export function isValidNonce(nonce: string): boolean {
  return typeof nonce === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(nonce);
}

/**
 * السياسة كاملة كسطر واحد — الترويسات لا تحتمل سطورًا متعددة.
 * الترتيب مقصود: الأقرب إلى الوحدة القابلة للقراءة البشرية.
 */
export function buildCspHeaderValue({
  nonce,
  isProduction,
  frameAncestors = "'none'",
}: CspOptions): string {
  const scriptSrc = isProduction
    ? `'self' 'nonce-${nonce}' 'strict-dynamic'`
    : `'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`;

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
    ...(isProduction ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/**
 * ترويسات الأمان الثابتة التي لا تعتمد على الطلب — تُطبَّق من next.config.mjs
 * على كل المسارات (بما فيها الأصول الساكنة)، وتُصدَّر هنا لتقرأها اختبارات
 * الانحدار فيطالب CI بها إن اختفت.
 *
 * HSTS يُضبط في الإنتاج فقط (production HTTPS): القيمة المحافظة بلا preload
 * وبلا includeSubDomains — لا نعرف بعد نطاقات Railway الفرعية كلها،
 * وإرسال preload على نطاقٍ لا يملكه المشغّل بالكامل قرار لا رجعة فيه عمليًّا.
 *
 * Permissions-Policy: الميكروفون مسموح لنفس الأصل فقط — التطبيق يسجّل الصوت
 * في محادثة الطبيب والمريض؛ البقية مغلقة كليًّا (كاميرا/موقع/دفع/USB/المواضيع).
 */
export const STATIC_SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  {
    key: "Permissions-Policy",
    value: "microphone=(self), camera=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

export const HSTS_HEADER = { key: "Strict-Transport-Security", value: "max-age=31536000" };
