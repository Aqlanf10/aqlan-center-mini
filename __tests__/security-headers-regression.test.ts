import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCspHeaderValue, STATIC_SECURITY_HEADERS, HSTS_HEADER } from "../lib/csp";

/**
 * اختبارات انحدار أمن الترويسات وCSP (P2/S17) — تفشل CI إذا اختفى أي
 * قرار أمني: CSP، nosniff، Referrer-Policy، HSTS، سياسة الإطارات،
 * Permissions-Policy، poweredByHeader=false — أو ظهر wildcard/unsafe-eval.
 */

const configSource = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
const proxySource = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");

const nonce = "test-nonce-0123456789abcdef";

describe("CSP — البناء والقرارات", () => {
  const productionCsp = buildCspHeaderValue({ nonce, isProduction: true });
  const devCsp = buildCspHeaderValue({ nonce, isProduction: false });

  it("الإنتاج: script-src بnonce + strict-dynamic، بلا unsafe-inline وunsafe-eval", () => {
    expect(productionCsp).toContain("script-src 'self' 'nonce-test-nonce-0123456789abcdef' 'strict-dynamic'");
    expect(productionCsp).not.toContain("unsafe-eval");
    expect(productionCsp).not.toContain("script-src 'unsafe-inline'");
  });
  it("التطوير فقط يضيف unsafe-eval (React Refresh)", () => {
    expect(devCsp).toContain("unsafe-eval");
  });
  it("لا wildcard خطير في script/connect/img/frame", () => {
    for (const directive of ["script-src", "connect-src", "frame-src", "img-src", "default-src"]) {
      const match = new RegExp(`${directive}[^;]*`).exec(productionCsp);
      if (match) expect(match[0]).not.toContain("*");
    }
  });
  it("السياسة الكاملة كما قررت المواصفة", () => {
    expect(productionCsp).toContain("default-src 'self'");
    expect(productionCsp).toContain("style-src 'self' 'unsafe-inline'");
    expect(productionCsp).toContain("img-src 'self' data: blob:");
    expect(productionCsp).toContain("font-src 'self' data:");
    expect(productionCsp).toContain("media-src 'self' blob:");       // تسجيل الصوت
    expect(productionCsp).toContain("connect-src 'self'");
    expect(productionCsp).toContain("worker-src 'self' blob:");      // service worker
    expect(productionCsp).toContain("manifest-src 'self'");          // PWA
    expect(productionCsp).toContain("object-src 'none'");
    expect(productionCsp).toContain("base-uri 'self'");
    expect(productionCsp).toContain("form-action 'self'");
    expect(productionCsp).toContain("frame-ancestors 'none'");
    expect(productionCsp).toContain("upgrade-insecure-requests");
  });
  it("مسار معاينة المستندات: frame-ancestors 'self' — وحدك", () => {
    const documentsCsp = buildCspHeaderValue({ nonce, isProduction: true, frameAncestors: "'self'" });
    expect(documentsCsp).toContain("frame-ancestors 'self'");
    // لا يفتح أي أصل خارجي في أي حال:
    expect(documentsCsp).not.toMatch(/frame-ancestors[^;]*https?:/);
  });
});

describe("الترويسات الثابتة — الانحدار", () => {
  it("nosniff موجود", () => {
    expect(STATIC_SECURITY_HEADERS.find((h) => h.key === "X-Content-Type-Options")?.value).toBe("nosniff");
  });
  it("Referrer-Policy: no-referrer", () => {
    expect(STATIC_SECURITY_HEADERS.find((h) => h.key === "Referrer-Policy")?.value).toBe("no-referrer");
  });
  it("X-Frame-Options: SAMEORIGIN", () => {
    expect(STATIC_SECURITY_HEADERS.find((h) => h.key === "X-Frame-Options")?.value).toBe("SAMEORIGIN");
  });
  it("HSTS محافظ: max-age سنة، بلا preload وincludeSubDomains", () => {
    expect(HSTS_HEADER.value).toBe("max-age=31536000");
    expect(HSTS_HEADER.value).not.toContain("preload");
    expect(HSTS_HEADER.value).not.toContain("includeSubDomains");
  });
  it("Permissions-Policy: microphone=(self) للتسجيل الصوتي — والبقي مغلقة", () => {
    const policy = STATIC_SECURITY_HEADERS.find((h) => h.key === "Permissions-Policy")?.value ?? "";
    expect(policy).toContain("microphone=(self)");
    expect(policy).toContain("camera=()");
    expect(policy).toContain("geolocation=()");
    expect(policy).toContain("payment=()");
    expect(policy).toContain("usb=()");
    expect(policy).toContain("browsing-topics=()");
  });
  it("COOP وCORP موجودان (bلا COEP — لا كسر للتحميلات المشروعة)", () => {
    expect(STATIC_SECURITY_HEADERS.find((h) => h.key === "Cross-Origin-Opener-Policy")?.value).toBe("same-origin");
    expect(STATIC_SECURITY_HEADERS.find((h) => h.key === "Cross-Origin-Resource-Policy")?.value).toBe("same-origin");
    expect(STATIC_SECURITY_HEADERS.map((h) => h.key)).not.toContain("Cross-Origin-Embedder-Policy");
  });
});

describe("التكوين — الانحدار المصدر", () => {
  it("poweredByHeader: false مثبت في التكوين", () => {
    expect(configSource).toContain("poweredByHeader: false");
  });
  it("الترويسات الثابتة تُطبَّق على كل المسارات من التكوين", () => {
    expect(configSource).toContain('source: "/(.*)"');
  });
  it("proxy يبني CSP بnonce لكل طلب ويضعه في الطلب والرد", () => {
    expect(proxySource).toContain("buildCspHeaderValue");
    expect(proxySource).toContain("crypto.randomUUID()");
    expect(proxySource).toContain('requestHeaders.set("Content-Security-Policy", csp)');
    expect(proxySource).toContain('response.headers.set("Content-Security-Policy", csp)');
  });
  it("proxy يمنع no-store على بيانات المرضى والبوابة والطباعة", () => {
    expect(proxySource).toContain('pathname.startsWith("/api/")');
    expect(proxySource).toContain('pathname.startsWith("/portal/")');
    expect(proxySource).toContain('pathname.startsWith("/print/")');
    expect(proxySource).toContain('"private, no-store"');
  });
});
