import { describe, expect, it } from "vitest";
import {
  exactOriginVerdict,
  normalizeOrigin,
  trustedOriginsFromEnv,
} from "../lib/origin-policy";

/**
 * اختبارات سياسة الأصل الدقيق (P2-FIX-4) — وحدة نقية بقرارات بيئية لكل
 * حالة: مطابقة أصلٍ كامل (scheme://host[:port]) لطلبات الكوكي، فشل مغلق
 * في الإنتاج بلا سياسة أصل مثبتة، وتوثيق ترويسات الوسيط عند TRUST_PROXY
 * فقط، ومعيار المضيف القديم محفوظ لطلبات بلا كوكي حصراً.
 */

const OWN = "https://clinic.example.com";

function cookieVerdict(overrides: Record<string, unknown>): ReturnType<typeof exactOriginVerdict> {
  return exactOriginVerdict({
    origin: OWN,
    cookieAuthenticated: true,
    ownOrigin: OWN,
    trustProxy: false,
    forwardedProto: null,
    forwardedHost: null,
    isProduction: false,
    envTrustedOrigins: [],
    ...overrides,
  });
}

describe("normalizeOrigin — تطبيع الأصل الكامل", () => {
  it("يسقط المنفذ الافتراضي ويوحّد الحروف", () => {
    expect(normalizeOrigin("HTTPS://Clinic.Example.com:443")).toBe("https://clinic.example.com");
    expect(normalizeOrigin("http://clinic.example.com:80/")).toBe("http://clinic.example.com");
    expect(normalizeOrigin("https://clinic.example.com:8443")).toBe("https://clinic.example.com:8443");
  });

  it("يفسد الشكل ⇒ null (لا مضيف وحيد ولا مسار ولا استعلام)", () => {
    expect(normalizeOrigin("clinic.example.com")).toBeNull();
    expect(normalizeOrigin("https://clinic.example.com/path")).toBe("https://clinic.example.com");
    expect(normalizeOrigin("::::not-a-url")).toBeNull();
    expect(normalizeOrigin(null)).toBeNull();
    expect(normalizeOrigin("ftp://clinic.example.com")).toBeNull();
  });
});

describe("trustedOriginsFromEnv — القائمة من البيئة", () => {
  it("APP_ORIGIN + TRUSTED_ORIGINS تُطبَّع؛ ما ليس أصلاً كاملاً يُرفض لا يُقبَل", () => {
    const list = trustedOriginsFromEnv({
      APP_ORIGIN: "https://clinic.example.com:443",
      TRUSTED_ORIGINS: " https://portal.clinic.example.com , clinic-without-scheme.example ",
    });
    expect(list).toEqual(["https://clinic.example.com", "https://portal.clinic.example.com"]);
  });
});

describe("طلبات الكوكي — المطابقة الدقيقة (قائمة صريحة)", () => {
  const env = ["https://clinic.example.com"];

  it("نفس الأصل حرفياً ⇒ يمر", () => {
    expect(cookieVerdict({ origin: "https://clinic.example.com", envTrustedOrigins: env })).toBe("allowed");
  });

  it("نفس المضيف ببروتوكول آخر (http) ⇒ يُرفض", () => {
    expect(cookieVerdict({ origin: "http://clinic.example.com", envTrustedOrigins: env })).toBe("rejected");
  });

  it("نفس المضيف بمنفذ آخر (:8443) ⇒ يُرفض", () => {
    expect(cookieVerdict({ origin: "https://clinic.example.com:8443", envTrustedOrigins: env })).toBe("rejected");
  });

  it("أصل غريب (evil) ⇒ يُرفض", () => {
    expect(cookieVerdict({ origin: "https://evil.attacker.example", envTrustedOrigins: env })).toBe("rejected");
  });

  it("نطاق فرعي غير مدرج ⇒ يُرفض", () => {
    expect(cookieVerdict({ origin: "https://evil.clinic.example.com", envTrustedOrigins: env })).toBe("rejected");
  });

  it("أصل فاسد الشكل ⇒ يُرفض", () => {
    expect(cookieVerdict({ origin: "::::not-a-url", envTrustedOrigins: env })).toBe("rejected");
  });
});

describe("طلبات الكوكي — الإنتاج بلا قائمة: فشل مغلق أو وسيط موثوق", () => {
  it("بلا TRUST_PROXY ⇒ رفض (لا يمكن إثبات أصل كانوني من ترويسات العميل)", () => {
    expect(cookieVerdict({ isProduction: true, origin: OWN })).toBe("rejected");
  });

  it("TRUST_PROXY=true: الأصل الكانوني من ترويسات الوسيط يطابق ⇒ يمر", () => {
    expect(cookieVerdict({
      isProduction: true,
      trustProxy: true,
      forwardedProto: "https",
      forwardedHost: "clinic.example.com",
      ownOrigin: "http://127.0.0.1:3000",
      origin: "https://clinic.example.com",
    })).toBe("allowed");
  });

  it("TRUST_PROXY=true: ترويسات مزيّفة لا تطابق الأصل المزعوم ⇒ يُرفض", () => {
    expect(cookieVerdict({
      isProduction: true,
      trustProxy: true,
      forwardedProto: "http",
      forwardedHost: "clinic.example.com",
      origin: "https://clinic.example.com",
    })).toBe("rejected");
  });

  it("TRUST_PROXY=false: x-forwarded-host مزيّف لا يفتح الباب (fail-closed)", () => {
    expect(cookieVerdict({
      isProduction: true,
      trustProxy: false,
      forwardedHost: "attacker-matched.example",
      origin: "https://attacker-matched.example",
    })).toBe("rejected");
  });
});

describe("طلبات الكوكي — التطوير/الاختبار: مطابقة دقيقة لأصل الخادم", () => {
  it("نفس أصل الخادم ⇒ يمر", () => {
    expect(cookieVerdict({ ownOrigin: "http://localhost:3000", origin: "http://localhost:3000" })).toBe("allowed");
  });

  it("نفس المضيف بمنفذ آخر ⇒ يُرفض", () => {
    expect(cookieVerdict({ ownOrigin: "http://localhost:3000", origin: "http://localhost:3001" })).toBe("rejected");
  });
});

describe("طلبات بلا كوكي — نظافة أصل لا حدّ CSRF", () => {
  it("أصل من قائمة المشغّل ⇒ يمرّ حتى بلا كوكي", () => {
    expect(cookieVerdict({
      cookieAuthenticated: false,
      envTrustedOrigins: ["https://clinic.example.com"],
      nonCookieHostTrusted: false,
    })).toBe("allowed");
  });

  it("معيار المضيف الموثوق القديم يبقى ساريًا لطلبات بلا جلسة", () => {
    expect(cookieVerdict({
      cookieAuthenticated: false,
      origin: "https://aqlan-sec.test",
      nonCookieHostTrusted: true,
    })).toBe("allowed");
    expect(cookieVerdict({
      cookieAuthenticated: false,
      origin: "https://evil.attacker.example",
      nonCookieHostTrusted: false,
    })).toBe("rejected");
  });
});

describe("غياب Origin — القرار للمستدعي بسياقه", () => {
  it("no-origin: كوكي ⇒ رفض fail-closed؛ بلا كوكي ⇒ حدود المسار نفسه", () => {
    expect(exactOriginVerdict({
      origin: null,
      cookieAuthenticated: true,
      ownOrigin: OWN,
      trustProxy: false,
      forwardedProto: null,
      forwardedHost: null,
      isProduction: true,
      envTrustedOrigins: [],
    })).toBe("no-origin");
  });
});
