import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ consume: vi.fn() }));
vi.mock("@/lib/db", () => ({ consumeLoginAttempt: mocks.consume }));
import {
  ACCOUNT_ATTEMPTS,
  SOURCE_ATTEMPTS,
  WINDOW_MINUTES,
  consumeLoginAttemptFor,
} from "../lib/loginLimit";

const SECRET = "unit-test-secret-0123456789abcdef-0123456789";
const original = {
  secret: process.env.SESSION_SECRET,
  proxy: process.env.TRUST_PROXY,
};

beforeEach(() => {
  vi.resetAllMocks();
  process.env.SESSION_SECRET = SECRET;
  delete process.env.TRUST_PROXY;
});

afterEach(() => {
  if (original.secret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = original.secret;
  if (original.proxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = original.proxy;
});

const headers = (extra: Record<string, string> = {}) => new Headers(extra);

describe("حدّ محاولات الدخول المشترك", () => {
  it("مفتاح الحساب بصمة HMAC لا اسمٌ مفتوح — ولا يُستعلم عن مستخدم", async () => {
    mocks.consume.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    await consumeLoginAttemptFor("staff", "Doctor", headers());
    const [limits, window] = mocks.consume.mock.calls[0];
    expect(window).toBe(WINDOW_MINUTES);
    expect(limits).toHaveLength(1);
    expect(limits[0].maximum).toBe(ACCOUNT_ATTEMPTS);
    // الجدول لو قُرئ لا يقول «Doctor حاول عشر مرات»: المفتاح بصمة، لا نصّ.
    expect(limits[0].key).not.toContain("octor");
    expect(limits[0].key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("البصمة ثابتة عبر النسخ وموحّدة بالحالة والفراغات", async () => {
    mocks.consume.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    await consumeLoginAttemptFor("staff", "  Doctor ", headers());
    await consumeLoginAttemptFor("staff", "doctor", headers());
    expect(mocks.consume.mock.calls[0][0][0].key).toBe(mocks.consume.mock.calls[1][0][0].key);
  });

  it("بصمة البوابة غير بصمة الطاقم — فمهاجمة بوابةٍ لا تُقفل حساب الطاقم", async () => {
    mocks.consume.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    await consumeLoginAttemptFor("staff", "doctor", headers());
    await consumeLoginAttemptFor("portal", "doctor", headers());
    expect(mocks.consume.mock.calls[0][0][0].key).not.toBe(mocks.consume.mock.calls[1][0][0].key);
  });

  it("حدّ المصدر يُفعَّل خلف الوسيط الموثوق وحده ويعزل العنوان الأخير", async () => {
    mocks.consume.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    // بلا وسيط موثوق: لا حدّ للمصدر أصلًا — فالعنوان يكتبه العميل.
    await consumeLoginAttemptFor("staff", "doctor", headers({ "x-forwarded-for": "203.0.113.7" }));
    expect(mocks.consume.mock.calls[0][0]).toHaveLength(1);

    process.env.TRUST_PROXY = "true";
    await consumeLoginAttemptFor("staff", "doctor", headers({ "x-forwarded-for": "198.51.100.9, 203.0.113.7" }));
    const limits = mocks.consume.mock.calls[1][0];
    expect(limits).toHaveLength(2);
    expect(limits[1].maximum).toBe(SOURCE_ATTEMPTS);
    expect(limits[1].key).not.toBe(limits[0].key);
    expect(limits[1].key).not.toContain("203.0.113.7");
  });

  it("بلا سرٍّ (أو سرٍّ قصير) يُترك الحدّ القديم يعمل — لا يُستهلك شيء", async () => {
    delete process.env.SESSION_SECRET;
    await expect(consumeLoginAttemptFor("staff", "doctor", headers())).resolves.toEqual({
      allowed: true, retryAfterSeconds: 0,
    });
    expect(mocks.consume).not.toHaveBeenCalled();

    process.env.SESSION_SECRET = "short";
    await expect(consumeLoginAttemptFor("staff", "doctor", headers())).resolves.toEqual({
      allowed: true, retryAfterSeconds: 0,
    });
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it("نتيجة الحصاد تُنقل كما هي — المنع ومهلة الإعادة", async () => {
    mocks.consume.mockResolvedValue({ allowed: false, retryAfterSeconds: 777 });
    await expect(consumeLoginAttemptFor("staff", "doctor", headers())).resolves.toEqual({
      allowed: false, retryAfterSeconds: 777,
    });
  });
});
