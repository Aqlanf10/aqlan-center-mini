import { describe, expect, it } from "vitest";

/**
 * اختبارات نظافة أخطاء مزودي الذكاء الاصطناعي (P2-FIX-4 / S13):
 *
 * تفصيلة المزود الخام (payload.error.message / err.message) بياناتٌ غير
 * موثوقة — لا تخرج للعميل ولا تُخزَّن في last_test_message إلا بعد
 * التعقيم: بريئة ⇒ ملخص مُقيَّد بسطر واحد وطول محدود؛ حاملة سرّ أو مسار
 * أو رابط قاعدة أو ترويسة توثيق ⇒ التصنيف الآمن العام حصراً.
 */

process.env.SESSION_SECRET = "provider-hygiene-test-secret-0123456789abcdef";

import { sanitizeProviderDetail, providerFailureCategory, sanitizeErrorMessage } from "../lib/redact";
import { aiChat, type AiSettingsRow } from "../lib/ai";
import { encryptSecret } from "../lib/secretbox";
import { OpenAiCompatibleAdapter, GoogleGeminiAdapter } from "../lib/ai-providers/adapters";
import type { AiProviderConfig } from "../lib/ai-providers/types";

function settingsRow(overrides: Partial<AiSettingsRow> = {}): AiSettingsRow {
  return {
    enabled: true,
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKeyEnc: encryptSecret("sk-hygiene-test-key-000111"),
    keyMasked: "sk-••••",
    hasKey: true,
    lastTestAt: null,
    lastTestOk: null,
    lastTestMessage: null,
    updatedBy: null,
    updatedAt: null,
    ...overrides,
  };
}

