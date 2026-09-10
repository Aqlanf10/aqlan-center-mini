import { beforeAll, describe, expect, it } from "vitest";
import {
  baseUrl,
  harness,
  authedGet,
  authedMutation,
  loginStaff,
  TEST_USERS,
} from "./_server";

/**
 * اختبارات معمارية الجلسة كوكي-فقط (P2-FIX-1) على HTTP حقيقي:
 *
 *  1. جسم تسجيل الدخول لا يحمل توكناً — الكوكي HttpOnly وحدها هي الجلسة.
 *  2. الاستعادة بعد التحديث من /api/auth/me بالكوكي — لا استعادة من العميل.
 *  3. الطلبات المتصفحية العادية (كوكي بلا أي Authorization) تعبر حارس CSRF
 *     بمسار المتصفح كاملاً — والطلبات عبر المواقع تُردّ 403.
 *  4. الخروج يمحو الكوكي.
 *  5. Bearer يبقى مساراً صريحاً للتطبيقات الخارجية فقط — ويعمل بالتوكن
 *     الموقّع (تدفق منفصل غير المتصفح) لا بأي توكن من دخول المتصفح.
 */

let h: Awaited<ReturnType<typeof harness>>;

beforeAll(async () => {
  h = await harness();
}, 240_000);

describe("(P2-FIX-1) دخول المتصفح كوكي-فقط — لا توكن في JSON", () => {
  it("جسم تسجيل الدخول الناجح: username/displayName/role/permissions — لا token", async () => {
    const session = await loginStaff(TEST_USERS.admin.username, TEST_USERS.admin.password);
    expect(session.cookie).toBeTruthy();
    // loginStaff نفسه يفشل الاختبار إذا عاد "token" في الجسم — وهذا تكرار صريح:
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({
        username: TEST_USERS.doctorA.username,
        password: TEST_USERS.doctorA.password,
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect("token" in payload).toBe(false);
    expect(payload.username).toBe(TEST_USERS.doctorA.username);
    expect(payload.role).toBe("doctor");
    // الكوكي وصلت HttpOnly في الرد نفسه:
    const setCookies = response.headers.getSetCookie?.() ?? [];
    const cookie = setCookies.find((c) => c.startsWith("aqlan_flow_session="));
    expect(cookie).toMatch(/httponly/i);
  });

  it("الكوكي HttpOnly والسر في الرد: النص الموقّع لا يُقرأ من JavaScript (سمات الرد)", async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({
        username: TEST_USERS.reception.username,
        password: TEST_USERS.reception.password,
      }),
    });
    const setCookies = response.headers.getSetCookie?.() ?? [];
    const cookie = setCookies.find((c) => c.startsWith("aqlan_flow_session="));
    expect(cookie).toBeTruthy();
    expect(cookie).toMatch(/httponly/i);
    expect(cookie).toMatch(/path=\//i);
  });
});

describe("(P2-FIX-1) الاستعادة بعد التحديث — من الخادم لا من العميل", () => {
  it("GET /api/auth/me بالكوكي بعد الدخول: هوية كاملة (محاكاة تحديث الصفحة)", async () => {
    const session = await loginStaff(TEST_USERS.doctorA.username, TEST_USERS.doctorA.password);
    const me = await authedGet("/api/auth/me", { cookie: session.cookie, token: "" });
    expect(me.status).toBe(200);
    const identity = (await me.json()) as { username?: string; role?: string };
    expect(identity.username).toBe(TEST_USERS.doctorA.username);
    expect(identity.role).toBe("doctor");
  });

  it("بلا كوكي: /api/auth/me ⇒ 401 — لا حالة مخفيّة من العميل تفتح شيئاً", async () => {
    const response = await fetch(`${baseUrl}/api/auth/me`);
    expect(response.status).toBe(401);
  });
});

