/**
 * بوابة الطلبات الصادرة الوحيدة — حماية SSRF لمزودي الذكاء الاصطناعي (P2/S7).
 *
 * المشكلة: validateProviderInput كان يقبل أي `http(s)://...` يكتبه المدير، ثم
 * تنفذ المحولات fetch من الخادم إلى العنوان الناتج. المهاجم الذي يصل إلى
 * لوحة الإعدادات (أو مدير مخدوع) يستطيع توجيه الخادم نفسه إلى:
 *   • خدمات البيانات الوصفية للسحابة (169.254.169.254)
 *   • قاعدة بياناتنا أو خدمات داخلية على الشبكة الخاصة
 *   • أي منفذ على الخادم نفسه
 * فيقرأ الرد ويعيده داخل رسالة خطأ المزود. هذه فئة SSRF كاملة، وبوابتها
 * هذا الملف: كل طلب صادر نحو مزود يجب أن يمر من هنا — save validation،
 * test connection، chat، fallback، custom-http.
 *
 * التصميم:
 *   1. تحليل بـ`new URL()` فقط — لا regex وحدها (شرط صريح من المواصفة).
 *   2. رفض بروتوكولات غير http/https، رفض userinfo، رفض أجزاء غير لازمة،
 *      منافذ مشوهة/خطيرة (0 إلى 65535 فقط).
 *   3. أسماء النطاقات المحجوبة: localhost و.local والنطاقات الداخلية غير
 *      المصرح بها، وكل مدى IP الخاص/الخاص الاستخدام (RFC1918، loopback،
 *      link-local، multicast، unspecified، IPv6 ULA/IPv4-mapped/IPv6-mapped).
 *   4. في الإنتاج: HTTPS فقط + المضيف ضمن قائمة المزودات المعروفة أو
 *      AI_PROVIDER_ALLOWED_HOSTS الصريحة — لا مضيف اعتباطي يكتبه أحد.
 *      HTTP مسموح في التطوير/الاختبار فقط (Ollama المحلي مثلًا).
 *   5. حل DNS (A + AAAA) قبل الاتصال: أي عنوان يقع في مدى خاص/خاص
 *      الاستخدام ⇒ رفض. سجلات مختلطة عام+خاص ⇒ رفض (شرط صريح).
 *   6. `redirect: "error"` في كل fetch صادر — لا تتبع لأي تحويل يغيّر المضيف.
 *
 * حدود معلنة بصدق: التحقق ثم الاتصال ينفصلان بثانية TOCTOU — تثبيت DNS
 * على الاتصال نفسه يتطلب وكيل اتصال مخصصًا لكل مضيف، وفيه نقطة فشل تشغيلية
 * أكبر من نافذة السباق هذه. خطر DNS rebinding موثَّق كمخاطرة متبقية في
 * docs/SECURITY_HARDENING_P2.md — لا ندّعي حماية كاملة منه.
 */

import { isIP } from "node:net";
import dns from "node:dns/promises";

/** نتيجة موحدة: أسباب الرفض عربية لأنها تُعرض للمدير في واجهة الإعدادات. */
export interface SafeUrlResult {
  ok: boolean;
  /** سبب الرفض حين ok=false — نص آمن للعرض، بلا عنوان داخلي تفصيلي زائد. */
  reason?: string;
  /** العنوان النهائي المتحقق منه حين ok=true. */
  url?: string;
  /** المضيف بعد التطبيع. */
  hostname?: string;
}

/** المضيفات المعروفة للمزودات المبنية داخل المنتج — من presets الجاهزة. */
export const BUILTIN_PROVIDER_HOSTS: ReadonlySet<string> = new Set([
  "api.openai.com",
  "api.z.ai",
  "api.deepseek.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "api.groq.com",
]);

/** أسماء نطاقات محجوبة بالاسم بغض النظر عن العنوان الذي تحله. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

/** نطاقات لاحقة محجوبة كاملة. */
const BLOCKED_HOSTNAME_SUFFIXES = [".local", ".internal", ".localhost"];

