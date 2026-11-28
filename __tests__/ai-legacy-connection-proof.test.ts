import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock("../lib/db", () => ({ getPool: () => ({ query: m.query }), recordAudit: m.audit }));
vi.mock("../lib/secretbox", () => ({
  encryptSecret: (value: string) => "synthetic-encrypted:" + value,
  decryptSecret: () => "synthetic-key",
  maskKey: () => "••••",
}));
vi.mock("../lib/safe-outbound-url", () => ({ assertSafeOutboundUrl: async () => ({ ok: true }) }));

import { saveAiSettings, testAiConnection } from "../lib/ai";

const stored = {
  enabled: true, provider: "openai", base_url: "https://api.openai.com/v1",
  model: "synthetic-model", api_key_enc: "synthetic-stored-ciphertext",
  last_test_at: null, last_test_ok: null, last_test_message: null,
  updated_at: null, updated_by: null,
};
const transport = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.resetAllMocks();
  m.query.mockResolvedValueOnce({ rows: [stored] }).mockResolvedValue({ rowCount: 1, rows: [] });
  transport.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "synthetic-reply" } }] }), { status: 200 }));
});

describe("legacy AI connection evidence — synthetic transport only", () => {
  it("returns temporary-key test success without overwriting the saved-key proof", async () => {
    const result = await testAiConnection({ apiKey: "synthetic-unsaved-key" }, "synthetic-admin", "admin", transport);
    expect(result.ok).toBe(true);
    expect(transport).toHaveBeenCalledOnce();
    expect(m.query).toHaveBeenCalledOnce();
    expect(m.audit.mock.calls[0][0].details.with_new_key).toBe(true);
  });

  it("binds a saved test result to the exact stored configuration", async () => {
    const result = await testAiConnection({}, "synthetic-admin", "admin", transport);
    expect(result.ok).toBe(true);
    expect(transport).toHaveBeenCalledOnce();
    expect(m.query).toHaveBeenCalledTimes(2);
    const [sql, params] = m.query.mock.calls[1];
    expect(sql).toContain("api_key_enc IS NOT DISTINCT FROM $3");
    expect(sql).toContain("enabled = $4 AND provider = $5 AND base_url = $6 AND model = $7");
    expect(params.slice(2)).toEqual([stored.api_key_enc, stored.enabled, stored.provider, stored.base_url, stored.model]);
  });

  it("does not report saved connection success if the configuration changed during the test", async () => {
    m.query.mockReset().mockResolvedValueOnce({ rows: [stored] }).mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const result = await testAiConnection({}, "synthetic-admin", "admin", transport);
    expect(transport).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    expect(m.audit.mock.calls[0][0].details.ok).toBe(false);
  });

  it("invalidates old connection evidence on settings save", async () => {
    await saveAiSettings({ enabled: true, provider: "openai", baseUrl: stored.base_url, model: stored.model }, "synthetic-admin", "admin");
    const [sql] = m.query.mock.calls[0];
    expect(sql).toContain("last_test_at = NULL");
    expect(sql).toContain("last_test_ok = NULL");
    expect(sql).toContain("last_test_message = NULL");
    expect(transport).not.toHaveBeenCalled();
  });
});
