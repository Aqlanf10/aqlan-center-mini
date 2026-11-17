import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOfficialJson } from "../scripts/verify-braces-exception.mjs";

const advisory = "https://api.github.com/advisories/GHSA-vfj7-8cjw-p6xm";
const matching = "https://api.github.com/advisories?ecosystem=npm&affects=braces%403.0.3&per_page=100";
const registry = "https://registry.npmjs.org/braces";
const secret = "SYNTHETIC_PRIVATE_TOKEN_::error::DO_NOT_PRINT";
const response = (url, body = "{}", options = {}) => {
  const value = new Response(body, { status: options.status ?? 200, headers: options.headers ?? { "content-type": "application/json" } });
  Object.defineProperty(value, "url", { value: url });
  return value;
};
afterEach(() => vi.restoreAllMocks());

describe("official lookup failures remain closed and safely classified", () => {
  it.each([
    [403, "http_403"], [404, "http_404"], [429, "http_429"], [500, "http_5xx"],
    [599, "http_5xx"], [302, "redirect_status"], [401, "http_other"],
  ])("classifies HTTP %i without exposing the response", async (status, reason) => {
    const fetchImpl = vi.fn(async () => response(advisory, secret, { status }));
    await expect(fetchOfficialJson(advisory, fetchImpl)).rejects.toThrow(`official lookup failed: endpoint=advisory reason=${reason}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("projects only fixed endpoint and reason labels for hostile URLs, errors and bodies", async () => {
    for (const [url, fetchImpl, expected] of [
      [advisory, async () => { throw new Error(secret); }, "endpoint=advisory reason=transport_or_protocol"],
      [matching, async () => response(secret), "endpoint=matching reason=url_mismatch"],
      [registry, async () => response(registry, secret), "endpoint=registry reason=invalid_json"],
      [secret, async () => response(secret, secret, { status: 403 }), "endpoint=other reason=http_403"],
      [advisory, async () => response(advisory, secret, { headers: { "content-type": "text/html", "x-private": secret } }), "endpoint=advisory reason=non_json"],
      [advisory, async () => response(advisory, secret, { headers: { "content-type": "application/json", link: `<${secret}>; rel="next"` } }), "endpoint=advisory reason=pagination"],
    ]) {
      const message = await fetchOfficialJson(url, fetchImpl).then(() => "unexpected-success", error => error.message);
      expect(message).toBe(`BRACES_EXCEPTION_REJECTED: official lookup failed: ${expected}`);
      expect(message).not.toContain(secret);
    }
  });

  it("labels a signalled timeout without projecting the thrown error", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    await expect(fetchOfficialJson(advisory, async () => { throw new Error(secret); }))
      .rejects.toThrow("official lookup failed: endpoint=advisory reason=timeout");
  });

  it("never inspects a hostile thrown value or its accessors", async () => {
    const trap = vi.fn(() => { throw new Error(secret); });
    const hostile = new Proxy({}, { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
    const message = await fetchOfficialJson(advisory, async () => { throw hostile; }).then(() => "unexpected-success", error => error.message);
    expect(message).toBe("BRACES_EXCEPTION_REJECTED: official lookup failed: endpoint=advisory reason=transport_or_protocol");
    expect(trap).not.toHaveBeenCalled();
  });

  it("rejects both advertised and streamed oversized bodies", async () => {
    const advertised = response(advisory, "{}", { headers: { "content-type": "application/json", "content-length": "4194305" } });
    const streamed = response(advisory, " ".repeat(4 * 1024 * 1024 + 1));
    for (const result of [advertised, streamed]) {
      await expect(fetchOfficialJson(advisory, async () => result)).rejects.toThrow("reason=too_large");
    }
  });

  it("returns valid JSON and keeps redirect rejection and unauthenticated requests", async () => {
    const fetchImpl = vi.fn(async () => response(advisory, '{"valid":true}'));
    expect(await fetchOfficialJson(advisory, fetchImpl)).toEqual({ valid: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "error", cache: "no-store" });
    expect(Object.keys(fetchImpl.mock.calls[0][1].headers).some(key => key.toLowerCase() === "authorization")).toBe(false);
  });
});
