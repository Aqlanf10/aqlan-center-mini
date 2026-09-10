import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * تحصين إعادة التوجيه وترويسات المصدر (P0.15/P0.16):
 * ترويسة مضيف مزوّرة، مضيف أمامي مزوّر، ومضيف موثوق من قائمة المشغّل.
 */

const mocks = vi.hoisted(() => ({
  consumeLoginAttemptFor: vi.fn(),
  consumeStaffLoginAttempt: vi.fn(),
  findUserByUsername: vi.fn(),
  verifyPassword: vi.fn(),
  createSessionToken: vi.fn(),
}));

vi.mock("@/lib/loginLimit", () => ({ consumeLoginAttemptFor: mocks.consumeLoginAttemptFor }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return { ...actual, consumeStaffLoginAttempt: mocks.consumeStaffLoginAttempt, findUserByUsername: mocks.findUserByUsername };
});
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth")>();
  return { ...actual, verifyPassword: mocks.verifyPassword, createSessionToken: mocks.createSessionToken };
});

import { POST as login } from "../app/api/auth/login/route";

function loginRequest(headers: Record<string, string>) {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html", ...headers },
    body: new URLSearchParams({ username: "dr.amjad", password: "secret" }).toString(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.consumeLoginAttemptFor.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mocks.consumeStaffLoginAttempt.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mocks.findUserByUsername.mockResolvedValue(null);
  process.env.SESSION_SECRET = "test-secret-0123456789abcdef-0123456789";
  delete process.env.TRUSTED_HOSTS;
  /* (P2-FINAL-1) أساس محدّد: بلا TRUST_PROXY ولا APP_ORIGIN من ملفاتٍ أخرى —
     فقرارا التوجيه وSecure يُختبران على السياسة الافتراضية (fail-closed). */
  delete process.env.TRUST_PROXY;
  delete process.env.APP_ORIGIN;
});

