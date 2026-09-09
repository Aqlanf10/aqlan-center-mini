import http from "node:http";
import { beforeAll, describe, expect, it } from "vitest";
import {
  baseUrl,
  harness,
  authedGet,
  authedMutation,
  TEST_USERS,
  TEST_PATIENTS,
} from "./_server";

/** طلب HTTP خام بمضيف مزيف — fetch يفرض Host من URL فلا يصلح هنا. */
function rawHttpRequest(options: {
  method: string;
  path: string;
  host: string;
  extraHeaders: Record<string, string>;
  body?: string;
}): Promise<{ statusCode: number; headers: Record<string, string | string[]> }> {
  const port = Number(new URL(baseUrl).port);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method,
        path: options.path,
        headers: { Host: options.host, ...options.extraHeaders },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          void Buffer.concat(chunks); // الجسم يُهمل — الترويسات هي المطلوبة
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers as Record<string, string | string[]>,
          });
        });
      },
    );
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

/**
 * اختبارات حارس الـmutations (CSRF/Origin) على HTTP الحقيقي (P2/S14 + S4):
 * cross-site مرفوض، أصل غريب مرفوض، غياب الأصل مع كوكي مرفوض (fail-closed)،
 * same-origin يمر، Bearer لا يُعامل CSRF، والخروج محمي كذلك، والكوكيز Lax.
 */

let h: Awaited<ReturnType<typeof harness>>;

beforeAll(async () => {
  h = await harness();
}, 240_000);