/**
 * قائمة AI_PROVIDER_ALLOWED_HOSTS من البيئة — يضيفها المشغّل صراحة
 * لمزود مخصص داخل نشره. تُقرأ عند كل استدعاء لا تُخزَّن مؤقتًا: تغييرها
 * بلا إعادة نشر يبقى قرارًا صريحًا مرئيًّا في مكان واحد.
 */
function allowedHostsFromEnv(): Set<string> {
  const raw = process.env.AI_PROVIDER_ALLOWED_HOSTS ?? "";
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0 && entry.length <= 253 && !entry.includes("/"));
  return new Set(parsed);
}

export interface OutboundPolicy {
  /**
   * في الإنتاج: HTTPS فقط + قائمة مضيفين إلزامية (مدمجة أو صريحة من البيئة).
   * في التطوير/الاختبار: HTTP مسموح لأي مضيف عام (Ollama المحلي مثلًا)،
   * والمدى الخاص يبقى محجوبًا دائمًا مهما كان السياق.
   */
  isProduction: boolean;
  /** دالة حل DNS قابلة للحقن في الاختبارات — الافتراضية node:dns/promises. */
  resolveDns?: (hostname: string) => Promise<string[]>;
}

/** هل هذا المضيف اسم نطاق محجوب بالاسم أو باللاحقة؟ */
function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  return BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * هل هذا العنوان IP يقع في مدى خاص أو خاص الاستخدام أو خطير؟
 * تشمل: loopback (v4/v6)، RFC1918، link-local، multicast، unspecified،
 * بطاقات IPv4 داخل IPv6 (::ffff:10.0.0.1)، ULA (fc00::/7)، وIPv6 loopback.
 */
export function isPrivateOrSpecialIp(address: string): boolean {
  const plain = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  // IPv4-mapped IPv6 بنسختيه: ::ffff:10.0.0.1 (عشرية منقوطة) و::ffff:a00:1
  // (سداسية عشرية — شكل new URL بعد التطبيع). كلاهما يُفك إلى v4 ويُحكم عليه.
  const dottedMapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(plain);
  if (dottedMapped) return isPrivateOrSpecialIp(dottedMapped[1]);
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(plain);
  if (hexMapped) {
    const high = parseInt(hexMapped[1], 16);
    const low = parseInt(hexMapped[2], 16);
    const dotted = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
    return isPrivateOrSpecialIp(dotted);
  }
  const candidate = plain;

  const family = isIP(candidate);
  if (family === 4) {
    const [a, b] = candidate.split(".").map((part) => Number(part));
    if (
      a === 0 ||                                   // 0.0.0.0/8 — unspecified
      a === 10 ||                                  // 10.0.0.0/8 — RFC1918
      a === 127 ||                                 // 127.0.0.0/8 — loopback
      (a === 100 && b >= 64 && b <= 127) ||        // 100.64.0.0/10 — CGNAT
      (a === 169 && b === 254) ||                  // 169.254.0.0/16 — link-local + metadata
      (a === 172 && b >= 16 && b <= 31) ||         // 172.16.0.0/12 — RFC1918
      (a === 192 && b === 168) ||                  // 192.168.0.0/16 — RFC1918
      a >= 224                                    // 224.0.0.0/3 — multicast + reserved
    ) {
      return true;
    }
    return false;
  }
  if (family === 6) {
    const normalized = candidate.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      normalized === "::" || normalized === "::1" ||      // unspecified + loopback
      normalized.startsWith("fe80") ||                    // link-local
      normalized.startsWith("fc") || normalized.startsWith("fd") || // ULA fc00::/7
      normalized.startsWith("ff")                         // multicast
    ) {
      return true;
    }
    return false;
  }
  // ليس عنوان IP سليمًا: نترك الحكم لطبقة اسم النطاق.
  return false;
}

