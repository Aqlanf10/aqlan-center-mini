import { beforeAll, describe, expect, it } from "vitest";
import { baseUrl, harness, authedMutation } from "./_server";

/**
 * سياسة الأصل الدقيق على HTTP حقيقي (P2-FIX-4):
 * الخادم إنتاجي (NODE_ENV=production) وأصله الكانوني مضبوط صراحة
 * (APP_ORIGIN=http://127.0.0.1:PORT) — فتُختبر المطابقة الحرفية:
 * نفس المضيف ببروتوكول أو منفذ آخر يُرفض كما يُرفض الأصل الغريب،
 * وترويسات وسيطٍ مزيّفة لا تفتح شيئاً بلا TRUST_PROXY.
 */

let h: Awaited<ReturnType<typeof harness>>;

beforeAll(async () => {
  h = await harness();
}, 240_000);

function cookieMutationWithOrigin(origin: string, extraHeaders: Record<string, string> = {}) {
  return fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: {
      Cookie: h.sessions.admin.cookie,
      "Content-Type": "application/json",
      Origin: origin,
      ...extraHeaders,
    },
    body: JSON.stringify({ to: { type: "user", id: 1 }, body: "فحص أصل" }),
  });
}

describe("(P2-FIX-4) المطابقة الحرفية للأصل على طلبات الكوكي", () => {
  it("نفس الأصل الكانوني حرفياً (APP_ORIGIN) ⇒ يعبر الحارس", async () => {
    const response = await authedMutation("/api/auth/logout", h.sessions.admin, "POST");
    expect([200, 204]).toContain(response.status);
  });

  it("نفس المضيف ببروتوكول آخر (https بدل http) ⇒ 403", async () => {
    const httpsOrigin = baseUrl.replace("http://", "https://");
    const response = await cookieMutationWithOrigin(httpsOrigin);
    expect(response.status).toBe(403);
  });

  it("نفس المضيف بمنفذ آخر (:9999) ⇒ 403", async () => {
    const wrongPort = baseUrl.replace(/:(\d+)$/, ":9999");
    const response = await cookieMutationWithOrigin(wrongPort);
    expect(response.status).toBe(403);
  });

  it("أصل غريب ⇒ 403", async () => {
    const response = await cookieMutationWithOrigin("https://evil.attacker.example");
    expect(response.status).toBe(403);
  });

  it("نطاق فرعي غريب على مضيفٍ محلي ⇒ 403", async () => {
    const response = await cookieMutationWithOrigin("http://evil.127.0.0.1.nip.io:3217");
    expect(response.status).toBe(403);
  });
});

describe("(P2-FIX-4) ترويسات الوسيط المزيّفة لا تفتح الباب", () => {
  it("x-forwarded-host مزيّف + Origin مطابق له (بلا TRUST_PROXY) ⇒ 403", async () => {
    const response = await cookieMutationWithOrigin("https://attacker-matched.example", {
      "x-forwarded-host": "attacker-matched.example",
      "x-forwarded-proto": "https",
    });
    expect(response.status).toBe(403);
  });

  it("الطلب عبر المواقع معلناً (Sec-Fetch-Site: cross-site) ⇒ 403 مهما كان الأصل", async () => {
    const response = await fetch(`${baseUrl}/api/messages`, {
      method: "POST",
      headers: {
        Cookie: h.sessions.admin.cookie,
        "Content-Type": "application/json",
        Origin: baseUrl,
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ to: { type: "user", id: 1 }, body: "فحص" }),
    });
    expect(response.status).toBe(403);
  });
});