describe("ترويسات المضيف في إعادة توجيه الدخول (P0.15)", () => {
  it("الرسمي: ترويسة مزوّرة تعيد مسارًا نسبيًا لا رابط مهاجم", async () => {
    const response = await login(loginRequest({ "x-forwarded-host": "attacker.example" }));
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    /* نسبي أو على أصل الطلب نفسه — المهم: ليس نطاق المهاجم. */
    expect(location).not.toContain("attacker.example");
    expect(location.startsWith("/") || location.startsWith("http://localhost")).toBe(true);
  });

  it("ترويسة host مزوّرة كذلك: أصل الطلب لا ترويسة العميل", async () => {
    const response = await login(loginRequest({ host: "evil.example" }));
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).not.toContain("evil.example");
    expect(location.startsWith("/") || location.startsWith("http://localhost")).toBe(true);
  });

  it("مضيف موثوق من قائمة المشغّل + TRUST_PROXY=true يعيد رابطًا مطلقًا له وحده", async () => {
    /* (P2-FINAL-1) ترويسات الوسيط لا تُقرأ إلا مع TRUST_PROXY=true —
       الحالة المشروعة: وسيطٌ موثوق خلفه المضيف الموثوق نفسه. */
    process.env.TRUSTED_HOSTS = "center.example.com";
    process.env.TRUST_PROXY = "true";
    try {
      const response = await login(loginRequest({
        "x-forwarded-host": "center.example.com",
        "x-forwarded-proto": "https",
      }));
      expect(response.status).toBe(303);
      const location = response.headers.get("location") ?? "";
      expect(location.startsWith("https://center.example.com/")).toBe(true);
    } finally {
      delete process.env.TRUSTED_HOSTS;
      delete process.env.TRUST_PROXY;
    }
  });

  it("بلا TRUST_PROXY: نفس ترويسات الوسيط لا تُفتح — لا رابط مطلق لمضيف القائمة (P2-FINAL-1)", async () => {
    /* حتى لو طابق المضيف المُعاد توجيهه قائمة المشغّل: بلا وسيطٍ موثوق
       (TRUST_PROXY≠true) لا تُقرأ الترويسات أصلًا — الرابط من الأصل
       الكانوني/الطلب، فلا تصيّد ولا خفض. */
    process.env.TRUSTED_HOSTS = "center.example.com";
    try {
      const response = await login(loginRequest({
        "x-forwarded-host": "center.example.com",
        "x-forwarded-proto": "https",
      }));
      expect(response.status).toBe(303);
      const location = response.headers.get("location") ?? "";
      expect(location.startsWith("https://center.example.com/")).toBe(false);
      expect(location.startsWith("/") || location.startsWith("http://localhost")).toBe(true);
    } finally {
      delete process.env.TRUSTED_HOSTS;
    }
  });

  it("TRUST_PROXY=false صراحةً: ترويسات الوسيط لا تُوثق كذلك (P2-FINAL-1)", async () => {
    process.env.TRUSTED_HOSTS = "center.example.com";
    process.env.TRUST_PROXY = "false";
    try {
      const response = await login(loginRequest({
        "x-forwarded-host": "center.example.com",
        "x-forwarded-proto": "https",
      }));
      const location = response.headers.get("location") ?? "";
      expect(location.startsWith("https://center.example.com/")).toBe(false);
    } finally {
      delete process.env.TRUSTED_HOSTS;
      delete process.env.TRUST_PROXY;
    }
  });

  it("TRUST_PROXY=true مع x-forwarded-proto:http على مضيف موثوق: الوسيط الموثوق يعلن http فيُحترم (كما هو مقصود)", async () => {
    process.env.TRUSTED_HOSTS = "center.example.com";
    process.env.TRUST_PROXY = "true";
    try {
      const response = await login(loginRequest({
        "x-forwarded-host": "center.example.com",
        "x-forwarded-proto": "http",
      }));
      expect(response.status).toBe(303);
      const location = response.headers.get("location") ?? "";
      expect(location.startsWith("http://center.example.com/")).toBe(true);
    } finally {
      delete process.env.TRUSTED_HOSTS;
      delete process.env.TRUST_PROXY;
    }
  });

  it("APP_ORIGIN الكانوني يُقدَّم على أصل الطلب حين لا وسيط موثوق (P2-FINAL-1)", async () => {
    process.env.APP_ORIGIN = "https://clinic.example.com";
    try {
      const response = await login(loginRequest({}));
      expect(response.status).toBe(303);
      const location = response.headers.get("location") ?? "";
      expect(location.startsWith("https://clinic.example.com/")).toBe(true);
    } finally {
      delete process.env.APP_ORIGIN;
    }
  });

  it("مضيف يحمل محارف حقن سطر يُرفض شكلًا قبل أي مقارنة (طبقة التنقية)", async () => {
    /* طبقة Headers نفسها ترفض قيم CRLF عند البناء — وهنا نثبت أن مصفاة
       الشبكة ترفضها أيضًا لو وصلت من طبقةٍ لا تفحص (دفاع في العمق). */
    const { isHostTrusted, firstHeaderEntry } = await import("../lib/net");
    process.env.TRUSTED_HOSTS = "center.example.com";
    try {
      expect(isHostTrusted("evil.example\r\nSet-Cookie: x=1")).toBe(false);
      expect(isHostTrusted("center.example.com;drop")).toBe(false);
      expect(isHostTrusted("../etc/passwd")).toBe(false);
      expect(isHostTrusted("center.example.com")).toBe(true);
      expect(firstHeaderEntry("a.example, b.example")).toBe("a.example");
    } finally {
      delete process.env.TRUSTED_HOSTS;
    }
  });
});

