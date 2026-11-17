import { expect, it, vi } from "vitest";
import { classifyCoverageFixtureFailure, withCoverageFixtureDiagnostics } from "./fixtures/coverage-fixture-diagnostic";

const secret = "SYNTHETIC_PRIVATE_ERROR_PAYLOAD_0123456789";
const lineage = "Synthetic coverage lineage was not valid";

it("leaves successful work unchanged without notices or timers", async () => {
  const emit = vi.fn(), value = { synthetic: true }, timer = vi.spyOn(globalThis, "setTimeout");
  try {
    expect(await withCoverageFixtureDiagnostics(async () => value, emit)).toBe(value);
    expect(emit).not.toHaveBeenCalled(); expect(timer).not.toHaveBeenCalled();
  } finally { timer.mockRestore(); }
});

it("classifies the exact fixed lineage message but never prints it", async () => {
  const original = new Error(lineage), output: string[] = [];
  const work = withCoverageFixtureDiagnostics(async () => { throw original; }, line => output.push(line));
  await expect(work).rejects.toBe(original);
  expect(output).toEqual(["::notice::synthetic_coverage_fixture kind=lineage_unavailable error=other"]);
  expect(output[0].includes(lineage)).toBe(false);
});

it("accepts only an exact own data-property message, with no suffix, prefix, or alternate case", () => {
  for (const message of [`${lineage}x`, `x${lineage}`, `${lineage}\n`, lineage.toLowerCase(), secret]) {
    const output = classifyCoverageFixtureFailure(new Error(message));
    expect(output).toBe("::notice::synthetic_coverage_fixture kind=other error=other");
    expect(output.includes(message)).toBe(false);
  }
});

it("allows only literal PostgreSQL error codes without projecting error text", async () => {
  const original = Object.assign(new Error(secret), { code: "42P01" }), output: string[] = [];
  await expect(withCoverageFixtureDiagnostics(async () => { throw original; }, line => output.push(line))).rejects.toBe(original);
  expect(output).toEqual(["::notice::synthetic_coverage_fixture kind=other error=42P01"]);
  expect(output[0].includes(secret)).toBe(false);
});

it("rejects workflow-command injection and unfamiliar codes", () => {
  for (const code of ["42P01\n::error::SYNTHETIC_PRIVATE", secret, 42001, { toString() { throw new Error(secret); } }]) {
    const output = classifyCoverageFixtureFailure(Object.assign(new Error(secret), { code }));
    expect(output).toBe("::notice::synthetic_coverage_fixture kind=other error=other");
    expect(output.includes(secret)).toBe(false); expect(output.split("\n")).toHaveLength(1);
  }
});

it("does not invoke getters on hostile properties", () => {
  const get = vi.fn(() => { throw new Error(secret); });
  const error = Object.defineProperties({}, { code: { get }, message: { get } });
  expect(classifyCoverageFixtureFailure(error)).toBe("::notice::synthetic_coverage_fixture kind=other error=other");
  expect(get).not.toHaveBeenCalled();
});

it("handles hostile proxies without leaking their error text", () => {
  const trap = vi.fn(() => { throw new Error(secret); });
  const error = new Proxy({}, { getOwnPropertyDescriptor: trap });
  const output = classifyCoverageFixtureFailure(error);
  expect(output).toBe("::notice::synthetic_coverage_fixture kind=other error=other");
  expect(output.includes(secret)).toBe(false); expect(trap).not.toHaveBeenCalled();
  const revoked = Proxy.revocable({}, { getOwnPropertyDescriptor: trap });
  revoked.revoke();
  expect(classifyCoverageFixtureFailure(revoked.proxy)).toBe("::notice::synthetic_coverage_fixture kind=other error=other");
  expect(trap).not.toHaveBeenCalled();
});

it("preserves the identical original value even if the emitter throws", async () => {
  const original = Object.assign(new Error(secret), { code: "23505" });
  await expect(withCoverageFixtureDiagnostics(async () => { throw original; }, () => { throw new Error(secret); })).rejects.toBe(original);
});

it("preserves non-object thrown values without printing them", async () => {
  for (const original of [undefined, null, secret, 42]) {
    const output: string[] = [];
    const result = await withCoverageFixtureDiagnostics(async () => { throw original; }, line => output.push(line)).then(() => false, error => error === original);
    expect(result).toBe(true);
    expect(output).toEqual(["::notice::synthetic_coverage_fixture kind=other error=other"]);
  }
});

it("bounds emitted notices while preserving every original failure", async () => {
  vi.resetModules();
  const { withCoverageFixtureDiagnostics: fresh } = await import("./fixtures/coverage-fixture-diagnostic");
  const output: string[] = [];
  for (let i = 0; i < 33; i++) {
    const original = new Error(secret);
    await expect(fresh(async () => { throw original; }, line => output.push(line))).rejects.toBe(original);
  }
  expect(output).toHaveLength(32);
  expect(output.every(line => line === "::notice::synthetic_coverage_fixture kind=other error=other")).toBe(true);
});
