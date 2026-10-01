import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * (TD-06 / TD-REG-018) أعطال قراءة مزودي الذكاء الاصطناعي لا تُبتلع صامتة.
 *
 * كان `listAiProviders().catch(() => [])` يجعل عطل القاعدة «لا مزود مفعّل» — والمالك يرى
 * «فشل جميع المزودين» فيبحث في مفاتيح سليمة. وكانت خطوات البذر والتوافق الرجعي تُبتلع بلا أثر.
 */

const query = vi.hoisted(() => vi.fn());
vi.mock("../lib/db", () => ({
  getPool: () => ({ query }),
  recordAudit: vi.fn(),
}));

const { executeAiChatWithFallback, AI_PROVIDERS_UNREADABLE } = await import("../lib/ai-providers/registry");

afterEach(() => { vi.restoreAllMocks(); query.mockReset(); });

describe("TD-06: provider registry failures are reported, not swallowed", () => {
  it("provider list unreadable ⇒ its own error (not «all providers failed»), and it is logged", async () => {
    query.mockRejectedValue(new Error("connection reset"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const neverCalled = vi.fn() as unknown as typeof fetch;

    const result = await executeAiChatWithFallback({ messages: [{ role: "user", content: "مرحبا" }] }, neverCalled);

    expect(result).toMatchObject({ ok: false, content: "", providerName: "none", error: AI_PROVIDERS_UNREADABLE });
    expect(neverCalled).not.toHaveBeenCalled();
    expect(logged.mock.calls.some((call) => String(call[0]).startsWith("[ai-providers]"))).toBe(true);
    // الرسالة المسجَّلة نص الخطأ وحده — لا كائن قد يحمل اتصالًا أو مفاتيح.
    expect(logged.mock.calls.every((call) => call.slice(1).every((part) => typeof part === "string"))).toBe(true);
  });
});
