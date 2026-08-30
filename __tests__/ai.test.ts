import { beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, maskKey } from "../lib/secretbox";
import {
  aiChat,
  sanitizeForPrivacy,
  validateAiInput,
  AI_DEFAULT_BASE_URL,
  type AiSettingsRow,
  type AiChatResult,
} from "../lib/ai";

/**
 * اختبارات وحدة خدمة الذكاء الاصطناعي — كلها بلا قاعدة بيانات وبلا شبكة.
 *
 * القاعدتان الدستوريتان اللتان تحرسهما:
 * - **المفتاح لا يُخزَّن نصًّا صريحًا ولا يعود من أي قراءة** (تشفير + إخفاء).
 * - **لا هوية صريحة تخرج نحو المزوّد** (حارس الخصوصية).
 */

beforeAll(() => {
  // سرّ اختبار طويل بما يكفي — التشفير يشتق مفتاحه منه lazily.
  process.env.SESSION_SECRET = "test-session-secret-0123456789-0123456789-abcdef";
});

describe("صندوق الأسرار", () => {
  it("دورة تشفير/فك تعيد النص الأصلي", () => {
    const key = "sk-zai-test-key-9876543210abcdef";
    const encrypted = encryptSecret(key);
    // لا يظهر النص الصريح في المخزَّن إطلاقًا.
    expect(encrypted).not.toContain("sk-zai");
    expect(decryptSecret(encrypted)).toBe(key);
  });

  it("كل تشفير ينتج IV جديدًا فلا نصّان متطابقان بنفس الشكل", () => {
    const a = encryptSecret("same-value-key-123456");
    const b = encryptSecret("same-value-key-123456");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it("التلاعب ببايت واحد يُكشف ولا يعيد قيمة زائفة", () => {
    const encrypted = encryptSecret("integrity-check-key-1");
    const parts = encrypted.split(".");
    // نقلب بايتًا في نصّ التشفير نفسه.
    const ciphertext = Buffer.from(parts[2], "base64url");
    ciphertext[0] ^= 0xff;
    const tampered = [parts[0], parts[1], ciphertext.toString("base64url")].join(".");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("الإخفاء يعرض بداية ونهاية فقط ولا يعرض المفتاح كاملًا", () => {
    const masked = maskKey("sk-abcdef1234567890");
    expect(masked.startsWith("sk-a")).toBe(true);
    expect(masked.endsWith("7890")).toBe(true);
    expect(masked).not.toContain("bcdef");
    expect(maskKey("short123")).toContain("••••");
  });
});

describe("حارس الخصوصية", () => {
  it("يزيل أرقام الهواتف والملفات المتتابعة قبل الخروج", () => {
    const text = "المريض أحمد هاتفه 0777123456 ملف رقم 45321";
    const clean = sanitizeForPrivacy(text);
    expect(clean).not.toContain("0777123456");
    expect(clean).not.toContain("45321");
    // الأرقام القصيرة المعقولة سريريًا تبقى (قيم قياس، أعوام).
    expect(sanitizeForPrivacy("القيمة 12.5 في 2024")).toContain("12.5");
  });

  it("يزيل البريد والأرقام العربية-الهندية الطويلة", () => {
    const clean = sanitizeForPrivacy("راسلنا على owner@clinic.com أو ٠٧٧٧١٢٣٤٥٦");
    expect(clean).not.toContain("owner@clinic.com");
    expect(clean).not.toContain("٠٧٧٧١٢٣٤٥٦");
  });
});

describe("التحقق من المدخلات", () => {
  const base = {
    enabled: false,
    provider: "zai" as const,
    baseUrl: AI_DEFAULT_BASE_URL.zai,
    model: "glm-4.6",
  };

  it("يقبل إعدادًا صحيحًا", () => {
    expect(validateAiInput(base)).toBeNull();
    expect(validateAiInput({ ...base, enabled: true, apiKey: "sk-valid-key-0001" })).toBeNull();
  });

  it("يرفض مزوّدًا خارج القائمة وعنوانًا بلا بروتوكول ونموذجًا بحرف غريب", () => {
    expect(validateAiInput({ ...base, provider: "unknown" as never })).not.toBeNull();
    expect(validateAiInput({ ...base, baseUrl: "api.z.ai" })).not.toBeNull();
    expect(validateAiInput({ ...base, model: "glm 4.6; drop" })).not.toBeNull();
  });

  it("يرفض مفتاحًا جديدًا قصيرًا", () => {
    expect(validateAiInput({ ...base, apiKey: "abc" })).not.toBeNull();
  });
});

describe("الاستدعاء — يقترح ولا يعتمد", () => {
  const config = (over: Partial<AiSettingsRow> = {}): AiSettingsRow => ({
    enabled: true,
    provider: "zai",
    baseUrl: "https://api.example.test/v4",
    model: "glm-4.6",
    apiKeyEnc: encryptSecret("sk-live-test-1234567890"),
    keyMasked: "",
    hasKey: true,
    lastTestAt: null,
    lastTestOk: null,
    lastTestMessage: null,
    updatedBy: null,
    updatedAt: null,
    ...over,
  });

  const mockFetch = (payload: unknown, status = 200) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(payload), { status });
    }) as typeof fetch;
    return { impl, calls };
  };

  it("خدمة متوقفة لا تُصدر أي طلب شبكة", async () => {
    const { impl, calls } = mockFetch({});
    const result = await aiChat(
      { messages: [{ role: "user", content: "مرحبا" }], fetchImpl: impl },
      config({ enabled: false, apiKeyEnc: null }),
    );
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("يبني الطلب OpenAI-compatible ويقرأ الناتج", async () => {
    const { impl, calls } = mockFetch({
      choices: [{ message: { content: "اقتراح: علاج مبكر" } }],
    });
    const result = await aiChat(
      {
        messages: [
          { role: "system", content: "أنت مساعد سريري" },
          { role: "user", content: "حلّل" },
        ],
        fetchImpl: impl,
      },
      config(),
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("اقتراح");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.example.test/v4/chat/completions");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer /);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("glm-4.6");
    expect(body.stream).toBe(false);
  });

  it("لا تخرج هوية صريحة في جسم الطلب حتى دخلت في النص المُرسل", async () => {
    const { impl, calls } = mockFetch({ choices: [{ message: { content: "تم" } }] });
    await aiChat(
      { messages: [{ role: "user", content: "المريض 0777123456 حالة صف Class II" }], fetchImpl: impl },
      config(),
    );
    const body = JSON.parse(String(calls[0].init.body));
    const sent = JSON.stringify(body.messages);
    expect(sent).not.toContain("0777123456");
    expect(sent).toContain("Class II");
  });

  it("خطأ المزوّد يعيد فشلًا برسالة لا يرمي استثناء", async () => {
    const { impl } = mockFetch({ error: { message: "invalid api key" } }, 401);
    const result: AiChatResult = await aiChat(
      { messages: [{ role: "user", content: "مرحبا" }], fetchImpl: impl },
      config(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid api key");
  });

  it("ناتج فارغ يُعامَل كفشل لا كاقتراح فارغ يُعتمد", async () => {
    const { impl } = mockFetch({ choices: [{ message: { content: "  " } }] });
    const result = await aiChat(
      { messages: [{ role: "user", content: "مرحبا" }], fetchImpl: impl },
      config(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("فارغ");
  });
});
