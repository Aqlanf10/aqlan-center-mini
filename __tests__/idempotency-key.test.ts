import { afterEach, describe, expect, it, vi } from "vitest";
import { IDEMPOTENCY_KEY_PATTERN, newIdempotencyKey } from "../lib/idempotency-key";

/** (P1-1) مفتاح الإعادة يطابق ما يقبله الخادم، ويُولَّد حتى على شبكة العيادة بلا HTTPS. */
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("newIdempotencyKey", () => {
  it("يطابق نمط الخادم ولا يتكرر", () => {
    const keys = new Set(Array.from({ length: 200 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(200);
    for (const key of keys) expect(key).toMatch(IDEMPOTENCY_KEY_PATTERN);
  });

  it("سياقٌ غير آمن (بلا randomUUID) ⇒ getRandomValues، والنمط نفسه", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    const key = newIdempotencyKey("pay");
    expect(key).toMatch(/^pay:[0-9a-f]{32}$/);
    expect(key).toMatch(IDEMPOTENCY_KEY_PATTERN);
  });

  it("randomUUID يرمي (سياق غير آمن في بعض المتصفحات) ⇒ الاحتياط", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", {
      randomUUID: () => { throw new Error("insecure context"); },
      getRandomValues: real.getRandomValues.bind(real),
    });
    expect(newIdempotencyKey()).toMatch(/^pay:[0-9a-f]{32}$/);
  });
});
