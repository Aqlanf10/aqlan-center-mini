import { describe, expect, it } from "vitest";
import {
  assertSafeOutboundUrl,
  isPrivateOrSpecialIp,
  sanitizeCustomHeaders,
  validateOutboundUrl,
  BUILTIN_PROVIDER_HOSTS,
} from "../lib/safe-outbound-url";
import { OpenAiCompatibleAdapter } from "../lib/ai-providers/adapters";
import type { AiProviderConfig } from "../lib/ai-providers/types";
import { encryptSecret } from "../lib/secretbox";

/**
 * اختبارات SSRF الإلزامية (P2/S7) — القائمة كاملة من المواصفة.
 * فحص DNS بحاقن resolveDns (بلا شبكة حقيقية)، والفحص البنيوي مباشر.
 */

const publicPolicy = { isProduction: false };
const productionPolicy = { isProduction: true };

/** حاقن DNS يظل ثابتًا عبر الاختبارات: عنوان عام واحد. */
const resolvePublic = async () => ["93.184.216.34"];
/** حاقن DNS يحل إلى عنوان خاص — سيناريو rebinding الحقيقي. */
const resolvePrivate = async () => ["10.1.2.3"];
/** حاقن DNS يعيد سجلات مختلطة عام+خاص. */
const resolveMixed = async () => ["93.184.216.34", "192.168.1.7"];

describe("بوابة SSRF — المدى الخاص والمحجوب", () => {
  it("127.0.0.1 → DENY", () => {
    expect(validateOutboundUrl("https://127.0.0.1/v1", publicPolicy).ok).toBe(false);
  });
  it("localhost → DENY (بالاسم لا بالعنوان)", () => {
    expect(validateOutboundUrl("https://localhost/v1", publicPolicy).ok).toBe(false);
    expect(validateOutboundUrl("http://localhost:11434/v1", publicPolicy).ok).toBe(false);
  });
  it("10.x → DENY", () => {
    expect(validateOutboundUrl("https://10.0.0.5/v1", publicPolicy).ok).toBe(false);
    expect(validateOutboundUrl("https://10.255.1.1/v1", publicPolicy).ok).toBe(false);
  });
  it("172.16-31 → DENY", () => {
    expect(validateOutboundUrl("https://172.16.0.1/v1", publicPolicy).ok).toBe(false);
    expect(validateOutboundUrl("https://172.31.255.255/v1", publicPolicy).ok).toBe(false);
    // 172.32 ليس ضمن /12: عام ومسموح شكليًا في بيئة الاختبار
    expect(validateOutboundUrl("https://172.32.0.1/v1", publicPolicy).ok).toBe(true);
  });
  it("192.168 → DENY", () => {
    expect(validateOutboundUrl("https://192.168.1.1/v1", publicPolicy).ok).toBe(false);
  });
  it("169.254.169.254 (cloud metadata) → DENY", () => {
    expect(validateOutboundUrl("https://169.254.169.254/latest/meta-data", publicPolicy).ok).toBe(false);
    expect(validateOutboundUrl("https://metadata.google.internal/v1", publicPolicy).ok).toBe(false);
  });
  it("::1 وIPv6 الخاص → DENY", () => {
    expect(validateOutboundUrl("https://[::1]/v1", publicPolicy).ok).toBe(false);
    expect(validateOutboundUrl("https://[fe80::1]/v1", publicPolicy).ok).toBe(false);
    expect(validateOutboundUrl("https://[fd12:3456:789a::1]/v1", publicPolicy).ok).toBe(false);
  });
  it("IPv4-mapped IPv6 خاص → DENY", () => {
    expect(validateOutboundUrl("https://[::ffff:10.0.0.1]/v1", publicPolicy).ok).toBe(false);
    expect(validateOutboundUrl("https://[::ffff:192.168.0.1]/v1", publicPolicy).ok).toBe(false);
  });
  it("unspecified وmulticast → DENY", () => {
    expect(validateOutboundUrl("https://0.0.0.0/v1", publicPolicy).ok).toBe(false);
    expect(validateOutboundUrl("https://[::]/v1", publicPolicy).ok).toBe(false);
    expect(validateOutboundUrl("https://224.0.0.1/v1", publicPolicy).ok).toBe(false);
  });
  it("0.0.0.0/8 وCGNAT 100.64 → DENY", () => {
    expect(validateOutboundUrl("https://100.64.0.1/v1", publicPolicy).ok).toBe(false);
  });

  it("البروتوكولات غير HTTP(S) → DENY: file/ftp/gopher/data/javascript/dict", () => {
    for (const scheme of ["file", "ftp", "gopher", "data", "javascript", "dict", "ws", "wss"]) {
      const result = validateOutboundUrl(`${scheme}://example.com/x`, publicPolicy);
      expect(result.ok).toBe(false);
    }
  });

  it("userinfo في العنوان → DENY", () => {
    expect(validateOutboundUrl("https://user:pass@api.openai.com/v1", publicPolicy).ok).toBe(false);
    expect(validateOutboundUrl("https://user@api.openai.com/v1", publicPolicy).ok).toBe(false);
  });

  it("مضيف مشوّه الشكل → DENY", () => {
    expect(validateOutboundUrl("https:///path-only", publicPolicy).ok).toBe(false);
    expect(validateOutboundUrl("not a url", publicPolicy).ok).toBe(false);
    expect(validateOutboundUrl("", publicPolicy).ok).toBe(false);
  });

  it("منافذ غير منطقية/خطيرة → DENY", () => {
    expect(validateOutboundUrl("https://api.openai.com:0/v1", publicPolicy).ok).toBe(false);
    expect(validateOutboundUrl("https://api.openai.com:99999/v1", publicPolicy).ok).toBe(false);
    expect(validateOutboundUrl("https://api.openai.com:22/v1", publicPolicy).ok).toBe(false);
  });

  it("fragment في العنوان → DENY", () => {
    expect(validateOutboundUrl("https://api.openai.com/v1#frag", publicPolicy).ok).toBe(false);
  });

  it("query يشير إلى تحويل → DENY", () => {
    expect(validateOutboundUrl("https://api.openai.com/v1?redirect=https://evil.test", publicPolicy).ok).toBe(false);
  });
});