/** ترويسات لا يُسمح لمزود مخصص أن يضبطها — تُغيّر مسار النقل نفسه. */
export const FORBIDDEN_CUSTOM_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "cookie",
  "authorization",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "forwarded",
]);

/**
 * ينظف ترويسات المزود المخصصة: يرفض المحظورة كليًّا (بلا استثناء — إعداد
 * يتضمنها يُرفض عند الحفظ لا عند الاتصال)، ويسلم الباقي كما هو.
 * Authorization يديره المحول نفسه، فلا يجوز أن يمر عبر customHeaders.
 */
export function sanitizeCustomHeaders(
  headers: Record<string, string> | null | undefined,
): { ok: boolean; reason?: string; headers: Record<string, string> } {
  if (!headers) return { ok: true, headers: {} };
  const clean: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim().toLowerCase();
    if (!name || name.includes(":") || /[\r\n]/.test(rawName) || /[\r\n]/.test(String(rawValue))) {
      return { ok: false, reason: "ترويسة مخصصة غير صالحة.", headers: {} };
    }
    if (FORBIDDEN_CUSTOM_HEADERS.has(name)) {
      return {
        ok: false,
        reason: `الترويسة «${rawName}» محجوبة في إعدادات المزود — يديرها النظام نفسه.`,
        headers: {},
      };
    }
    // الاسم الأصلي كما كتبه المدير (HTTP غير حساس لحالة الأحرف أصلًا) —
    // الفحص يجري على الصغيرة، والتمرير على الشكل الأصلي.
    clean[rawName] = String(rawValue);
  }
  return { ok: true, headers: clean };
}

/**
 * التحقق الكامل من عنوان صادر — طبقة 1 و2 و3 و4 (بلا DNS).
 * نقية ومتزامنة: تصلح للتحقق عند الحفظ وعند الاتصال معًا.
 */
export function validateOutboundUrl(
  rawUrl: string,
  policy: Pick<OutboundPolicy, "isProduction">,
): SafeUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: "عنوان غير صالح." };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "البروتوكولات المسموحة HTTPS فقط (وHTTP للتطوير المحلي)." };
  }
  if (policy.isProduction && parsed.protocol !== "https:") {
    return { ok: false, reason: "في الإنتاج يُسمح بـHTTPS فقط لمزودي الذكاء الاصطناعي." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "لا يُسمح بمعلومات مستخدم (userinfo) داخل العنوان." };
  }
  if (parsed.hash) {
    return { ok: false, reason: "لا داعي للجزء المُجزَّأ (fragment) في عنوان مزود." };
  }
  if (parsed.search) {
    // مسموح: مفاتيح API على مسار gemini. لكن نرفض أي query يبدو ترويسة نقل.
    const suspicious = /[?&](redirect|redirect_uri|callback|next|url)=/i.test(parsed.search);
    if (suspicious) {
      return { ok: false, reason: "سلسلة الاستعلام تحتوي تحويلًا غير مسموح." };
    }
  }

  const port = parsed.port;
  if (port) {
    const numeric = Number(port);
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
      return { ok: false, reason: "منفذ غير صالح." };
    }
    if (numeric === 22 || numeric === 23 || numeric === 25 || numeric === 110 || numeric === 143) {
      return { ok: false, reason: "منفذ خدمة غير مسموح." };
    }
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // حيلة المضيف المشفر: URL يطبّع %XX في hostname، لكن أي بقية غير ASCII
  // أو محارف تحكم بعد التطبيع = محاولة تضليل — ترفض.
  if (/[^\x20-\x7e]/.test(hostname) || /[\s/\\@]/.test(hostname) || hostname.includes("..")) {
    return { ok: false, reason: "اسم مضيف غير صالح." };
  }
  if (hostname.length === 0 || hostname.length > 253) {
    return { ok: false, reason: "اسم مضيف غير صالح." };
  }
  if (isBlockedHostname(hostname)) {
    return { ok: false, reason: "أسماء المضيفات الداخلية والمحلية محجوبة." };
  }
  /* اسم أحادي بلا نقطة (مثل "path-only" أو اسم جهاز داخلي): يُحل عبر
     نطاقات البحث الداخلية للمؤسسة لا عبر DNS العام — يرفض حصرًا. المزودون
     الحقيقيون كلهم FQDN بنقطة واحدة على الأقل. */
  if (!isIP(hostname) && !hostname.includes(".")) {
    return { ok: false, reason: "اسم المضيف يجب أن يكون نطاقًا مؤهلًا كاملاً (FQDN)." };
  }

  const family = isIP(hostname);
  if (family !== 0) {
    if (isPrivateOrSpecialIp(hostname)) {
      return { ok: false, reason: "العناوين الداخلية/الخاصة محجوبة في طلبات المزودين." };
    }
  }

  if (policy.isProduction) {
    // قائمة المضيفين الإلزامية: مدمجة أو صريحة من المشغّل — لا غير.
    const allowed = allowedHostsFromEnv();
    if (!BUILTIN_PROVIDER_HOSTS.has(hostname) && !allowed.has(hostname)) {
      return {
        ok: false,
        reason: "في الإنتاج يجب أن يكون مضيف المزود من القائمة المعروفة أو مضافًا صراحةً في AI_PROVIDER_ALLOWED_HOSTS.",
      };
    }
  }

  return { ok: true, url: parsed.toString(), hostname };
}

