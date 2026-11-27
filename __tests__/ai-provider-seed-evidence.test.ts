import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedGeminiProviderIfMissing, toAiProviderView } from "../lib/ai-providers/registry";
import type { AiProviderConfig } from "../lib/ai-providers/types";

describe("environment provider seed is not API connection evidence", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "synthetic-only-seed-test-secret-2026-long");
    vi.stubEnv("GEMINI_API_KEY", "synthetic-env-key-not-real");
    vi.stubEnv("GOOGLE_API_KEY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("seeds without success claims or rewriting the existing default", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    await seedGeminiProviderIfMissing({ query });
    expect(query).toHaveBeenCalledTimes(2);
    const insert = query.mock.calls[1][0];
    expect(insert).toContain("NOT EXISTS (SELECT 1 FROM ai_providers WHERE is_default = TRUE)");
    expect(insert).toMatch(/10,\s*NULL,\s*NULL,\s*NULL,\s*NULL,/);
    expect(insert).not.toContain("الاتصال ناجح");
    const conflict = insert.split("ON CONFLICT (id) DO UPDATE SET")[1];
    expect(conflict).toContain("last_test_ok = NULL");
    expect(conflict).not.toContain("is_default =");
    expect(conflict).not.toContain("enabled =");
    expect(conflict).toContain("WHERE ai_providers.api_key_enc IS NULL");
  });

  it("leaves an existing configured provider untouched", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "google-gemini", api_key_enc: "synthetic-existing" }] }));
    await seedGeminiProviderIfMissing({ query });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does nothing without an environment key", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const query = vi.fn();
    await seedGeminiProviderIfMissing({ query });
    expect(query).not.toHaveBeenCalled();
  });

  const provider: AiProviderConfig = {
    id: "google-gemini", name: "Google Gemini", protocolType: "google-gemini",
    baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash",
    models: [], apiKeyEnc: null, timeoutMs: 20000, maxTokens: 2048,
    temperature: 0.2, enabled: true, isDefault: false, priority: 10,
    lastTestAt: new Date("2026-11-25T00:00:00Z"), lastTestOk: true, lastTestLatency: 180,
  };

  it("does not present a historical fabricated seed result as a verified connection", () => {
    const view = toAiProviderView({ ...provider, lastTestMessage: "الاتصال ناجح ومعتمد — النموذج gemini-2.5-flash" });
    expect(view.lastTestOk).toBeNull();
    expect(view.lastTestAt).toBeNull();
    expect(view.lastTestLatency).toBeNull();
    expect(view.lastTestMessage).toContain("لم يُثبت");
  });

  it("preserves genuine test result format", () => {
    const view = toAiProviderView({ ...provider, lastTestMessage: "الاتصال ناجح بـ Google Gemini — النموذج gemini-2.5-flash (180 م.ث)" });
    expect(view.lastTestOk).toBe(true);
    expect(view.lastTestAt).toBe("2026-11-25T00:00:00.000Z");
    expect(view.lastTestLatency).toBe(180);
  });
});