describe("بوابة SSRF — سياسة الإنتاج", () => {
  it("مضيف عام HTTPS ضمن القائمة المدمجة → ALLOW", () => {
    const result = validateOutboundUrl("https://api.openai.com/v1", productionPolicy);
    expect(result.ok).toBe(true);
  });
  it("مضيف عام HTTPS خارج القائمة → DENY في الإنتاج (لا hostname اعتباطي)", () => {
    const result = validateOutboundUrl("https://api.unknown-provider.test/v1", productionPolicy);
    expect(result.ok).toBe(false);
  });
  it("AI_PROVIDER_ALLOWED_HOSTS يفتح مضيفًا صريحًا — لا أكثر", () => {
    const original = process.env.AI_PROVIDER_ALLOWED_HOSTS;
    process.env.AI_PROVIDER_ALLOWED_HOSTS = "api.my-gateway.example";
    try {
      expect(validateOutboundUrl("https://api.my-gateway.example/v1", productionPolicy).ok).toBe(true);
      expect(validateOutboundUrl("https://api.other-gateway.example/v1", productionPolicy).ok).toBe(false);
    } finally {
      if (original === undefined) delete process.env.AI_PROVIDER_ALLOWED_HOSTS;
      else process.env.AI_PROVIDER_ALLOWED_HOSTS = original;
    }
  });
  it("HTTP مرفوض في الإنتاج حتى لمضيف معروف", () => {
    expect(validateOutboundUrl("http://api.openai.com/v1", productionPolicy).ok).toBe(false);
  });
  it("القائمة المدمجة تغطي مزودات presets الحقيقية", () => {
    expect(BUILTIN_PROVIDER_HOSTS.has("api.openai.com")).toBe(true);
    expect(BUILTIN_PROVIDER_HOSTS.has("api.z.ai")).toBe(true);
    expect(BUILTIN_PROVIDER_HOSTS.has("api.deepseek.com")).toBe(true);
    expect(BUILTIN_PROVIDER_HOSTS.has("api.anthropic.com")).toBe(true);
    expect(BUILTIN_PROVIDER_HOSTS.has("generativelanguage.googleapis.com")).toBe(true);
    expect(BUILTIN_PROVIDER_HOSTS.has("api.groq.com")).toBe(true);
  });
});

