import { beforeAll, describe, expect, it } from "vitest";
import { baseUrl, harness, authedGet } from "./_server";

/**
 * اختبارات رؤوس الأمن وCSP على HTTP الحقيقي (P2/S14) — على التطبيق المبني
 * بوضع الإنتاج: HSTS موجودة، لا X-Powered-By، nonce مختلف لكل طلب صفحة،
 * وCSP الإنتاج بلا unsafe-eval، والصحة العامة minimal، وبيانات المرضى
 * no-store.
 */

let h: Awaited<ReturnType<typeof harness>>;

beforeAll(async () => {
  h = await harness();
}, 240_000);

describe("رؤوس الأمن العامة", () => {
  it("لا X-Powered-By على أي مسار", async () => {
    for (const path of ["/login", "/api/ping", "/api/health"]) {
      const response = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
      expect(response.headers.get("x-powered-by")).toBeNull();
    }
  });

  it("nosniff وReferrer-Policy وX-Frame-Options وCOOP/CORP وPermissions-Policy على المسارات", async () => {
    const response = await fetch(`${baseUrl}/login`, { redirect: "manual" });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    const permissions = response.headers.get("permissions-policy") ?? "";
    expect(permissions).toContain("microphone=(self)");
    expect(permissions).toContain("camera=()");
  });

  it("HSTS في الإنتاج بالقيمة المحافظة (بلا preload/includeSubDomains)", async () => {
    const response = await fetch(`${baseUrl}/login`, { redirect: "manual" });
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it("CSP كاملة على طلبات الصفحات بلا unsafe-eval ولا wildcard", async () => {
    const response = await fetch(`${baseUrl}/login`, { redirect: "manual" });
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/script-src[^;]*\*/);
    expect(csp).not.toMatch(/connect-src[^;]*\*/);
  });

  it("CSP على مسارات API كذلك (وframe-ancestors 'self' لمسار المستندات وحده)", async () => {
    const api = await fetch(`${baseUrl}/api/ping`);
    const apiCsp = api.headers.get("content-security-policy") ?? "";
    expect(apiCsp).toContain("frame-ancestors 'none'");
    expect(apiCsp).toContain("default-src 'self'");

    const documents = await authedGet("/api/documents/1", h.sessions.doctorA);
    const docsCsp = documents.headers.get("content-security-policy") ?? "";
    expect(docsCsp).toContain("frame-ancestors 'self'");
    expect(docsCsp).not.toMatch(/frame-ancestors[^;]*https?:/);
  });
});

describe("nonce — عشوائي لكل طلب ويطابق سكربتات الصفحة", () => {
  function extractNonce(csp: string): string | null {
    const match = /'nonce-([^']+)'/.exec(csp);
    return match ? match[1] : null;
  }

  it("كل طلب صفحة يحصل nonce مختلفًا", async () => {
    const [a, b, c] = await Promise.all([
      fetch(`${baseUrl}/login`, { redirect: "manual" }),
      fetch(`${baseUrl}/login`, { redirect: "manual" }),
      fetch(`${baseUrl}/login`, { redirect: "manual" }),
    ]);
    const nonces = [a, b, c]
      .map((r) => extractNonce(r.headers.get("content-security-policy") ?? ""))
      .filter((n): n is string => Boolean(n));
    expect(nonces.length).toBe(3);
    expect(new Set(nonces).size).toBe(3);
  });

  it("سكربتات HTML المولَّدة تحمل nonce يطابق ترويسة CSP", async () => {
    const response = await fetch(`${baseUrl}/login`, { redirect: "manual" });
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonce = extractNonce(csp);
    expect(nonce).toBeTruthy();
    const html = await response.text();
    // Next يضيف nonce إلى سكربتاته المتولدة عند وجوده في ترويسة الطلب.
    const scriptMatches = html.match(/<script[^>]*>/g) ?? [];
    const withNonce = scriptMatches.filter((tag) => tag.includes(`nonce="${nonce}"`));
    expect(withNonce.length).toBeGreaterThan(0);
    // ولا سكربت بلا nonce (الإنتاج بلا unsafe-inline):
    const withoutNonce = scriptMatches.filter((tag) => !tag.includes("nonce="));
    expect(withoutNonce).toHaveLength(0);
  });
});

describe("فصل الصحة عن الاستجابة (S11)", () => {
  it("/api/ping: نبض عام minimal — {ok:true} فقط", async () => {
    const response = await fetch(`${baseUrl}/api/ping`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["ok"]);
    expect(payload.ok).toBe(true);
  });

  it("/api/health: جاهزية minimal — لا تفاصيل إعداد ولا إصدار ولا حالة سرّ", async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.ready).toBe(true);
    // لا كشف: مفاتيح الجسم {ready} وحدها
    expect(Object.keys(payload)).toEqual(["ready"]);
    const text = JSON.stringify(payload);
    expect(text).not.toContain("SESSION");
    expect(text).not.toContain("DATABASE");
    expect(text).not.toContain("RAILWAY_GIT");
    expect(text).not.toContain("الإصدار");
    expect(text).not.toContain("الناقص");
  });

  it("readiness التفصيلية للمدير فقط — 403 لغيره و401 للعابر", async () => {
    const anonymous = await fetch(`${baseUrl}/api/settings/readiness`);
    expect(anonymous.status).toBe(401);
    const doctor = await authedGet("/api/settings/readiness", h.sessions.doctorA);
    expect([403, 401]).toContain(doctor.status);
    const admin = await authedGet("/api/settings/readiness", h.sessions.admin);
    expect(admin.status).toBe(200);
    const detail = await admin.text();
    expect(detail).toContain("checks");
  });
});

describe("سياسة التخزين المؤقت للمسارات الحساسة (S12)", () => {
  it("بيانات API الموقعة no-store", async () => {
    const response = await authedGet("/api/auth/me", h.sessions.admin);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("صفحات البوابة no-store", async () => {
    const response = await fetch(`${baseUrl}/portal`, { redirect: "manual" });
    expect(response.headers.get("cache-control") ?? "").toContain("no-store");
  });

  it("الأصول الساكنة المتجزئة ليست no-store (تخزين حر)", async () => {
    const login = await fetch(`${baseUrl}/login`, { redirect: "manual" });
    const html = await login.text();
    const asset = /(?:src|href)="(\/_next\/static\/[^"]+)"/.exec(html);
    if (asset) {
      const assetResponse = await fetch(`${baseUrl}${asset[1]}`);
      expect(assetResponse.status).toBe(200);
      // لا نرسل no-store على أصل متجزئ — يخزَّن بحرية:
      expect(assetResponse.headers.get("cache-control") ?? "").not.toContain("no-store");
    }
  });

  it("لا معرفات مرضى في ETag", async () => {
    const response = await authedGet(`/api/patients/${h.seeded.patientAId}`, h.sessions.admin);
    const etag = response.headers.get("etag") ?? "";
    expect(etag).not.toContain(String(h.seeded.patientAId));
    expect(etag).not.toContain("SECA-001");
  });
});