/**
 * الطبقة الخامسة: حل DNS (A + AAAA) والتأكد أن كل عنوان عام.
 * فشل الحل نفسه ليس "آمنًا": المزود غير القابل للحل لا يمكن الوصول إليه،
 * لكن نترك الخطأ الأصلي يظهر (فشل الاتصال) لا نبتكر سببًا أمنيًّا وهميًّا.
 */
export async function assertResolvablePublicHost(
  hostname: string,
  policy: Pick<OutboundPolicy, "resolveDns"> = {},
): Promise<SafeUrlResult> {
  const resolve = policy.resolveDns ?? defaultResolveDns;
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    return { ok: false, reason: `تعذر حل اسم المضيف «${hostname}» — تحقق من العنوان.` };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: `لا يوجد عنوان لهذا المضيف.` };
  }
  for (const address of addresses) {
    if (isPrivateOrSpecialIp(address)) {
      return { ok: false, reason: "اسم المضيف يحلّ إلى عنوان داخلي/خاص — محجوب." };
    }
  }
  return { ok: true, hostname };
}

async function defaultResolveDns(hostname: string): Promise<string[]> {
  const family = isIP(hostname);
  if (family !== 0) return [hostname]; // عنوان IP حرفي: لا حلّ DNS.
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
  } catch {
    return [];
  }
}

/**
 * التحقق الكامل المُستخدم قبل كل اتصال صادر: البنية + السياسة + DNS.
 * هذا ما تستدعيه المحولات قبل fetch — وعليه تُبنى اختبارات SSRF الإلزامية.
 */
export async function assertSafeOutboundUrl(
  rawUrl: string,
  policy: OutboundPolicy,
): Promise<SafeUrlResult> {
  const structural = validateOutboundUrl(rawUrl, policy);
  if (!structural.ok || !structural.hostname) return structural;
  const dnsCheck = await assertResolvablePublicHost(structural.hostname, policy);
  if (!dnsCheck.ok) return dnsCheck;
  return structural;
}

/**
 * خيارات fetch الآمنة القياسية لطلبات المزودين: لا تتبع أي تحويل.
 * أي redirect من المزود يعني أن الوجهة الأولى ليست الوجهة الحقيقية —
 * ولا نتحقق من الوجهة الثانية نيابة عن المهاجم. لو احتاجت الحاجة يومًا
 * تحويلات، فيجب إعادة التحقق الكامل لكل hop مع حد أدنى جدًّا (موثَّق).
 */
export const SAFE_FETCH_INIT = Object.freeze({ redirect: "error" }) as RequestInit;
