/**
 * بوابة الطلبات الصادرة الوحيدة — حماية SSRF لمزودي الذكاء الاصطناعي وقنوات الرسائل (P2/S7).
 *
 * الدوال المتزامنة النقية محفوظة في `lib/safe-outbound-url-pure.ts` لتعمل في المتصفح
 * والخادم معًا دون استيراد وحدات `node:*` داخل حزم الواجهة، بينما يُعيد هذا الملف
 * تصديرها ويضيف طبقة حل DNS الحية (`node:dns/promises`) على الخادم.
 */

import dns from "node:dns/promises";
import {
  ALLOWED_PUBLIC_SMTP_PORTS,
  BUILTIN_PROVIDER_HOSTS,
  detectIpFamily,
  FORBIDDEN_CUSTOM_HEADERS,
  isPrivateOrSpecialIp,
  SAFE_FETCH_INIT,
  sanitizeCustomHeaders,
  validateMessagingOutboundUrl,
  validateOutboundUrl,
  validatePublicSmtpHostAndPort,
  type OutboundPolicy,
  type SafeUrlResult,
} from "./safe-outbound-url-pure";

export {
  ALLOWED_PUBLIC_SMTP_PORTS,
  BUILTIN_PROVIDER_HOSTS,
  FORBIDDEN_CUSTOM_HEADERS,
  isPrivateOrSpecialIp,
  SAFE_FETCH_INIT,
  sanitizeCustomHeaders,
  validateMessagingOutboundUrl,
  validateOutboundUrl,
  validatePublicSmtpHostAndPort,
  type OutboundPolicy,
  type SafeUrlResult,
};

/**
 * الطبقة الخامسة: حل DNS (A + AAAA) والتأكد أن كل عنوان عام.
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
  const family = detectIpFamily(hostname);
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

export interface MessagingOutboundPolicy {
  resolveDns?: (hostname: string) => Promise<string[]>;
  /** لتجاوز `dns.lookup` الحي فقط عند حقن `fetchImpl` وهمي في اختبارات الوحدة المعزولة (ما لم يُمرَّر `resolveDns` صراحةً). */
  skipLiveDns?: boolean;
}

export async function assertSafeMessagingOutboundUrl(
  rawUrl: string,
  policy: MessagingOutboundPolicy = {},
): Promise<SafeUrlResult> {
  const structural = validateMessagingOutboundUrl(rawUrl);
  if (!structural.ok || !structural.hostname) return structural;
  if (policy.skipLiveDns && !policy.resolveDns) {
    return structural;
  }
  const dnsCheck = await assertResolvablePublicHost(structural.hostname, {
    resolveDns: policy.resolveDns,
  });
  if (!dnsCheck.ok) return dnsCheck;
  return structural;
}

export async function assertSafePublicSmtpTarget(
  host: string,
  port: number,
  options: { allowDevPorts?: boolean; resolveDns?: (hostname: string) => Promise<string[]>; skipLiveDns?: boolean } = {},
): Promise<SafeUrlResult> {
  const structural = validatePublicSmtpHostAndPort(host, port, options);
  if (!structural.ok || !structural.hostname) return structural;
  if (options.skipLiveDns && !options.resolveDns) return structural;
  const dnsCheck = await assertResolvablePublicHost(structural.hostname, {
    resolveDns: options.resolveDns,
  });
  if (!dnsCheck.ok) return dnsCheck;
  return structural;
}
