import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOfficialJson } from "../scripts/verify-braces-exception.mjs";

const url = "https://api.github.com/advisories/GHSA-vfj7-8cjw-p6xm";
const response = (status, headers = {}, body = "{}", actualUrl = url) =>
  Object.defineProperty(new Response(body, { status, headers: { "content-type": "application/json", ...headers } }), "url", { value: actualUrl });

describe("official lookup diagnostics remain fail closed", () => {
  it.each([301, 401, 403, 404, 408, 429, 500])("reports HTTP %i without retrying or reading the error body", async (status) => {
    const result = response(status, {}, "private upstream error");
    const fetchImpl = vi.fn(async () => result);
    await expect(fetchOfficialJson(url, fetchImpl)).rejects.toThrow(`HTTP ${status}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.bodyUsed).toBe(false);
  });
  it("exposes only bounded numeric public rate diagnostics", async () => {
    await expect(fetchOfficialJson(url, async () => response(403, {
      "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1794094128", "retry-after": "60",
    }))).rejects.toThrow("HTTP 403; rate-limit-remaining=0; rate-limit-reset=1794094128; retry-after-seconds=60");
    await expect(fetchOfficialJson(url, async () => response(429, {
      "x-ratelimit-remaining": "private header", "x-ratelimit-reset": "1234567890123", "retry-after": "Sat, 07 Nov 2026 23:00:00 GMT",
    }, "private body"))).rejects.toThrow("HTTP 429; rate-limit-remaining=unavailable; rate-limit-reset=unavailable; retry-after-seconds=unavailable");
  });
  it("distinguishes URL mismatch without disclosing the returned URL", async () => {
    const fetchImpl = vi.fn(async () => response(200, {}, "{}", "https://example.test/private-token"));
    await expect(fetchOfficialJson(url, fetchImpl)).rejects.toThrow(`official lookup failed: ${url}; response URL mismatch; HTTP 200`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([
    [new DOMException("private timeout message", "TimeoutError"), "timeout; code=unclassified"],
    [new DOMException("private abort message", "AbortError"), "aborted; code=unclassified"],
    [new TypeError("private transport message", { cause: { code: "ECONNRESET" } }), "transport failure; code=ECONNRESET"],
    [new Error("private redirect message", { cause: { code: "private code" } }), "transport failure; code=unclassified"],
  ])("reports safe transport classifications without retry", async (error, diagnostic) => {
    const fetchImpl = vi.fn(async () => { throw error; });
    await expect(fetchOfficialJson(url, fetchImpl)).rejects.toThrow(`official lookup failed: ${url}; ${diagnostic}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("still requires fresh exact-URL JSON and forbids redirects", async () => {
    const fetchImpl = vi.fn(async () => response(200, {}, '{"withdrawn_at":"2026-10-23T12:53:02Z"}'));
    expect(await fetchOfficialJson(url, fetchImpl)).toEqual({ withdrawn_at: "2026-10-23T12:53:02Z" });
    expect(fetchImpl).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: "error", cache: "no-store", signal: expect.any(AbortSignal) }));
  });
  it.each([
    [{ "content-type": "text/html" }, "<html/>", "non-JSON"],
    [{ link: '<https://example.test>; rel="next"' }, "[]", "pagination unexpected"],
    [{ "content-length": "4194305" }, "{}", "too large"],
    [{}, "not json", /JSON|Unexpected token/],
  ])("rejects malformed or incomplete content without retry", async (headers, body, message) => {
    const fetchImpl = vi.fn(async () => response(200, headers, body));
    await expect(fetchOfficialJson(url, fetchImpl)).rejects.toThrow(message);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});


describe("bounded explicit gateway retries", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const startTimers = () => { vi.useFakeTimers(); vi.spyOn(console, "warn").mockImplementation(() => {}); };
  it.each([502, 503, 504])("recovers from HTTP %i with fresh exact-URL requests", async (status) => {
    startTimers();
    const first = response(status, {}, "private gateway body");
    const fetchImpl = vi.fn().mockResolvedValueOnce(first).mockImplementation(async () => response(200));
    const pending = fetchOfficialJson(url, fetchImpl);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [target, options] of fetchImpl.mock.calls) {
      expect(target).toBe(url);
      expect(options).toMatchObject({ redirect: "error", cache: "no-store", headers: { "Cache-Control": "no-cache" } });
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
    expect(fetchImpl.mock.calls[0][1].signal).not.toBe(fetchImpl.mock.calls[1][1].signal);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("private"));
  });
  it("exhausts exactly three attempts with 1s and 2s waits and no body disclosure", async () => {
    startTimers();
    const fetchImpl = vi.fn(async () => response(504, {}, "private body"));
    const pending = expect(fetchOfficialJson(url, fetchImpl)).rejects.toThrow(`official lookup failed: ${url}; HTTP 504; rate-limit-remaining=unavailable; rate-limit-reset=unavailable; retry-after-seconds=unavailable`);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    await vi.advanceTimersByTimeAsync(100000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it.each(["0", "3", "5"])("honors supported Retry-After=%s without retrying early", async (header) => {
    startTimers();
    const fetchImpl = vi.fn().mockImplementationOnce(async () => response(503, { "retry-after": header })).mockImplementation(async () => response(200));
    const pending = fetchOfficialJson(url, fetchImpl);
    const delay = Math.max(1000, Number(header) * 1000);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it.each(["6", "999999999999999", "-1", "0.5", "", "private invalid header", "Sat, 07 Nov 2026 23:00:00 GMT"])("fails closed on unsupported Retry-After=%s", async (header) => {
    startTimers();
    const fetchImpl = vi.fn(async () => response(503, { "retry-after": header }));
    await expect(fetchOfficialJson(url, fetchImpl)).rejects.toThrow("Retry-After timing unsupported or exceeds 5s budget");
    await vi.advanceTimersByTimeAsync(100000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("bounds cumulative retry waits to 10s", async () => {
    startTimers();
    const fetchImpl = vi.fn(async () => response(503, { "retry-after": "5" }));
    const pending = expect(fetchOfficialJson(url, fetchImpl)).rejects.toThrow("HTTP 503");
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("does not retry a gateway response from a mismatched URL", async () => {
    startTimers();
    const fetchImpl = vi.fn(async () => response(504, {}, "{}", "https://example.test/private"));
    await expect(fetchOfficialJson(url, fetchImpl)).rejects.toThrow("response URL mismatch");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([
    [200, { "content-type": "text/html" }, "<html/>", "non-JSON"],
    [200, {}, "invalid", /JSON|Unexpected token/],
    [200, { link: '<x>; rel="next"' }, "[]", "pagination"],
    [200, { "content-length": "4194305" }, "{}", "too large"],
    [403, {}, "private forbidden", "HTTP 403"],
  ])("does not retry a subsequent content or permanent failure", async (status, headers, body, message) => {
    startTimers();
    const fetchImpl = vi.fn().mockImplementationOnce(async () => response(502)).mockImplementation(async () => response(status, headers, body));
    const pending = expect(fetchOfficialJson(url, fetchImpl)).rejects.toThrow(message);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    await vi.advanceTimersByTimeAsync(100000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