describe("قرار Secure لكوكي الجلسة — بلا أي اعتماد على ترويسات الوسيط (P2-FINAL-1)", () => {
  /* تدفق JSON كما يرسله متصفح التطبيق (P2-FIX-1): 200 + Set-Cookie —
     loginRequest أعلاه تدفق HTML (303) فلا يصلح لمطالبة الحالة هنا. */
  function jsonLoginRequest(headers: Record<string, string>) {
    return new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ username: "dr.amjad", password: "secret" }),
    });
  }

  function successfulLogin() {
    mocks.findUserByUsername.mockResolvedValue({
      id: 1,
      username: "dr.amjad",
      displayName: "د. أمجد",
      role: "doctor",
      partyId: null,
      passwordHash: "scrypt:test:hash",
      permissions: null,
    });
    mocks.verifyPassword.mockResolvedValue(true);
    mocks.createSessionToken.mockReturnValue("unit-test-token");
  }

  function sessionSetCookie(response: Response): string {
    const cookies = response.headers.getSetCookie?.() ?? [];
    const cookie = cookies.find((entry) => entry.startsWith("aqlan_flow_session="));
    expect(cookie).toBeTruthy();
    return cookie as string;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("الإنتاج + x-forwarded-proto:http مزيّفة ⇒ كوكي الدخول تبقى Secure", async () => {
    /* هذا هو المانع نفسه: كانت الترويسة تُطفئ Secure في الإنتاج — الآن لا
       تُقرأ إطلاقًا، والقرار بيئي (NODE_ENV) لا من محتوى الطلب. */
    vi.stubEnv("NODE_ENV", "production");
    successfulLogin();
    const response = await login(jsonLoginRequest({ "x-forwarded-proto": "http" }));
    expect(response.status).toBe(200);
    expect(sessionSetCookie(response)).toMatch(/;\s*secure/i);
  });

  it("الإنتاج فوق مضيف محلي (localhost) ⇒ Secure تبقى true — لا استثناء محلي في الإنتاج", async () => {
    vi.stubEnv("NODE_ENV", "production");
    successfulLogin();
    const response = await login(jsonLoginRequest({ host: "localhost:3000" }));
    expect(response.status).toBe(200);
    expect(sessionSetCookie(response)).toMatch(/;\s*secure/i);
  });

  it("الإنتاج + Host مزيّف 127.0.0.1 ⇒ Secure تبقى true كذلك", async () => {
    vi.stubEnv("NODE_ENV", "production");
    successfulLogin();
    const response = await login(jsonLoginRequest({ host: "127.0.0.1:3000" }));
    expect(response.status).toBe(200);
    expect(sessionSetCookie(response)).toMatch(/;\s*secure/i);
  });

  it("dev/test المحلي الحقيقي (localhost) ⇒ Secure=false مسموح — لا كسر للتطوير المحلي", async () => {
    /* NODE_ENV هنا "test" (بيئة vitest) والمضيف محلي حقيقي — التساهل
       المحلي ممنوح هنا وحده، لا في الإنتاج ولا من ترويسة forwarded. */
    successfulLogin();
    const response = await login(jsonLoginRequest({ host: "localhost:3000" }));
    expect(response.status).toBe(200);
    expect(sessionSetCookie(response)).not.toMatch(/;\s*secure/i);
  });

  it("الخروج (logout) في الإنتاج: كوكي المسح نفسها Secure دائمًا — حتى مع Host محلي مزيّف", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { POST: logout } = await import("../app/api/auth/logout/route");
    const response = await logout(
      new Request("http://clinic.example.com/api/auth/logout", {
        method: "POST",
        headers: { host: "localhost" },
      }),
    );
    const cookies = response.headers.getSetCookie?.() ?? [];
    const cookie = cookies.find((entry) => entry.startsWith("aqlan_flow_session="));
    expect(cookie).toBeTruthy();
    expect(cookie).toMatch(/;\s*secure/i);
  });
});

describe("بصمة المصدر الموحدة (P0.15)", () => {
  it("أداة الشبكة تأخذ آخر قيمة x-forwarded-for (الوسيط الموثوق) لا الأولى", async () => {
    const { clientIpFromForwardedFor } = await import("../lib/net");
    /* العميل يكتب الأولى؛ الوسيط الموثوق يضيف الحقيقية آخرًا. */
    expect(clientIpFromForwardedFor("1.2.3.4, 203.0.113.9")).toBe("203.0.113.9");
    expect(clientIpFromForwardedFor("203.0.113.9")).toBe("203.0.113.9");
    expect(clientIpFromForwardedFor("")).toBeNull();
    expect(clientIpFromForwardedFor(null)).toBeNull();
    /* ومحارف غير عنوانية تُرفض. */
    expect(clientIpFromForwardedFor("1.2.3.4, evil-input")).toBeNull();
  });
});
