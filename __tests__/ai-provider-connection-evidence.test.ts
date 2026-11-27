import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveAiProvider, testAiProviderConnection } from "../lib/ai-providers/registry";

const { query, audit, testConnection, encryptSecret } = vi.hoisted(() => ({
  query: vi.fn(), audit: vi.fn(), testConnection: vi.fn(), encryptSecret: vi.fn(),
}));
vi.mock("../lib/db", () => ({ getPool: () => ({ query }), recordAudit: audit }));
vi.mock("../lib/secretbox", () => ({
  encryptSecret, decryptSecret: vi.fn(), maskKey: vi.fn(),
}));
vi.mock("../lib/ai-providers/adapters", () => ({
  getProviderAdapter: () => ({ testConnection }),
}));

const row = {
  id: "synthetic-openai", name: "OpenAI", protocol_type: "openai-responses",
  base_url: "https://api.openai.com/v1", api_endpoint: null,
  model: "synthetic-model", api_key_enc: "synthetic-saved-ciphertext",
  organization_id: null, custom_headers: {}, timeout_ms: 30000, max_tokens: 2048,
  temperature: 0.2, enabled: true, is_default: false, priority: 10, last_test_ok: null,
};
const outcome = { ok: true, message: "synthetic READY", latencyMs: 20 };

describe("provider connection evidence belongs to saved configuration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    query.mockResolvedValue({ rows: [row], rowCount: 1 });
    audit.mockResolvedValue(undefined);
    testConnection.mockResolvedValue(outcome);
    encryptSecret.mockReturnValue("synthetic-temporary-ciphertext");
  });

  it("returns temporary-key result without writing saved connection status", async () => {
    expect(await testAiProviderConnection(row.id, "synthetic-unsaved-key")).toEqual(outcome);
    expect(testConnection.mock.calls[0][0].apiKeyEnc).toBe("synthetic-temporary-ciphertext");
    expect(query).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0].details).toMatchObject({ usesUnsavedKey: true, ok: true });
  });

  it("persists saved-key evidence only under matching transport configuration", async () => {
    expect(await testAiProviderConnection(row.id, "  ")).toEqual(outcome);
    expect(testConnection.mock.calls[0][0].apiKeyEnc).toBe(row.api_key_enc);
    expect(query).toHaveBeenCalledTimes(2);
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain("api_key_enc IS NOT DISTINCT FROM $5");
    expect(sql).toContain("protocol_type = $6 AND base_url = $7 AND model = $8");
    expect(sql).toContain("api_endpoint IS NOT DISTINCT FROM $9");
    expect(sql).toContain("custom_headers::jsonb");
    expect(params).toEqual([true, outcome.message, 20, row.id, row.api_key_enc,
      row.protocol_type, row.base_url, row.model, null, null, "{}", 30000, 2048, 0.2]);
    expect(audit.mock.calls[0][0].details).toMatchObject({ usesUnsavedKey: false });
  });

  it("rejects a stale success when the guarded update affects no row", async () => {
    query.mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await testAiProviderConnection(row.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("أعد الاختبار");
    expect(result.latencyMs).toBe(outcome.latencyMs);
    expect(audit.mock.calls[0][0].details).toMatchObject({ ok: false });
  });

  it("uses effective defaults for legacy rows with nullable transport settings", async () => {
    query.mockResolvedValueOnce({ rows: [{ ...row, timeout_ms: null, max_tokens: null, temperature: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    expect(await testAiProviderConnection(row.id)).toEqual(outcome);
    expect(testConnection.mock.calls[0][0]).toMatchObject({
      timeoutMs: 30000, maxTokens: 2048, temperature: 0.2,
    });
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain("COALESCE(timeout_ms, 30000) = $12");
    expect(sql).toContain("COALESCE(max_tokens, 2048) = $13");
    expect(sql).toContain("COALESCE(temperature, 0.2) = $14");
    expect(params.slice(11)).toEqual([30000, 2048, 0.2]);
  });

  it("invalidates prior connection evidence when saving configuration", async () => {
    await saveAiProvider({
      id: row.id, name: row.name, protocolType: "openai-responses",
      baseUrl: row.base_url, model: row.model,
    }, "synthetic-owner");
    const [sql] = query.mock.calls[0];
    for (const field of ["last_test_at", "last_test_ok", "last_test_message", "last_test_latency"]) {
      expect(sql).toContain(field + " = NULL");
    }
  });
});
