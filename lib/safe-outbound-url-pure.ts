/**
 * الطبقة النقية المتزامنة لبوابة الحماية من SSRF (تعمل في المتصفح والخادم بلا وحدات `node:*`).
 *
 * فصلت هذه الدوال عن `lib/safe-outbound-url.ts` لأن `lib/messaging-channels.ts`
 * يُستورد داخل مكوّنات الواجهة (`"use client"`) لتطبيع إعدادات القنوات، بينما
 * تبقى فحوص DNS الحية (`node:dns/promises`) في `lib/safe-outbound-url.ts` للخادم فقط.
 */

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

function allowedHostsFromEnv(): Set<string> {
  const raw = typeof process !== "undefined" ? (process.env?.AI_PROVIDER_ALLOWED_HOSTS ?? "") : "";
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
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  return BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function isStrictIPv4(candidate: string): boolean {
  if (!/^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/.test(candidate)) {
    return false;
  }
  const parts = candidate.split(".");
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
  }
  return true;
}

function isStrictIPv6(rawCandidate: string): boolean {
  let candidate = rawCandidate;
  const zoneIdx = candidate.indexOf("%");
  if (zoneIdx !== -1) {
    const zone = candidate.slice(zoneIdx + 1);
    if (!zone || !/^[A-Za-z0-9._-]+$/.test(zone)) return false;
    candidate = candidate.slice(0, zoneIdx);
  }
  if (!candidate || candidate.includes(":::")) return false;
  if ((candidate.startsWith(":") && !candidate.startsWith("::")) || (candidate.endsWith(":") && !candidate.endsWith("::"))) {
    return false;
  }

  const hexGroup = /^[0-9a-fA-F]{1,4}$/;
  const doubleColonParts = candidate.split("::");
  if (doubleColonParts.length > 2) return false;

  if (doubleColonParts.length === 2) {
    const [left, right] = doubleColonParts;
    const leftGroups = left ? left.split(":") : [];
    const rightGroups = right ? right.split(":") : [];
    for (const g of leftGroups) {
      if (!hexGroup.test(g)) return false;
    }
    let rightCount = 0;
    for (let i = 0; i < rightGroups.length; i++) {
      const g = rightGroups[i];
      const isLast = i === rightGroups.length - 1;
      if (isLast && g.includes(".")) {
        if (!isStrictIPv4(g)) return false;
        rightCount += 2;
      } else {
        if (!hexGroup.test(g)) return false;
        rightCount += 1;
      }
    }
    return leftGroups.length + rightCount < 8;
  }

  const groups = candidate.split(":");
  if (groups[groups.length - 1]?.includes(".")) {
    if (groups.length !== 7) return false;
    for (let i = 0; i < 6; i++) {
      if (!hexGroup.test(groups[i])) return false;
    }
    return isStrictIPv4(groups[6]);
  }
  if (groups.length !== 8) return false;
  return groups.every((g) => hexGroup.test(g));
}

/** مكافئ نقي متوافق مع `node:net` `isIP` يعمل في المتصفح والخادم معًا. */
export function detectIpFamily(candidate: string): 0 | 4 | 6 {
  if (isStrictIPv4(candidate)) return 4;
  if (isStrictIPv6(candidate)) return 6;
  return 0;
}

/**
 * هل هذا العنوان IP يقع في مدى خاص أو خاص الاستخدام أو خطير؟
 * تشمل: loopback (v4/v6)، RFC1918، link-local، multicast، unspecified،
 * بطاقات IPv4 داخل IPv6 (::ffff:10.0.0.1)، ULA (fc00::/7)، وIPv6 loopback.
 */
