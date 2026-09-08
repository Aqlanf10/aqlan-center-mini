import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("مضيف موثوق من قائمة المشغّل يعيد رابطًا مطلقًا له وحده", async () => {
    process.env.TRUSTED_HOSTS = "center.example.com";
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