describe("بوابة SSRF — طبقة DNS (A + AAAA)", () => {
  it("اسم مضيف يحل إلى عنوان خاص → DENY", async () => {
    const result = await assertSafeOutboundUrl("https://rebind.evil.test/v1", {
      ...publicPolicy,
      resolveDns: resolvePrivate,
    });
    expect(result.ok).toBe(false);
  });
  it("سجلات مختلطة عام+خاص → DENY (سجل واحد يكفي للرفض)", async () => {
    const result = await assertSafeOutboundUrl("https://mixed.evil.test/v1", {
      ...publicPolicy,
      resolveDns: resolveMixed,
    });
    expect(result.ok).toBe(false);
  });
  it("اسم مضيف يحل إلى عام → ALLOW", async () => {
    const result = await assertSafeOutboundUrl("https://api.example.test/v1", {
      ...publicPolicy,
      resolveDns: resolvePublic,
    });
    expect(result.ok).toBe(true);
  });
  it("فشل حل الاسم → رفض برسالة واضحة", async () => {
    const result = await assertSafeOutboundUrl("https://unresolvable.test/v1", {
      ...publicPolicy,
      resolveDns: async () => {
        throw new Error("NXDOMAIN");
      },
    });
    expect(result.ok).toBe(false);
  });
  it("عنوان IP حرفي لا يمر بDNS أصلاً — المدى الخاص يرفض مباشرة", () => {
    expect(isPrivateOrSpecialIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrSpecialIp("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateOrSpecialIp("93.184.216.34")).toBe(false);
    expect(isPrivateOrSpecialIp("8.8.8.8")).toBe(false);
  });
});

describe("بوابة SSRF — الترويسات المخصصة", () => {
  it("الترويسات الحساسة محجوبة", () => {
    for (const name of ["Host", "Content-Length", "Connection", "Transfer-Encoding", "Proxy-Authorization", "X-Forwarded-For", "Cookie", "Authorization", "Forwarded"]) {
      const result = sanitizeCustomHeaders({ [name]: "x" });
      expect(result.ok).toBe(false);
    }
  });
  it("ترويسة عادية تمر كما هي", () => {
    const result = sanitizeCustomHeaders({ "X-Test-Header": "AqlanClinic" });
    expect(result.ok).toBe(true);
    expect(result.headers["X-Test-Header"]).toBe("AqlanClinic");
  });
  it("ترويسة بحقن سطر → رفض", () => {
    expect(sanitizeCustomHeaders({ "X-Test": "value\r\nHost: evil" }).ok).toBe(false);
    expect(sanitizeCustomHeaders({ "Bad:Name": "x" }).ok).toBe(false);
  });
});

describe("بوابة SSRF — على مستوى المحول (redirect: error)", () => {
  // secretbox يتطلب سرًا — نضبطه قبل بناء الإعدادات المشفرة.
  process.env.SESSION_SECRET ??= "ssrf-test-secret-0123456789abcdef-0123";

  const config = (over: Partial<AiProviderConfig> = {}): AiProviderConfig => ({
    id: "t1",
    name: "Test Provider",
    protocolType: "openai-compatible",
    baseUrl: "https://api.example.test/v1",
    apiEndpoint: null,
    model: "m1",
    models: ["m1"],
    apiKeyEnc: encryptSecret("sk-test-1234567890"),
    organizationId: null,
    customHeaders: {},
    timeoutMs: 5000,
    maxTokens: 100,
    temperature: 0.2,
    enabled: true,
    isDefault: false,
    priority: 1,
    taskModels: {},
    lastTestAt: null,
    lastTestOk: null,
    lastTestMessage: null,
    lastTestLatency: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    updatedBy: null,
    ...over,
  });

  it("localhost في baseUrl يُرفض حتى مع fetchImpl محقون — والنداء لا يصدر", async () => {
    const calls: string[] = [];
    const adapter = new OpenAiCompatibleAdapter();
    const result = await adapter.chat(
      {
        messages: [{ role: "user", content: "فحص" }],
        fetchImpl: (async (url: string | URL) => {
          calls.push(String(url));
          return new Response("{}", { status: 200 });
        }) as typeof fetch,
      },
      config({ baseUrl: "http://localhost:11434/v1" }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("مرفوض");
    expect(calls).toHaveLength(0);
  });

  it("النداء الصادر يحمل redirect: \"error\" — لا تتبع تحويل المزود", async () => {
    let capturedInit: RequestInit | undefined;
    const adapter = new OpenAiCompatibleAdapter();
    await adapter.chat(
      {
        messages: [{ role: "user", content: "فحص" }],
        fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
          capturedInit = init;
          return new Response(JSON.stringify({ choices: [{ message: { content: "جاهز" } }] }), { status: 200 });
        }) as typeof fetch,
      },
      config(),
    );
    expect(capturedInit?.redirect).toBe("error");
  });

  it("metadata endpoint في baseUrl يُرفض والمحول لا يصل إليه", async () => {
    const calls: string[] = [];
    const adapter = new OpenAiCompatibleAdapter();
    const result = await adapter.chat(
      {
        messages: [{ role: "user", content: "فحص" }],
        fetchImpl: (async (url: string | URL) => {
          calls.push(String(url));
          return new Response("{}", { status: 200 });
        }) as typeof fetch,
      },
      config({ baseUrl: "https://169.254.169.254" }),
    );
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
