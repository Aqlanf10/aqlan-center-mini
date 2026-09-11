import { beforeAll, describe, expect, it } from "vitest";
import {
  baseUrl,
  harness,
  authedMutation,
  authedGet,
} from "./_server";

/**
 * أمن HTTP الحقيقي لنقاط النسخ الاحتياطي (PR#21) على خادم مبنيّ وقاعدة حقيقية:
 *
 *  * بوابة التفعيل: 401 مجهول، 403 غير مدير، 405 GET، فشل مغلق (503) في بيئة
 *    خادم الاختبار (بلا DATABASE_ENVIRONMENT=production ولا Railway)، ورفض
 *    CSRF/Origin من حارس الـmutations المركزي، وسقف الجسم (413).
 *  * نقطة ضرب المجدول: 405 GET، فشل مغلق 503 حين لا سرّ مهيَّأ (خادم الاختبار).
 *  * حالة النسخ: 403 غير مدير، 200 للمدير بلا مسارات مطلقة ولا أسرار.
 *  * كل الردود no-store.
 */

let h: Awaited<ReturnType<typeof harness>>;

beforeAll(async () => {
  h = await harness();
}, 240_000);

describe("بوابة التفعيل — POST /api/settings/production-backup", () => {
  it("مجهول ⇒ 401 من حارس الحدود (بلا كوكي وبلا Bearer لا يدخل المسار أصلًا)", async () => {
    const response = await fetch(`${baseUrl}/api/settings/production-backup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl, "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ token: "x" }),
    });
    expect(response.status).toBe(401);
    const body = await response.json() as { message?: string };
    expect(body.message).not.toMatch(/token|DATABASE|postgres|\/data|\/app/i);
  });

  it("مجهول مع Bearer صريح ⇒ 401 من المسار نفسه مع no-store", async () => {
    const response = await fetch(`${baseUrl}/api/settings/production-backup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl, "Sec-Fetch-Site": "same-origin", Authorization: "Bearer external-app" },
      body: JSON.stringify({ token: "x" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json() as { message?: string };
    expect(body.message).not.toMatch(/token|DATABASE|postgres|\/data|\/app/i);
  });

  it("غير مدير (استقبال وطبيب) ⇒ 403", async () => {
    for (const session of [h.sessions.reception, h.sessions.doctorA]) {
      const response = await authedMutation("/api/settings/production-backup", session, "POST", JSON.stringify({ token: "x" }));
      expect(response.status).toBe(403);
    }
  });

  it("مدير بأصلٍ عبر المواقع ⇒ رفض CSRF من الحارس المركزي", async () => {
    const response = await fetch(`${baseUrl}/api/settings/production-backup`, {
      method: "POST",
      headers: {
        Cookie: h.sessions.admin.cookie,
        Origin: "https://evil.example",
        "Sec-Fetch-Site": "cross-site",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: "x" }),
    });
    expect(response.status).toBe(403);
  });

  it("مدير بأصلٍ سليم في بيئة الاختبار ⇒ فشل مغلق 503 (لا إنتاج هنا)", async () => {
    const response = await authedMutation("/api/settings/production-backup", h.sessions.admin, "POST", JSON.stringify({ token: "whatever" }));
    expect(response.status).toBe(503);
    const body = await response.json() as { message?: string };
    expect(body.message).not.toMatch(/token|DATABASE|postgres|RAILWAY|\/data|\/app/i);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("GET ⇒ 405 (لا تشغيل النسخ من رابط)", async () => {
    const response = await authedGet("/api/settings/production-backup", h.sessions.admin);
    expect(response.status).toBe(405);
  });

  it("جسم ضخم مع مدير ⇒ 413 من القارئ المحدود", async () => {
    const response = await authedMutation(
      "/api/settings/production-backup",
      h.sessions.admin,
      "POST",
      JSON.stringify({ token: "x", padding: "A".repeat(300 * 1024) }),
    );
    expect(response.status).toBe(413);
  });
});

describe("نقطة ضرب المجدول — POST /api/internal/backup/run", () => {
  it("GET ⇒ 405", async () => {
    const response = await authedGet("/api/internal/backup/run", h.sessions.admin);
    expect(response.status).toBe(405);
  });

  it("بلا Bearer وبلا كوكي ⇒ 401 من حارس الحدود (الباب قبل المسار)", async () => {
    const response = await fetch(`${baseUrl}/api/internal/backup/run`, { method: "POST" });
    expect(response.status).toBe(401);
    const body = await response.json() as { message?: string };
    expect(body.message).not.toMatch(/token|secret|DATABASE|postgres/i);
  });

  it("Bearer صريح والسر غير مهيَّأ في بيئة الاختبار ⇒ فشل مغلق 503 من المسار", async () => {
    // خادم الاختبار بلا INTERNAL_BACKUP_RUN_TOKEN: المسار نفسه يغلق الباب
    // حتى لbearer صريح — فشل التكوين يسبق فحص الرمز بلا استثناء.
    const response = await fetch(`${baseUrl}/api/internal/backup/run`, {
      method: "POST",
      headers: { Authorization: "Bearer guessed-token" },
    });
    expect(response.status).toBe(503);
    const body = await response.json() as { message?: string };
    expect(body.message).not.toMatch(/token|secret|DATABASE|postgres/i);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});

describe("(I) نسخ «الآن» اليدوي القابل للتكرار — POST /api/settings/backup/run", () => {
  it("مجهول ⇒ 401 (بلا كوكي وبلا Bearer)", async () => {
    const response = await fetch(`${baseUrl}/api/settings/backup/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl, "Sec-Fetch-Site": "same-origin" },
    });
    expect(response.status).toBe(401);
  });

  it("غير مدير ⇒ 403", async () => {
    for (const session of [h.sessions.reception, h.sessions.doctorA]) {
      const response = await authedMutation("/api/settings/backup/run", session, "POST", "");
      expect(response.status).toBe(403);
    }
  });

  it("مدير بأصلٍ عبر المواقع ⇒ رفض CSRF من الحارس المركزي", async () => {
    const response = await fetch(`${baseUrl}/api/settings/backup/run`, {
      method: "POST",
      headers: {
        Cookie: h.sessions.admin.cookie,
        Origin: "https://evil.example",
        "Sec-Fetch-Site": "cross-site",
        "Content-Type": "application/json",
      },
    });
    expect(response.status).toBe(403);
  });

  it("مدير بلا وجهة قرص دائم في بيئة الاختبار ⇒ فشل مغلق 503 مع no-store", async () => {
    const response = await authedMutation("/api/settings/backup/run", h.sessions.admin, "POST", "");
    expect(response.status).toBe(503);
    const body = await response.json() as { message?: string };
    expect(body.message).not.toMatch(/DATABASE|postgres|\/home\/|\/app\//i);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("GET ⇒ 405", async () => {
    const response = await authedGet("/api/settings/backup/run", h.sessions.admin);
    expect(response.status).toBe(405);
  });
});

describe("(J) تكوين التفعيل الدائم صفر-الكتابة — POST /api/settings/backup/config", () => {
  it("مجهول ⇒ 401، وغير مدير ⇒ 403", async () => {
    const anon = await fetch(`${baseUrl}/api/settings/backup/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl, "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ backupEnabled: true }),
    });
    expect(anon.status).toBe(401);

    for (const session of [h.sessions.reception, h.sessions.doctorB]) {
      const response = await authedMutation(
        "/api/settings/backup/config",
        session,
        "POST",
        JSON.stringify({ backupEnabled: true }),
      );
      expect(response.status).toBe(403);
    }
  });

  it("مدير بقيم خارج القائمة البيضاء ⇒ 400 قبل أي فحص قرص وبلا كتابة", async () => {
    const response = await authedMutation(
      "/api/settings/backup/config",
      h.sessions.admin,
      "POST",
      JSON.stringify({ backupEnabled: "true", unknownKey: 1 }),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("مدير بلا وجهة قرص دائم في بيئة الاختبار ⇒ فشل مغلق 503", async () => {
    const response = await authedMutation(
      "/api/settings/backup/config",
      h.sessions.admin,
      "POST",
      JSON.stringify({ backupEnabled: true, scheduleTime: "03:00" }),
    );
    expect(response.status).toBe(503);
  });

  it("GET ⇒ 405", async () => {
    const response = await authedGet("/api/settings/backup/config", h.sessions.admin);
    expect(response.status).toBe(405);
  });
});

describe("حالة النسخ — GET /api/settings/backup", () => {
  it("غير مدير ⇒ 403", async () => {
    for (const session of [h.sessions.reception, h.sessions.doctorB]) {
      const response = await authedGet("/api/settings/backup", session);
      expect(response.status).toBe(403);
    }
  });

  it("مدير ⇒ 200 معقّم: بلا مسارات مطلقة ولا أسرار، ومع no-store", async () => {
    const response = await authedGet("/api/settings/backup", h.sessions.admin);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json() as Record<string, unknown>;
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/\/home\/|\/app\/|\/var\/|postgres(ql)?:\/\//i);
    expect(serialized).not.toMatch(/SESSION_SECRET|DATABASE_URL/i);
    // هيكل الحالة المتوقع موجود
    expect((body.config as Record<string, unknown>).backupEnabled).toBe(false);
    expect((body.status as Record<string, unknown>).nextScheduledRun).toBeNull();
    expect(Array.isArray(body.destinations)).toBe(true);
    const destinations = body.destinations as { destination: string }[];
    expect(destinations.map((entry) => entry.destination).sort()).toEqual(
      ["google_drive", "local_agent", "railway_volume"]);
  });
});
