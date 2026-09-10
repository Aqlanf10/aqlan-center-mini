import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
}));
vi.mock("../lib/db", () => ({ consumeLoginAttempt: mocks.consume }));
import { consumeSecurityLimit } from "../lib/security-rate-limit";

/**
 * اختبارات الحدّ الأمني الموزع (P2/S10) — بصمة HMAC لا هوية خام،
 * وعمل بين النسخ عبر قاعدة البيانات، وحد المصدر خلف وسيط موثوق فقط.
 */

describe("consumeSecurityLimit", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SESSION_SECRET = "test-secret-0123456789abcdef-0123456789";
    delete process.env.TRUST_PROXY;
  });

  it("يمرر الهوية عبر بصمة HMAC لا نصًّا خامًا — المفتاح لا يشبه الهوية", async () => {
    mocks.consume.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    await consumeSecurityLimit({
      scope: "setup",
      identifier: "raw-identifier-value",
      maximum: 5,
      windowMinutes: 15,
      headers: new Headers(),
    });
    expect(mocks.consume).toHaveBeenCalledTimes(1);
    const [limits] = mocks.consume.mock.calls[0];
    expect(limits).toHaveLength(1);
    expect(limits[0].key).not.toContain("raw-identifier-value");
    expect(limits[0].key).toMatch(/^[0-9a-f]{64}$/);
    expect(limits[0].maximum).toBe(5);
  });

  it("حد المصدر يُفعَّل خلف وسيط موثوق فقط (TRUST_PROXY=true + x-forwarded-for)", async () => {
    mocks.consume.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    process.env.TRUST_PROXY = "true";
    await consumeSecurityLimit({
      scope: "book",
      identifier: "x",
      maximum: 3,
      windowMinutes: 10,
      headers: new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }),
    });
    const [limits] = mocks.consume.mock.calls[0];
    // مفتاحان: الهوية + المصدر (آخر قيمة في السلسلة)
    expect(limits).toHaveLength(2);
  });

  it("بلا TRUST_PROXY لا يُبنى مفتاح مصدر أصلًا", async () => {
    mocks.consume.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    await consumeSecurityLimit({
      scope: "book",
      identifier: "x",
      maximum: 3,
      windowMinutes: 10,
      headers: new Headers({ "x-forwarded-for": "1.2.3.4" }),
    });
    const [limits] = mocks.consume.mock.calls[0];
    expect(limits).toHaveLength(1);
  });

  it("الحد المرفوض يُعاد كما هو مع مهلة إعادة المحاولة", async () => {
    mocks.consume.mockResolvedValue({ allowed: false, retryAfterSeconds: 300 });
    const result = await consumeSecurityLimit({
      scope: "ai-chat",
      identifier: "7",
      maximum: 10,
      windowMinutes: 5,
      headers: new Headers(),
    });
    expect(result).toEqual({ allowed: false, retryAfterSeconds: 300 });
  });

  it("بلا سرّ جلسات: لا بصمة HMAC — يسمح المرور ولا يخزن هوية خام", async () => {
    delete process.env.SESSION_SECRET;
    const result = await consumeSecurityLimit({
      scope: "setup",
      identifier: "secret-identifier",
      maximum: 5,
      windowMinutes: 15,
      headers: new Headers(),
    });
    expect(result.allowed).toBe(true);
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it("عطل قاعدة البيانات لا يوقف الخدمة — يسمح (حدود الدخول الخاصة أشد)", async () => {
    mocks.consume.mockRejectedValue(new Error("db down"));
    const result = await consumeSecurityLimit({
      scope: "checkin",
      identifier: "9",
      maximum: 60,
      windowMinutes: 15,
      headers: new Headers(),
    });
    expect(result.allowed).toBe(true);
  });
});

/* ── قرارات الكوكيز (P2/S4) — انحدار المصدر ─────────────────────────── */

const loginRoute = readFileSync(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8");
const logoutRoute = readFileSync(new URL("../app/api/auth/logout/route.ts", import.meta.url), "utf8");
const portalLoginRoute = readFileSync(new URL("../app/api/portal/login/route.ts", import.meta.url), "utf8");
const portalLogoutRoute = readFileSync(new URL("../app/api/portal/logout/route.ts", import.meta.url), "utf8");

describe("قرار SameSite للكوكيز (S4)", () => {
  it("دخول الطاقم: lax دائمًا — لا None ولا Partitioned في الإنتاج", () => {
    expect(loginRoute).toContain('sameSite: "lax"');
    expect(loginRoute).not.toContain('sameSite: isLocal ? "lax" : "none"');
    expect(loginRoute).not.toContain("partitioned");
  });
  it("خروج الطاقم: نفس سمات الدخول حرفيًّا", () => {
    expect(logoutRoute).toContain('sameSite: "lax"');
    expect(logoutRoute).not.toContain("partitioned");
    expect(logoutRoute).toContain("httpOnly: true");
  });
  it("دخول البوابة: lax — لا None ولا Partitioned", () => {
    expect(portalLoginRoute).toContain('sameSite: "lax"');
    expect(portalLoginRoute).not.toContain('sameSite: "none"');
    expect(portalLoginRoute).not.toContain("partitioned");
  });
  it("خروج البوابة: نفس سمات الدخول", () => {
    expect(portalLogoutRoute).toContain('sameSite: "lax"');
    expect(portalLogoutRoute).not.toContain("partitioned");
    expect(portalLogoutRoute).toContain("httpOnly: true");
    expect(portalLogoutRoute).toContain("secure: true");
  });
});
