import { beforeAll, describe, expect, it } from "vitest";
import { getProviderAdapter } from "../lib/ai-providers/adapters";
import type { AiProviderConfig } from "../lib/ai-providers/types";
import { encryptSecret } from "../lib/secretbox";

beforeAll(() => {
  process.env.SESSION_SECRET = "synthetic-only-session-secret-for-responses-test-2026";
});

function config(): AiProviderConfig {
  return {
    id: "synthetic-openai", name: "OpenAI", protocolType: "openai-responses",
    baseUrl: "https://api.openai.com/v1", model: "synthetic-model", models: [],
    apiKeyEnc: encryptSecret("synthetic-test-key-not-real"),
    timeoutMs: 20000, maxTokens: 256, temperature: 0.2,
    enabled: true, isDefault: true, priority: 1,
  };
}

const completed = { status: "completed", model: "synthetic-returned-model", output: [
  { type: "reasoning", summary: [] },
  { type: "message", role: "assistant", status: "completed", content: [
    { type: "output_text", text: "READY" },
    { type: "output_text", text: "TEST" },
  ] },
] };

function mock(payload: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("OpenAI Responses transport (synthetic, no network)", () => {
  it("uses native responses with store disabled, redaction and nested output", async () => {
    const { calls, fetchImpl } = mock(completed);
    const result = await getProviderAdapter("openai-responses").chat({
      messages: [{ role: "system", content: "trusted instructions" }, { role: "user", content: "synthetic 1234567890" }],
      maxTokens: 128, fetchImpl,
    }, config());
    expect(result).toMatchObject({ ok: true, content: "READY\nTEST", model: "synthetic-returned-model" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0].init.redirect).toBe("error");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ store: false, stream: false, max_output_tokens: 128 });
    expect(body).not.toHaveProperty("messages");
    expect(body).not.toHaveProperty("temperature");
    expect(body.input[0].role).toBe("developer");
    expect(JSON.stringify(body.input)).not.toContain("1234567890");
  });
  it.each([
    { ...completed, status: "incomplete" },
    { ...completed, status: "failed" },
    { status: "completed", output: [] },
    { status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "no" }] }] },
    { choices: [{ message: { content: "not a Responses result" } }] },
  ])("does not report success for an invalid or incomplete payload", async (payload) => {
    const { fetchImpl } = mock(payload);
    const result = await getProviderAdapter("openai-responses").testConnection(config(), fetchImpl);
    expect(result.ok).toBe(false);
  });
  it("does not report success for an HTTP rejection", async () => {
    const { fetchImpl } = mock({ error: { message: "invalid key" } }, 401);
    expect((await getProviderAdapter("openai-responses").testConnection(config(), fetchImpl)).ok).toBe(false);
  });
  it("does not call the network without a configured key", async () => {
    const { calls, fetchImpl } = mock(completed);
    expect((await getProviderAdapter("openai-responses").testConnection({ ...config(), apiKeyEnc: null }, fetchImpl)).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("accepts the exact synthetic readiness marker on the official endpoint", async () => {
    const { fetchImpl } = mock({ ...completed, output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "READY" }] }] });
    const result = await getProviderAdapter("openai-responses").testConnection(config(), fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("OpenAI");
  });
  it.each([undefined, "", "   ", 42])("rejects readiness without a valid returned model (%s)", async (model) => {
    const { fetchImpl } = mock({ ...completed, model, output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "READY" }] }] });
    const result = await getProviderAdapter("openai-responses").testConnection(config(), fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("الاتصال ناجح");
  });
  it.each([
    { output: [{ type: "message", role: "assistant", status: "completed", content: [
      { type: "output_text", text: "READY" }, { type: "refusal", refusal: "synthetic refusal" },
    ] }] },
    { output: [
      { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "READY" }] },
      { type: "message", role: "assistant", status: "incomplete", content: [{ type: "output_text", text: "partial" }] },
    ] },
  ])("rejects contradictory readiness even with completed top-level status", async ({ output }) => {
    const { fetchImpl } = mock({ ...completed, output });
    const adapter = getProviderAdapter("openai-responses");
    expect((await adapter.testConnection(config(), fetchImpl)).ok).toBe(false);
    expect((await adapter.chat({ messages: [{ role: "user", content: "synthetic" }], fetchImpl }, config())).ok).toBe(false);
  });
  it("does not report readiness for an unrelated completed message", async () => {
    const { fetchImpl } = mock(completed);
    expect((await getProviderAdapter("openai-responses").testConnection(config(), fetchImpl)).ok).toBe(false);
  });
  it("does not describe a compatible endpoint as direct OpenAI", async () => {
    const { fetchImpl } = mock({ ...completed, output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "READY" }] }] });
    // api.groq.com is already in the outbound allowlist; transport is mocked.
    const result = await getProviderAdapter("openai-responses").testConnection({ ...config(), baseUrl: "https://api.groq.com/openai/v1" }, fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.message).not.toContain("الاتصال ناجح بـ OpenAI");
  });
  it("retains the independent chat completions protocol", () => {
    expect(getProviderAdapter("openai-compatible").protocol).toBe("openai-compatible");
  });
});