function providerConfig(overrides: Partial<AiProviderConfig> = {}): AiProviderConfig {
  return {
    id: "sec-test",
    name: "مزود النظافة (اختبار)",
    protocolType: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiEndpoint: null,
    model: "gpt-4o-mini",
    models: ["gpt-4o-mini"],
    apiKeyEnc: encryptSecret("sk-hygiene-test-key-000111"),
    organizationId: null,
    customHeaders: {},
    timeoutMs: 30000,
    maxTokens: 256,
    temperature: 0.2,
    enabled: true,
    isDefault: true,
    priority: 1,
    taskModels: {},
    lastTestAt: null,
    lastTestOk: null,
    lastTestMessage: null,
    lastTestLatency: null,
    createdAt: undefined,
    updatedAt: undefined,
    updatedBy: null,
    ...overrides,
  };
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("sanitizeProviderDetail — وحدة التعقيم", () => {
  it("رابط قاعدة بيانات في التفصيلة ⇒ null (تصنيف عام فقط)", () => {
    expect(sanitizeProviderDetail("connect ECONNREFUSED DATABASE_URL=postgres://ci:ci@db:5432/x")).toBeNull();
    expect(sanitizeProviderDetail("postgresql://admin:secret@internal-host/db")).toBeNull();
  });

  it("ترويسة Authorization/Bearer أو مفتاح API ⇒ null", () => {
    expect(sanitizeProviderDetail("Invalid key: Authorization: Bearer sk-abcdef123456")).toBeNull();
    expect(sanitizeProviderDetail("key sk-proj-abcdef123456 rejected")).toBeNull();
    expect(sanitizeProviderDetail("AIzaSyA-1234567890-abcdefg malformed")).toBeNull();
  });

  it("مسار ملف أو stack trace أو node_modules ⇒ null", () => {
    expect(sanitizeProviderDetail("cannot read config at /home/app/server/.env")).toBeNull();
    expect(sanitizeProviderDetail("at Object.handler (/app/dist/route.js:12:34)")).toBeNull();
    expect(sanitizeProviderDetail("module missing in node_modules/openai/index.js")).toBeNull();
  });

  it("SESSION_SECRET أو api_key= ⇒ null", () => {
    expect(sanitizeProviderDetail("missing SESSION_SECRET value")).toBeNull();
    expect(sanitizeProviderDetail("api_key=abc123invalid")).toBeNull();
  });

  it("رسالة بريئة قصيرة ⇒ تمرّ كما هي (ملخص آمن مقيّد)", () => {
    expect(sanitizeProviderDetail("Invalid model parameter")).toBe("Invalid model parameter");
    expect(sanitizeProviderDetail("model access denied for org")).toBe("model access denied for org");
  });

  it("سطر واحد وطول محدود: جديدة تُطوى والطويل يُلخَّص بحدّ 160", () => {
    expect(sanitizeProviderDetail("line1\nline2\tmore")).toBe("line1 line2 more");
    const long = "x".repeat(300);
    const out = sanitizeProviderDetail(long);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(160);
    expect(out!.endsWith("…")).toBe(true);
  });

  it("لمة ضخمة جداً (>1000) ⇒ null — لا مجمل لأي blob تشخيصي", () => {
    expect(sanitizeProviderDetail("y".repeat(1200))).toBeNull();
  });

  it("providerFailureCategory: تصنيفات آمنة بلا تفصيلة", () => {
    expect(providerFailureCategory(401)).toContain("بيانات الاعتماد");
    expect(providerFailureCategory(429)).toContain("حدّ الاستخدام");
    expect(providerFailureCategory(503)).toContain("عطل");
    expect(providerFailureCategory(null)).toContain("تعذّر الوصول");
  });
});

describe("aiChat — فشل المزود لا يسرّب أي تفصيلة خام", () => {
  it("500 مع payload.error.message يحمل رابط قاعدة ⇒ لا DATABASE_URL ولا postgres:// في الخطأ", async () => {
    const fetchImpl = (async () =>
      json({ error: { message: "upstream failure DATABASE_URL=postgres://ci:ci@10.0.0.5/db" } }, 500)) as typeof fetch;
    const result = await aiChat(
      { messages: [{ role: "user", content: "فحص" }], fetchImpl },
      settingsRow(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("DATABASE_URL");
    expect(result.error).not.toContain("postgres");
    expect(result.error).not.toContain("10.0.0.5");
    expect(result.error).toContain("عطل لدى المزوّد");
  });

  it("401 مع رسالة تحمل ترويسة Bearer كاملة ⇒ لا توكن في الخطأ", async () => {
    const fetchImpl = (async () =>
      json({ error: { message: "Invalid Authorization: Bearer sk-secret-abcdef123456" } }, 401)) as typeof fetch;
    const result = await aiChat(
      { messages: [{ role: "user", content: "فحص" }], fetchImpl },
      settingsRow(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("sk-secret-abcdef123456");
    expect(result.error).toContain("بيانات الاعتماد");
  });

  it("رسالة بريئة ⇒ ملخص آمن مُقيَّد يظهر (لا فقدان تشخيصٍ نافع)", async () => {
    const fetchImpl = (async () =>
      json({ error: { message: "Invalid model parameter: gpt-nonexistent" } }, 400)) as typeof fetch;
    const result = await aiChat(
      { messages: [{ role: "user", content: "فحص" }], fetchImpl },
      settingsRow(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid model parameter");
    expect(result.error!.length).toBeLessThan(220);
  });

  it("خطأ نقل عادي ⇒ تصنيف تعذّر الوصول بلا كومة أو تفاصيل داخلية", async () => {
    const fetchImpl = (async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;
    const result = await aiChat(
      { messages: [{ role: "user", content: "فحص" }], fetchImpl },
      settingsRow(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("تعذّر الوصول");
  });

  it("مهلة اتصال ⇒ تصنيف مهلة صريح", async () => {
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    const fetchImpl = (async () => {
      throw timeoutError;
    }) as typeof fetch;
    const result = await aiChat(
      { messages: [{ role: "user", content: "فحص" }], fetchImpl },
      settingsRow(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("مهلة");
  });
});

describe("المحولات — نفس قاعدة التعقيم على مستوى كل بروتوكول", () => {
  it("OpenAI-compatible: 401 برسالة تحمل مفتاحاً ⇒ التصنيف الآمن فقط", async () => {
    const adapter = new OpenAiCompatibleAdapter();
    const fetchImpl = (async () =>
      json({ error: { message: "Incorrect API key: Bearer sk-leaked-abcdef123" } }, 401)) as typeof fetch;
    const result = await adapter.chat(
      { messages: [{ role: "user", content: "فحص" }], fetchImpl },
      providerConfig(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("sk-leaked-abcdef123");
    expect(result.error).toContain("بيانات الاعتماد");
  });

  it("Gemini: 500 برسالة تحمل مسار ملف ⇒ لا مسار في الخطأ", async () => {
    const adapter = new GoogleGeminiAdapter();
    const fetchImpl = (async () =>
      json({ error: { message: "backend crashed at /var/app/internal.js" } }, 500)) as typeof fetch;
    const result = await adapter.chat(
      { messages: [{ role: "user", content: "فحص" }], fetchImpl },
      providerConfig({ protocolType: "google-gemini", baseUrl: "https://generativelanguage.googleapis.com" }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("/var/app");
    expect(result.error).toContain("عطل");
  });
});

describe("sanitizeErrorMessage — المسارات العامة باقية محصّنة", () => {
  it("أسرار بيئة ومسارات ⇒ الجواب العام", () => {
    expect(sanitizeErrorMessage(new Error("connect DATABASE_URL=postgres://x"), "عام")).toBe("عام");
    expect(sanitizeErrorMessage(new Error("read /home/app/secret failed"), "عام")).toBe("عام");
    expect(sanitizeErrorMessage(new Error("normal failure"), "عام")).toBe("normal failure");
  });
});
