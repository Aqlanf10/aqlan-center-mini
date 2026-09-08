/**
 * أدوات الشبكة الموثوقة — من يُصدَّق من ترويسات الطلب.
 *
 * الترويسات التي يكتبها العميل (Host، X-Forwarded-Host، X-Forwarded-For) لا
 * تُعامل كمصدر حقيقة إلا إذا كانت مصدرها وسيطًا موثوقًا أو تطابق قائمة نطاقات
 * يملكها المشغّل (TRUSTED_HOSTS). هذا هو خط الدفاع أمام حقن المضيف (Host
 * Header Injection) وإعادة التوجيه المفتوحة (Open Redirect) وتزوير بصمة المصدر.
 */

/** قائمة النطاقات الموثوقة من متغير البيئة TRUSTED_HOSTS (مفصولة بفواصل). */
let cachedAllowlist: Set<string> | null = null;
let cachedAllowlistSource: string | null = null;

function trustedHosts(): Set<string> {
  const raw = process.env.TRUSTED_HOSTS ?? "";
  if (cachedAllowlist && cachedAllowlistSource === raw) return cachedAllowlist;
  const entries = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0 && entry.length <= 253);
  cachedAllowlist = new Set(entries);
  cachedAllowlistSource = raw;
  return cachedAllowlist;
}

/** مضيفٌ صالح الشكل أم لا — قبل أي مقارنة: لا CRLF ولا مسارات ولا رموز حقن. */
function isPlausibleHost(host: string): boolean {
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(host) && !host.includes("..");
}

/**
 * هل يُوثق هذا المضيف (بمنفذه أو بدونه) من قائمة المشغّل؟
 * قائمة فارغة = لا يوثَق شيء: الإجابة النسبية الآمنة تُستخدم بدل المطلقة.
 */
export function isHostTrusted(host: string | null | undefined): boolean {
  if (typeof host !== "string") return false;
  const candidate = host.trim().toLowerCase().split(",")[0].trim();
  if (!candidate || !isPlausibleHost(candidate)) return false;
  const allowlist = trustedHosts();
  if (allowlist.size === 0) return false;
  const withoutPort = candidate.replace(/:\d{1,5}$/, "");
  return allowlist.has(candidate) || allowlist.has(withoutPort);
}

/**
 * عنوان العميل من X-Forwarded-For خلف وسيطٍ موثوق: **آخر** قيمة — فهي التي
 * أضافها الوسيط الموثوق نفسه، وأول قيمة يكتبها العميل فيمكنه تزويرها.
 */
export function clientIpFromForwardedFor(forwarded: string | null | undefined): string | null {
  if (typeof forwarded !== "string") return null;
  const parts = forwarded.split(",").map((part) => part.trim()).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last || !/^[0-9a-fA-F:.]+$/.test(last)) return null;
  return last;
}

/** أول قيمة ترويسة موثوقة الشكل (بلا إدخال سطر أو مسافات). */
export function firstHeaderEntry(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const first = value.split(",")[0].trim();
  return first.length > 0 ? first : null;
}