describe("سياسة الكوكيز — SameSite=Lax بلا Partitioned (S4)", () => {
  it("كوكي دخول الطاقم: Lax وHttpOnly وSecure في سياق إنتاجي HTTPS", async () => {
    // fetch يفرض Host من الـURL (ترويسة محظورة عليه) — نستخدم طلب HTTP خامًا
    // بمضيف عام وبروتوكول أمامي https، كما يراه الخادم خلف وسيط Railway.
    const response = await rawHttpRequest({
      method: "POST",
      path: "/api/auth/login",
      host: "aqlan-sec.test",
      extraHeaders: {
        "Content-Type": "application/json",
        Origin: "https://aqlan-sec.test",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({
        username: TEST_USERS.admin.username,
        password: TEST_USERS.admin.password,
      }),
    });
    expect(response.statusCode).toBe(200);
    const rawSetCookie = response.headers["set-cookie"] ?? [];
    const setCookies: string[] = Array.isArray(rawSetCookie) ? rawSetCookie : [rawSetCookie];
    const sessionCookie = setCookies.find((c) => c.startsWith("aqlan_flow_session="));
    expect(sessionCookie).toBeTruthy();
    // قيمة SameSite غير حساسة لحالة الأحرف (التسلسل يكتب lax صغيرة)
    expect(sessionCookie).toMatch(/samesite=lax/i);
    expect(sessionCookie).toMatch(/httponly/i);
    expect(sessionCookie).toMatch(/secure/i);
    expect(sessionCookie).not.toMatch(/partitioned/i);
    expect(sessionCookie).toMatch(/path=\//i);
  });

  it("كوكي دخول البوابة: Lax وHttpOnly وSecure — لا SameSite=None", async () => {
    const response = await fetch(`${baseUrl}/api/portal/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({
        phone: TEST_PATIENTS.patientA.phone,
        patientNumber: TEST_PATIENTS.patientA.patientNumber,
      }),
    });
    expect(response.status).toBe(200);
    const setCookies = response.headers.getSetCookie?.() ?? [];
    const portalCookie = setCookies.find((c) => c.startsWith("aqlan_portal_session="));
    expect(portalCookie).toBeTruthy();
    expect(portalCookie).toMatch(/samesite=lax/i);
    expect(portalCookie).toContain("HttpOnly");
    expect(portalCookie).toContain("Secure");
    expect(portalCookie).not.toContain("SameSite=None");
    expect(portalCookie).not.toContain("Partitioned");
  });
});

describe("حارس الـmutations — الطلبات المعتمدة بالكوكي", () => {
  it("Sec-Fetch-Site: cross-site مع كوكي ⇒ 403 (حتى لو Origin نفس الموقع)", async () => {
    const response = await fetch(`${baseUrl}/api/messages`, {
      method: "POST",
      headers: {
        Cookie: h.sessions.admin.cookie,
        "Content-Type": "application/json",
        Origin: baseUrl,
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ to: { type: "user", id: 1 }, body: "محاولة CSRF" }),
    });
    expect(response.status).toBe(403);
  });

  it("Origin غريب مع كوكي ⇒ 403 (حتى بلا Sec-Fetch-Site)", async () => {
    const response = await fetch(`${baseUrl}/api/messages`, {
      method: "POST",
      headers: {
        Cookie: h.sessions.admin.cookie,
        "Content-Type": "application/json",
        Origin: "https://evil.attacker.example",
      },
      body: JSON.stringify({ to: { type: "user", id: 1 }, body: "محاولة CSRF" }),
    });
    expect(response.status).toBe(403);
  });

  it("كوكي بلا Origin ولا Sec-Fetch-Site ⇒ 403 (fail-closed)", async () => {
    const response = await fetch(`${baseUrl}/api/messages`, {
      method: "POST",
      headers: {
        Cookie: h.sessions.admin.cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to: { type: "user", id: 1 }, body: "عميل اصطناعي بكوكي" }),
    });
    expect(response.status).toBe(403);
  });

  it("Origin ملغوم الشكل مع كوكي ⇒ 403", async () => {
    const response = await fetch(`${baseUrl}/api/messages`, {
      method: "POST",
      headers: {
        Cookie: h.sessions.admin.cookie,
        "Content-Type": "application/json",
        Origin: "::::not-a-url",
      },
      body: JSON.stringify({ to: { type: "user", id: 1 }, body: "أصل ملغوم" }),
    });
    expect(response.status).toBe(403);
  });

  it("same-origin (Origin مطابق + Sec-Fetch-Site نفس الموقع) ⇒ يعبر الحارس", async () => {
    const response = await authedMutation("/api/auth/logout", h.sessions.admin, "POST");
    // نجاح الحارس: الطلب يصل المسار — logout يرد 200 بجسم ok
    expect([200, 204]).toContain(response.status);
  });

  it("حارس الخروج نفسه: خروج بكوكي عبر cross-site ⇒ 403", async () => {
    const response = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: h.sessions.doctorB.cookie,
        "Sec-Fetch-Site": "cross-site",
      },
    });
    expect(response.status).toBe(403);
  });

  it("طلب Bearer لا يُعامل CSRF — يعبر الحارس ويصل RBAC المسار", async () => {
    const response = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${h.sessions.admin.token}` },
    });
    // Bearer بلا Origin/Sec-Fetch: الحارس يتخطاه (GET أصلًا)، والجلسة تعمل:
    expect(response.status).toBe(200);
  });

  it("mutation عبر Bearer بلا متصفح يعبر الحارس (RBAC الباقي في المسار)", async () => {
    // حذف رسالة وهمية عبر Bearer: الحارس لا يردّها CSRF — المسار نفسه يقرر.
    // 403 من المسار (ملكية الرسالة) جائز؛ المهم ألا يكون رفضَ حارسِ الأصل:
    const response = await fetch(`${baseUrl}/api/messages?id=999999`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${h.sessions.admin.token}` },
    });
    const payload = (await response.json().catch(() => ({}))) as { message?: string };
    expect(payload.message ?? "").not.toContain("بين مواقع");
    expect(response.status).not.toBe(401);
  });
});

describe("المسارات العامة — سياسة أصل النافذة القصيرة (S5)", () => {
  it("cross-site POST على دخول الطاقم ⇒ 403 قبل أي تحقق بيانات", async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ username: "x", password: "y" }),
    });
    expect(response.status).toBe(403);
  });

  it("cross-site POST على الحجز العام ⇒ 403", async () => {
    const response = await fetch(`${baseUrl}/api/book`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ name: "مهاجم", phone: "700000000" }),
    });
    expect(response.status).toBe(403);
  });

  it("cross-site POST على دخول البوابة ⇒ 403", async () => {
    const response = await fetch(`${baseUrl}/api/portal/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ phone: "700000000", patientNumber: "X" }),
    });
    expect(response.status).toBe(403);
  });

  it("عميل بلا متصفح (بلا Origin/Sec-Fetch) على مسار عام ⇒ يصل المسار (الحدود داخله)", async () => {
    // دخول خاطئ عبر curl-like: يصل المسار ويرفض ب401 اعتمادًا لا ب403 أصل
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "nobody", password: "wrong-pass" }),
    });
    expect(response.status).toBe(401);
  });

  it("الإعداد الأول: توكن قديم لا ينشئ مديرًا ثانيًا — 409 رغم صحة الرمز", async () => {
    // القاعدة مزروعة بمدير: SETUP_TOKEN صحيح الشكل لكن الجدول غير فارغ
    const response = await fetch(`${baseUrl}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "setup-token-0123456789",
        username: "second-admin",
        displayName: "مدير ثانٍ مزعوم",
        password: "SecondAdmin#1",
      }),
    });
    // SETUP_TOKEN غير مضبوط في الخادم أصلًا (البذر عبر القاعدة مباشرة) —
    // فالرفض 503 «غير مفعّل» هو السلوك الصحيح؛ المهم أنه ليس 201 أبدًا.
    expect(response.status).not.toBe(201);
    expect([409, 503, 403]).toContain(response.status);
  });
});

describe("CORS — same-origin افتراضيًّا، لا انعكاس أصل (S6)", () => {
  it("لا Access-Control-Allow-Origin على بيانات المرضى رغم Origin غريب", async () => {
    const response = await authedGet(
      `/api/patients/${h.seeded.patientAId}`,
      h.sessions.admin,
      { Origin: "https://evil.attacker.example" },
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("preflight (OPTIONS) لا يمنح وصولًا ولا يكرم أصلًا غريبًا", async () => {
    const response = await fetch(`${baseUrl}/api/patients/${h.seeded.patientAId}`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.attacker.example",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    // لا نجاحَ وهميًّا: preflight لا يعني Authorization —
    // الطلب الفعلي بعد OPTIONS يظل خلف الجلسة/الأصل
  });

  it("Origin غريب على طلب حقيقي لم يُمنح CORS: بياناته لا تصل للمتصفح المهاجم — والسيرفر لا يعكس الأصل", async () => {
    const response = await fetch(`${baseUrl}/api/portal/statement`, {
      headers: {
        Cookie: h.sessions.portalA.cookie,
        Origin: "https://evil.attacker.example",
      },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
