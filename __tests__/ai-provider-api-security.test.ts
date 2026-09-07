import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SESSION_SECRET = "test-session-secret-0123456789-0123456789-abcdef";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  listProviders: vi.fn(),
  saveProvider: vi.fn(),
  deleteProvider: vi.fn(),
  reorderProviders: vi.fn(),
  testProviderConnection: vi.fn(),
  getProviderById: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  requireSession: mocks.session,
}));

vi.mock("@/lib/ai-providers/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-providers/registry")>();
  return {
    ...actual,
    listAiProviders: mocks.listProviders,
    saveAiProvider: mocks.saveProvider,
    deleteAiProvider: mocks.deleteProvider,
    reorderAiProviders: mocks.reorderProviders,
    testAiProviderConnection: mocks.testProviderConnection,
    getAiProviderById: mocks.getProviderById,
  };
});

import { GET as getProviders, POST as createProvider } from "../app/api/settings/ai/providers/route";
import { PUT as updateProvider, DELETE as removeProvider } from "../app/api/settings/ai/providers/[id]/route";
import { POST as reorderProviders } from "../app/api/settings/ai/providers/reorder/route";
import { POST as testProvider } from "../app/api/settings/ai/providers/[id]/test/route";

beforeEach(() => {
  vi.resetAllMocks();
  // الوضع الافتراضي: جلسة مستخدم غير مدير (استقبال/طبيب)
  mocks.session.mockResolvedValue({
    userId: 10,
    username: "doctor_user",
    role: "doctor",
  });
});

describe("حماية أمن المسارات (RBAC & Route Security)", () => {
  it("يرفض قراءة المزودات لغير المدير (Non-Admin Blocked)", async () => {
    const res = await getProviders();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message).toContain("للمدير وحده");
    expect(mocks.listProviders).not.toHaveBeenCalled();
  });

  it("يرفض إضافة مزود لغير المدير", async () => {
    const req = new Request("http://localhost/api/settings/ai/providers", {
      method: "POST",
      body: JSON.stringify({ name: "Hacker AI" }),
    });
    const res = await createProvider(req);
    expect(res.status).toBe(403);
    expect(mocks.saveProvider).not.toHaveBeenCalled();
  });

  it("يرفض تعديل مزود لغير المدير", async () => {
    const req = new Request("http://localhost/api/settings/ai/providers/openai", {
      method: "PUT",
      body: JSON.stringify({ name: "Updated AI" }),
    });
    const res = await updateProvider(req, { params: Promise.resolve({ id: "openai" }) });
    expect(res.status).toBe(403);
    expect(mocks.saveProvider).not.toHaveBeenCalled();
  });

  it("يرفض حذف مزود لغير المدير", async () => {
    const req = new Request("http://localhost/api/settings/ai/providers/openai", {
      method: "DELETE",
    });
    const res = await removeProvider(req, { params: Promise.resolve({ id: "openai" }) });
    expect(res.status).toBe(403);
    expect(mocks.deleteProvider).not.toHaveBeenCalled();
  });

  it("يرفض إعادة ترتيب الأولويات لغير المدير", async () => {
    const req = new Request("http://localhost/api/settings/ai/providers/reorder", {
      method: "POST",
      body: JSON.stringify({ orderedIds: ["openai", "glm"] }),
    });
    const res = await reorderProviders(req);
    expect(res.status).toBe(403);
    expect(mocks.reorderProviders).not.toHaveBeenCalled();
  });

  it("يرفض اختبار اتصال المزود لغير المدير", async () => {
    const req = new Request("http://localhost/api/settings/ai/providers/openai/test", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await testProvider(req, { params: Promise.resolve({ id: "openai" }) });
    expect(res.status).toBe(403);
    expect(mocks.testProviderConnection).not.toHaveBeenCalled();
  });
});

describe("عمليات المدير المشروعة وعدم تسريب المفاتيح (Admin Operations & Key Protection)", () => {
  beforeEach(() => {
    // جلسة مدير نظام معتمد
    mocks.session.mockResolvedValue({
      userId: 1,
      username: "admin",
      role: "admin",
    });
  });

  it("يسمح للمدير بقراءة المزودات ولا يعيد أي مفتاح صريح أو مشفر", async () => {
    mocks.listProviders.mockResolvedValue([
      {
        id: "prov-1",
        name: "Clinic OpenAI",
        protocolType: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        models: ["gpt-4o-mini"],
        apiKeyEnc: "ciphertext.iv.tag",
        timeoutMs: 15000,
        maxTokens: 1024,
        temperature: 0.2,
        enabled: true,
        isDefault: true,
        priority: 1,
      },
    ]);

    const res = await getProviders();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.providers).toHaveLength(1);

    const p = body.providers[0];
    // تحقق صارم: لا يوجد حقل apiKeyEnc ولا المفتاح الصريح
    expect(p.apiKeyEnc).toBeUndefined();
    expect(p.apiKey).toBeUndefined();
    expect(p.hasKey).toBe(true);
    expect(p.keyMasked).toContain("••••");
  });

  it("يسمح للمدير بإنشاء مزود جديد بنجاح", async () => {
    mocks.saveProvider.mockResolvedValue({
      id: "groq-fast",
      name: "Groq Fast",
      protocolType: "openai-compatible",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b-versatile",
      models: ["llama-3.3-70b-versatile"],
      apiKeyEnc: "ciphertext.tag",
      timeoutMs: 10000,
      maxTokens: 1024,
      temperature: 0.2,
      enabled: true,
      isDefault: false,
      priority: 2,
    });

    const req = new Request("http://localhost/api/settings/ai/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "groq-fast",
        name: "Groq Fast",
        protocolType: "openai-compatible",
        baseUrl: "https://api.groq.com/openai/v1",
        model: "llama-3.3-70b-versatile",
        apiKey: "gsk_test1234567890",
      }),
    });

    const res = await createProvider(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.provider.name).toBe("Groq Fast");
    // المفتاح المشفر محذوف من العرض
    expect(body.provider.apiKeyEnc).toBeUndefined();
    expect(body.provider.hasKey).toBe(true);
  });

  it("يسمح للمدير بحذف مزود بنجاح", async () => {
    mocks.deleteProvider.mockResolvedValue({ ok: true });

    const req = new Request("http://localhost/api/settings/ai/providers/old-provider", {
      method: "DELETE",
    });

    const res = await removeProvider(req, { params: Promise.resolve({ id: "old-provider" }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mocks.deleteProvider).toHaveBeenCalledWith("old-provider", "admin", "admin");
  });

  it("يسمح للمدير بإعادة ترتيب أولويات المزودات بنجاح", async () => {
    mocks.reorderProviders.mockResolvedValue(undefined);

    const req = new Request("http://localhost/api/settings/ai/providers/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedIds: ["openai", "zai"] }),
    });

    const res = await reorderProviders(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mocks.reorderProviders).toHaveBeenCalledWith(["openai", "zai"], "admin");
  });

  it("يسمح للمدير بإجراء اختبار اتصال للمزود", async () => {
    mocks.testProviderConnection.mockResolvedValue({
      ok: true,
      message: "الاتصال ناجح — النموذج glm-4.6 (180 م.ث)",
      latencyMs: 180,
    });

    const req = new Request("http://localhost/api/settings/ai/providers/zai/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-optional-temp-key" }),
    });

    const res = await testProvider(req, { params: Promise.resolve({ id: "zai" }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.latencyMs).toBe(180);
    expect(body.message).toContain("الاتصال ناجح");
  });
});