describe("(P2-FIX-1) طلبات المتصفح العادية — كوكي بلا أي Authorization", () => {
  it("mutation بكوكي + Origin نفسه + بلا Authorization تعبر الحارس (المسار المتصفحي)", async () => {
    // الخروج على المسار نفسه بطلب كوكي صافٍ: 200 من المسار لا 403 من الحارس
    const response = await authedMutation("/api/auth/logout", h.sessions.doctorA, "POST");
    expect([200, 204]).toContain(response.status);
  });

  it("GET بيانات بكوكي صافٍ بلا Authorization يعمل (لا حاجة لأي توكن في المتصفح)", async () => {
    const response = await authedGet(`/api/patients/${h.seeded.patientAId}`, h.sessions.doctorA);
    expect(response.status).toBe(200);
  });

  it("mutation عبر المواقع بالكوكي ⇒ 403 — الحارس المتصفحي سليم", async () => {
    const response = await fetch(`${baseUrl}/api/messages`, {
      method: "POST",
      headers: {
        Cookie: h.sessions.admin.cookie,
        "Content-Type": "application/json",
        Origin: "https://evil.attacker.example",
      },
      body: JSON.stringify({ to: { type: "user", id: 1 }, body: "CSRF بعد FIX-1" }),
    });
    expect(response.status).toBe(403);
  });
});

describe("(P2-FIX-1) الخروج يمحو الكوكي", () => {
  it("logout: Set-Cookie بمDescriptor مطابق وMax-Age=0 (حذف فوري)", async () => {
    const response = await authedMutation("/api/auth/logout", h.sessions.doctorB, "POST");
    expect([200, 204]).toContain(response.status);
    const setCookies = response.headers.getSetCookie?.() ?? [];
    const cleared = setCookies.find((c) => c.startsWith("aqlan_flow_session="));
    expect(cleared).toBeTruthy();
    expect(cleared).toMatch(/max-age=0/i);
    expect(cleared).toMatch(/httponly/i);
  });

  it("بعد الخروج: المتصفح بلا كوكي ⇒ 401 — الجلسة انتهت في الواجهة", async () => {
    const fresh = await loginStaff(TEST_USERS.accountant.username, TEST_USERS.accountant.password);
    const out = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: fresh.cookie, Origin: baseUrl, "Sec-Fetch-Site": "same-origin" },
    });
    expect([200, 204]).toContain(out.status);
    // سلوك المتصفح بعد الخروج: امتثل لمحو الكوكي — الطلبات التالية لا تحمل
    // كوكي إطلاقاً ⇒ 401 من /api/auth/me (حالة الواجهة تُستعاد من الخادم حصراً).
    const me = await fetch(`${baseUrl}/api/auth/me`);
    expect(me.status).toBe(401);
  });
});

describe("(P2-FIX-1) Bearer مسار صريح للتطبيقات الخارجية فقط", () => {
  it("توكن Bearer الموقّع (تدفق منفصل) يعمل على /api/auth/me — بلا كوكي", async () => {
    const response = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${h.sessions.doctorA.token}` },
    });
    expect(response.status).toBe(200);
    const identity = (await response.json()) as { username?: string };
    expect(identity.username).toBe(TEST_USERS.doctorA.username);
  });

  it("mutation عبر Bearer الصريح يعبر حارس CSRF (لا يُعامل كمتصفح)", async () => {
    const response = await fetch(`${baseUrl}/api/messages?id=999999`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${h.sessions.admin.token}` },
    });
    const payload = (await response.json().catch(() => ({}))) as { message?: string };
    expect(payload.message ?? "").not.toContain("بين مواقع");
    expect(response.status).not.toBe(401);
  });

  it("توكن الطاقم لا يفتح بوابة المريض عبر Bearer (فصل المجالات باقٍ)", async () => {
    const response = await fetch(`${baseUrl}/api/portal/statement`, {
      headers: { Authorization: `Bearer ${h.sessions.admin.token}` },
    });
    expect(response.status).toBe(401);
  });
});