export function isPrivateOrSpecialIp(address: string): boolean {
  const plain = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
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

  const family = detectIpFamily(candidate);
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
    const normalized = candidate.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
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
    clean[rawName] = String(rawValue);
  }
  return { ok: true, headers: clean };
}

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

  if (/[^\x20-\x7e]/.test(hostname) || /[\s/\\@]/.test(hostname) || hostname.includes("..")) {
    return { ok: false, reason: "اسم مضيف غير صالح." };
  }
  if (hostname.length === 0 || hostname.length > 253) {
    return { ok: false, reason: "اسم مضيف غير صالح." };
  }
  if (isBlockedHostname(hostname)) {
    return { ok: false, reason: "أسماء المضيفات الداخلية والمحلية محجوبة." };
  }
  const family = detectIpFamily(hostname);
  if (family === 0 && !hostname.includes(".")) {
    return { ok: false, reason: "اسم المضيف يجب أن يكون نطاقًا مؤهلًا كاملاً (FQDN)." };
  }
  if (family !== 0 && isPrivateOrSpecialIp(hostname)) {
    return { ok: false, reason: "العناوين الداخلية/الخاصة محجوبة في طلبات المزودين." };
  }

  if (policy.isProduction) {
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

export const SAFE_FETCH_INIT = Object.freeze({ redirect: "error" }) as RequestInit;

const ALLOWED_MESSAGING_HTTPS_PORTS = new Set(["", "443", "8443"]);
export const ALLOWED_PUBLIC_SMTP_PORTS = new Set([465, 587, 2525]);

export function validateMessagingOutboundUrl(rawUrl: string): SafeUrlResult {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048 || /[\r\n\0]/.test(trimmed)) {
    return { ok: false, reason: "عنوان البوابة غير صالح." };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "عنوان البوابة غير صالح." };
  }
  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: "عنوان البوابة يجب أن يبدأ بـ https:// — لا يُرسل المفتاح بلا تشفير.",
    };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "لا يُسمح بتضمين اسم مستخدم أو كلمة مرور داخل عنوان البوابة." };
  }
  if (parsed.hash) {
    return { ok: false, reason: "عنوان البوابة لا يقبل مقاطع تجزئة (#)." };
  }
  if (!ALLOWED_MESSAGING_HTTPS_PORTS.has(parsed.port)) {
    return { ok: false, reason: "منفذ عنوان البوابة غير مسموح به (استعمل منفذ HTTPS القياسي 443 أو 8443)." };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    /[^\x20-\x7e]/.test(hostname) ||
    /[\s/\\@]/.test(hostname) ||
    hostname.includes("..")
  ) {
    return { ok: false, reason: "اسم مضيف البوابة غير صالح." };
  }
  if (isBlockedHostname(hostname)) {
    return { ok: false, reason: "أسماء المضيفات الداخلية والمحلية محجوبة أمنيًّا." };
  }
  const family = detectIpFamily(hostname);
  if (family === 0 && !hostname.includes(".")) {
    return { ok: false, reason: "اسم مضيف البوابة يجب أن يكون نطاقًا عامًّا مؤهلًا (FQDN)." };
  }
  if (family !== 0 && isPrivateOrSpecialIp(hostname)) {
    return { ok: false, reason: "العناوين الداخلية والخاصة محجوبة في قنوات الرسائل." };
  }
  return { ok: true, url: parsed.toString(), hostname };
}

export function validatePublicSmtpHostAndPort(
  host: string,
  port: number,
  options: { allowDevPorts?: boolean } = {},
): SafeUrlResult {
  const rawHostname = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !rawHostname ||
    rawHostname.length > 200 ||
    !/^[a-z0-9.:-]+$/.test(rawHostname) ||
    rawHostname.includes("..")
  ) {
    return { ok: false, reason: "اسم خادم البريد غير صالح." };
  }
  let hostname = rawHostname;
  let family = detectIpFamily(hostname);
  if (family === 0) {
    try {
      const parsedHost = new URL(hostname.includes(":") ? `http://[${hostname}]` : `http://${hostname}`);
      hostname = parsedHost.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      family = detectIpFamily(hostname);
    } catch {
      return { ok: false, reason: "اسم خادم البريد غير صالح." };
    }
  }
  if (isBlockedHostname(hostname)) {
    return { ok: false, reason: "لا يُسمح بربط خادم البريد بعناوين محلية أو داخلية." };
  }
  if (family === 0 && !hostname.includes(".")) {
    return { ok: false, reason: "اسم خادم البريد يجب أن يكون نطاقًا عامًّا مؤهلًا (FQDN)." };
  }
  if (family !== 0 && isPrivateOrSpecialIp(hostname)) {
    return { ok: false, reason: "لا يُسمح بربط خادم البريد بعناوين شبكة خاصة أو داخلية." };
  }
  const allowedPorts = options.allowDevPorts
    ? new Set([...ALLOWED_PUBLIC_SMTP_PORTS, 25, 1025])
    : ALLOWED_PUBLIC_SMTP_PORTS;
  if (!Number.isInteger(port) || !allowedPorts.has(port)) {
    return {
      ok: false,
      reason: "منفذ خادم البريد غير مسموح به — استعمل منافذ الإرسال الموثقة (465 أو 587 أو 2525).",
    };
  }
  return { ok: true, hostname };
}
