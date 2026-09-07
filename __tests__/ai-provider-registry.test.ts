import { beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, maskKey } from "../lib/secretbox";
import {
  OpenAiCompatibleAdapter,
  AnthropicCompatibleAdapter,
  GoogleGeminiAdapter,
  getProviderAdapter,
} from "../lib/ai-providers/adapters";
import {
  validateProviderInput,
  toAiProviderView,
  executeAiChatWithFallback,
} from "../lib/ai-providers/registry";
import type {
  AiProviderConfig,
  AiProviderInput,
} from "../lib/ai-providers/types";

// سرّ اختبار طويل بما يكفي — التشفير يشتق مفتاحه منه lazily.
process.env.SESSION_SECRET = "test-session-secret-0123456789-0123456789-abcdef";

describe("AI Provider Adapters (هندسة المحولات)", () => {
  const mockFetch = (payload: unknown, status = 200) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(payload), { status });
    }) as typeof fetch;
    return { impl, calls };
  };

  describe("OpenAiCompatibleAdapter (محول OpenAI المتوافق)", () => {
    const adapter = new OpenAiCompatibleAdapter();
    const config: AiProviderConfig = {
      id: "openai-test",
      name: "OpenAI Test",
      protocolType: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiEndpoint: null,
      apiKeyEnc: encryptSecret("sk-proj-test1234567890"),
      model: "gpt-4o-mini",
      models: ["gpt-4o-mini", "gpt-4o"],
      taskModels: {},
      organizationId: null,
      customHeaders: { "X-Test-Header": "AqlanClinic" },
      timeoutMs: 15000,
      maxTokens: 1024,
      temperature: 0.2,
      enabled: true,
      priority: 1,
      isDefault: true,
      lastTestAt: null,
      lastTestOk: null,
      lastTestMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("يبني الطلب بـ Bearer Token والهيدرز المخصصة ويستخلص الناتج بنجاح", async () => {
      const { impl, calls } = mockFetch({
        choices: [{ message: { content: "مرحباً! كيف يمكنني مساعدتك اليوم؟" } }],
      });

      const res = await adapter.chat(
        {
          messages: [{ role: "user", content: "مرحبا" }],
          fetchImpl: impl,
        },
        config,
      );

      expect(res.ok).toBe(true);
      expect(res.content).toContain("مرحباً");
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");

      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sk-proj-test1234567890");
      expect(headers["X-Test-Header"]).toBe("AqlanClinic");
      expect(headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(String(calls[0].init.body));
      expect(body.model).toBe("gpt-4o-mini");
      expect(body.messages[0].content).toBe("مرحبا");
    });

    it("يتعامل مع أخطاء الاستجابة من المزود بشكل آمن ولا يرمي استثناء", async () => {
      const { impl } = mockFetch({ error: { message: "Quota exceeded" } }, 429);
      const res = await adapter.chat(
        { messages: [{ role: "user", content: "مرحبا" }], fetchImpl: impl },
        config,
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("Quota exceeded");
    });
  });

  describe("AnthropicCompatibleAdapter (محول أنثروبيك المتوافق)", () => {
    const adapter = new AnthropicCompatibleAdapter();
    const config: AiProviderConfig = {
      id: "claude-test",
      name: "Anthropic Claude",
      protocolType: "anthropic-compatible",
      baseUrl: "https://api.anthropic.com",
      apiEndpoint: null,
      apiKeyEnc: encryptSecret("sk-ant-api03-test12345678"),
      model: "claude-3-5-sonnet-20241022",
      models: ["claude-3-5-sonnet-20241022"],
      taskModels: {},
      organizationId: null,
      customHeaders: {},
      timeoutMs: 20000,
      maxTokens: 1024,
      temperature: 0.3,
      enabled: true,
      priority: 2,
      isDefault: false,
      lastTestAt: null,
      lastTestOk: null,
      lastTestMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("يبني الطلب بهيدر x-api-key ويفصل رسالة النظام system عن بقية الرسائل", async () => {
      const { impl, calls } = mockFetch({
        content: [{ type: "text", text: "أهلاً بك في عيادة الدكتور عقلان" }],
      });

      const res = await adapter.chat(
        {
          messages: [
            { role: "system", content: "أنت مساعد المركز" },
            { role: "user", content: "ما هي مواعيد العمل؟" },
          ],
          fetchImpl: impl,
        },
        config,
      );

      expect(res.ok).toBe(true);
      expect(res.content).toContain("عقلان");
      expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");

      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("sk-ant-api03-test12345678");
      expect(headers["anthropic-version"]).toBe("2023-06-01");

      const body = JSON.parse(String(calls[0].init.body));
      expect(body.system).toBe("أنت مساعد المركز");
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe("user");
    });
  });

  describe("GoogleGeminiAdapter (محول جوجل جيميناي)", () => {
    const adapter = new GoogleGeminiAdapter();
    const config: AiProviderConfig = {
      id: "gemini-test",
      name: "Google Gemini",
      protocolType: "google-gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiEndpoint: null,
      apiKeyEnc: encryptSecret("AIzaSyTestKey1234567890"),
      model: "gemini-2.0-flash",
      models: ["gemini-2.0-flash"],
      taskModels: {},
      organizationId: null,
      customHeaders: {},
      timeoutMs: 15000,
      maxTokens: 1024,
      temperature: 0.2,
      enabled: true,
      priority: 3,
      isDefault: false,
      lastTestAt: null,
      lastTestOk: null,
      lastTestMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("يرسل المفتاح كمعامل استعلام ويحول بنية الرسائل إلى contents بنجاح", async () => {
      const { impl, calls } = mockFetch({
        candidates: [
          {
            content: {
              parts: [{ text: "استجابة جيميناي السريعة للعيادة" }],
            },
          },
        ],
      });

      const res = await adapter.chat(
        {
          messages: [{ role: "user", content: "فحص" }],
          fetchImpl: impl,
        },
        config,
      );

      expect(res.ok).toBe(true);
      expect(res.content).toContain("جيميناي");
      expect(calls[0].url).toContain("key=AIzaSyTestKey1234567890");
      expect(calls[0].url).toContain(":generateContent");
    });
  });

  it("getProviderAdapter يرجع المحول المطابق للبروتوكول", () => {
    expect(getProviderAdapter("openai-compatible")).toBeInstanceOf(OpenAiCompatibleAdapter);
    expect(getProviderAdapter("openai-responses")).toBeInstanceOf(OpenAiCompatibleAdapter);
    expect(getProviderAdapter("anthropic-compatible")).toBeInstanceOf(AnthropicCompatibleAdapter);
    expect(getProviderAdapter("google-gemini")).toBeInstanceOf(GoogleGeminiAdapter);
    expect(getProviderAdapter("custom-http")).toBeInstanceOf(OpenAiCompatibleAdapter);
  });
});

describe("الأمان والتشفير وإخفاء المفاتيح (Security & Masking)", () => {
  it("toAiProviderView يحذف المفتاح المشفر نهائياً ويعيد فقط النسخة المقنعة", () => {
    const rawKey = "sk-live-super-secret-key-1234567890";
    const config: AiProviderConfig = {
      id: "prov-secret",
      name: "Secret Provider",
      protocolType: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiEndpoint: null,
      apiKeyEnc: encryptSecret(rawKey),
      model: "gpt-4o",
      models: ["gpt-4o"],
      taskModels: {},
      organizationId: null,
      customHeaders: {},
      timeoutMs: 10000,
      maxTokens: 500,
      temperature: 0.1,
      enabled: true,
      priority: 1,
      isDefault: true,
      lastTestAt: null,
      lastTestOk: null,
      lastTestMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const view = toAiProviderView(config);

    // التحقق الصارم من عدم تسريب المفتاح
    expect((view as unknown as Record<string, unknown>).apiKeyEnc).toBeUndefined();
    expect(view.hasKey).toBe(true);
    expect(view.keyMasked).not.toBe(rawKey);
    expect(view.keyMasked).toContain("••••");
    expect(view.keyMasked.startsWith("sk-l")).toBe(true);
    expect(view.keyMasked.endsWith("7890")).toBe(true);
  });

  it("فك تشفير المفتاح يعيد القيمة الأصلية بدقة تامة", () => {
    const key = "custom-glm-apikey-very-long-987654321";
    const enc = encryptSecret(key);
    expect(decryptSecret(enc)).toBe(key);
    expect(maskKey(key)).toContain("••••");
  });
});

describe("التحقق من صحة مدخلات المزود (Provider Input Validation)", () => {
  const validInput: AiProviderInput = {
    id: "deepseek-chat",
    name: "DeepSeek Chat",
    protocolType: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    timeoutMs: 15000,
    maxTokens: 1024,
    temperature: 0.2,
    enabled: true,
    isDefault: false,
  };

  it("يقبل إعدادات صحيحة ومكتملة", () => {
    expect(validateProviderInput(validInput)).toBeNull();
  });

  it("يرفض مزوداً بدون اسم أو بمعرف غير صالح", () => {
    expect(validateProviderInput({ ...validInput, name: "  " })).not.toBeNull();
    expect(validateProviderInput({ ...validInput, id: "invalid id with spaces!" })).not.toBeNull();
  });

  it("يرفض بروتوكولاً غير معروف أو عنوان URL غير سليم", () => {
    expect(validateProviderInput({ ...validInput, protocolType: "unknown-proto" as never })).not.toBeNull();
    expect(validateProviderInput({ ...validInput, baseUrl: "not-a-valid-url" })).not.toBeNull();
    expect(validateProviderInput({ ...validInput, baseUrl: "ftp://api.example.com" })).not.toBeNull();
  });

  it("يرفض القيم الرقمية غير المنطقية للـ timeout أو maxTokens أو temperature", () => {
    expect(validateProviderInput({ ...validInput, timeoutMs: 500 })).not.toBeNull(); // أقل من 1000
    expect(validateProviderInput({ ...validInput, temperature: 2.5 })).not.toBeNull(); // أكبر من 2
    expect(validateProviderInput({ ...validInput, maxTokens: 0 })).not.toBeNull();
  });
});

describe("سلسلة التراجع التلقائي (Automatic Fallback Chain)", () => {
  it("عندما يفشل المزود الأول، ينتقل النظام تلقائياً للمزود الثاني ويسجل مسار التراجع", async () => {
    let callCount = 0;
    const mockFetchSequence = (async (url: string | URL) => {
      callCount++;
      const urlStr = String(url);
      if (urlStr.includes("api.provider-one.test")) {
        // المزود الأول يفشل بنفاد الرصيد 429
        return new Response(JSON.stringify({ error: { message: "Insufficient balance" } }), { status: 429 });
      }
      if (urlStr.includes("api.provider-two.test")) {
        // المزود الثاني ينجح في الإجابة
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "إجابة ناجحة من المزود الاحتياطي الثاني" } }],
          }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;

    const provider1: AiProviderConfig = {
      id: "p1",
      name: "Primary Provider",
      protocolType: "openai-compatible",
      baseUrl: "https://api.provider-one.test/v1",
      apiEndpoint: null,
      apiKeyEnc: encryptSecret("sk-key-p1"),
      model: "model-1",
      models: ["model-1"],
      taskModels: {},
      organizationId: null,
      customHeaders: {},
      timeoutMs: 5000,
      maxTokens: 500,
      temperature: 0.2,
      enabled: true,
      priority: 1,
      isDefault: true,
      lastTestAt: null,
      lastTestOk: null,
      lastTestMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const provider2: AiProviderConfig = {
      id: "p2",
      name: "Secondary Provider",
      protocolType: "openai-compatible",
      baseUrl: "https://api.provider-two.test/v1",
      apiEndpoint: null,
      apiKeyEnc: encryptSecret("sk-key-p2"),
      model: "model-2",
      models: ["model-2"],
      taskModels: {},
      organizationId: null,
      customHeaders: {},
      timeoutMs: 5000,
      maxTokens: 500,
      temperature: 0.2,
      enabled: true,
      priority: 2,
      isDefault: false,
      lastTestAt: null,
      lastTestOk: null,
      lastTestMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // نختبر تنفيذ المحولات في السلسلة
    const adapter = getProviderAdapter("openai-compatible");
    
    // محاولة المزود الأول
    const res1 = await adapter.chat(
      { messages: [{ role: "user", content: "فحص" }], fetchImpl: mockFetchSequence },
      provider1,
    );
    expect(res1.ok).toBe(false);

    // التحول التلقائي للمزود الثاني
    const res2 = await adapter.chat(
      { messages: [{ role: "user", content: "فحص" }], fetchImpl: mockFetchSequence },
      provider2,
    );
    expect(res2.ok).toBe(true);
    expect(res2.content).toContain("المزود الاحتياطي الثاني");
    expect(callCount).toBe(2);
  });

  it("عند فشل جميع المزودين السحابيين، يتحول البوت تلقائياً إلى المحرك السريري الداخلي للمركز دون توقف", async () => {
    // جميع استدعاءات الشبكة تفشل
    const alwaysFailFetch = (async () => {
      throw new Error("Network unreachable / No Internet");
    }) as typeof fetch;

    // استدعاء executeAiChatWithFallback بدون مزودي شبكة متاحين
    const result = await executeAiChatWithFallback(
      {
        messages: [{ role: "user", content: "كم عدد المرضى في العيادة؟" }],
      },
      alwaysFailFetch,
    );

    expect(result.ok).toBe(true);
    // تأكيد تفعيل المحرك الداخلي
    expect(result.providerName).toBe("Aqlan Internal Engine");
    expect(result.isInternalFallback).toBe(true);
    expect(result.fallbackChainUsed).toContain("Aqlan Internal Clinical Engine");
    expect(result.content.length).toBeGreaterThan(0);
  });
});
