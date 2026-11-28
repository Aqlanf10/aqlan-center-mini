import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ consume: vi.fn() }));
vi.mock("@/lib/db", () => ({ consumeLoginAttempt: m.consume }));
import { consumeSecurityLimit } from "../lib/security-rate-limit";

const spec = { scope: "ai-chat", identifier: "synthetic-user", maximum: 3, windowMinutes: 1, headers: new Headers() };
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SESSION_SECRET", "synthetic-test-secret-not-a-real-key-123456");
  vi.stubEnv("TRUST_PROXY", "false");
});
afterEach(() => vi.unstubAllEnvs());

describe("distributed security counter opt-in failure policy", () => {
  it("rejects strict requests when the counter is unavailable", async () => {
    m.consume.mockRejectedValue(new Error("synthetic DB outage"));
    await expect(consumeSecurityLimit({ ...spec, failClosed: true })).rejects.toThrow("Security limit unavailable");
  });
  it("rejects strict requests without a valid signing secret", async () => {
    vi.stubEnv("SESSION_SECRET", "");
    await expect(consumeSecurityLimit({ ...spec, failClosed: true })).rejects.toThrow("Security limit unavailable");
    expect(m.consume).not.toHaveBeenCalled();
  });
  it("preserves legacy fail-open behavior for other callers", async () => {
    m.consume.mockRejectedValue(new Error("synthetic DB outage"));
    await expect(consumeSecurityLimit(spec)).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
  });
  it("preserves valid counter results and uses a hashed identifier", async () => {
    m.consume.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    await expect(consumeSecurityLimit({ ...spec, failClosed: true })).resolves.toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(m.consume).toHaveBeenCalledWith([{ key: expect.stringMatching(/^[a-f0-9]{64}$/), maximum: 3 }], 1);
  });
});
