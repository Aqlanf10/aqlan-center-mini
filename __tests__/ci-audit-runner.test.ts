import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fullAudit from "./fixtures/dependency-security/full-audit.json";
import productionAudit from "./fixtures/dependency-security/production-audit.json";

// Evaluate the real CLI and strict graph policy. Replace npm subprocesses,
// artifact writes and the independent verifier I/O boundary; graph/mutation suites
// exercise that verifier separately. No network or database is opened here.
const boundary = vi.hoisted(() => ({ spawnSync: vi.fn(), verify: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn() }));
vi.mock("../scripts/verify-braces-exception.mjs", () => ({ verifyBracesException: boundary.verify }));
vi.mock("node:fs/promises", () => ({ mkdir: boundary.mkdir, writeFile: boundary.writeFile }));
vi.mock("node:child_process", () => ({ spawnSync: boundary.spawnSync }));

const cleanCounts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
const reportWith = (vulnerabilities: unknown) => ({ metadata: { vulnerabilities } });
const cleanReport = reportWith(cleanCounts);
const registryError = { error: { code: "E503", summary: "Service Unavailable" } };

function auditResult(report: unknown, status: number | null = 0) {
  return { status, signal: null, stdout: JSON.stringify(report), stderr: "" };
}

class CliExit extends Error {
  constructor(readonly code: number) { super(`mocked audit CLI exit ${code}`); }
}

beforeEach(() => {
  vi.resetModules();
  boundary.spawnSync.mockReset();
  boundary.verify.mockReset().mockResolvedValue({ advisory: "GHSA-vfj7-8cjw-p6xm", cve: "CVE-2026-93687", package: "braces", version: "3.0.3", counts: fullAudit.metadata.vulnerabilities });
  boundary.mkdir.mockResolvedValue(undefined);
  boundary.writeFile.mockResolvedValue(undefined);
  boundary.spawnSync.mockImplementation(() => {
    throw new Error("Unexpected audit attempt: provide an explicit synthetic result");
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new CliExit(Number(code ?? 0));
  });
  // Keep the real retry control flow without spending 30 seconds per case.
  // Unrelated timers retain their original behavior.
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((
    (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      realSetTimeout(callback, delay === 15_000 ? 0 : delay, ...args)
  ) as typeof setTimeout);
});

afterEach(() => { vi.restoreAllMocks(); });

async function invokeAudit(): Promise<number> {
  try {
    // A variable import follows the repository's direct-CLI test convention
    // and needs no declaration or production refactor of this executable .mjs.
    const entry = "ci-audit.mjs";
    await import(/* @vite-ignore */ `../scripts/${entry}`);
  } catch (error) {
    if (error instanceof CliExit) return error.code;
    throw error;
  }
  throw new Error("The audit CLI finished without setting an exit status");
}

function expectAuditAttempts(count: number) {
  expect(boundary.spawnSync).toHaveBeenCalledTimes(count);
  for (const [command, args] of boundary.spawnSync.mock.calls) {
    expect(command).toBe("npm");
    expect(args).toEqual(expect.arrayContaining(["audit", "--json", "--audit-level=moderate"]));
    // Preserve the all-dependency scope. Do not hide development advisories or
    // raise the severity threshold to make an unrelated vulnerability pass.
    expect(args.join(" ")).not.toMatch(/--omit(?:=|\s)|--production|--only(?:=|\s)/);
  }
  const retryWaits = vi.mocked(setTimeout).mock.calls.filter(([, delay]) => delay === 15_000);
  expect(retryWaits).toHaveLength(count - 1);
}

describe("dependency audit CLI fail-closed boundary", () => {
  it("requires both complete audits and independent verification before success", async () => {
    boundary.spawnSync.mockReturnValueOnce(auditResult(fullAudit, 1)).mockReturnValueOnce(auditResult(productionAudit));
    expect(await invokeAudit()).toBe(0);
    expect(boundary.spawnSync).toHaveBeenCalledTimes(2);
    expect(boundary.spawnSync.mock.calls[0][1]).not.toContain("--omit=dev");
    expect(boundary.spawnSync.mock.calls[1][1]).toContain("--omit=dev");
    expect(boundary.verify).toHaveBeenCalledTimes(1);
    expect(boundary.writeFile.mock.calls.filter(([file]) => /attempt-\d+\.json$/.test(String(file))).map(([, bytes]) => bytes)).toEqual([JSON.stringify(fullAudit), JSON.stringify(productionAudit)]);
    expect(vi.mocked(console.log).mock.calls.flat()).toContain(JSON.stringify(fullAudit));
  });

  // The approved scoped contract deliberately supersedes legacy metadata-only
  // and low-only CLI success. Pure lib/ci-audit.ts retains its normal threshold.
  it("rejects low-only/incomplete findings while the scoped exception is installed", async () => {
    boundary.spawnSync.mockReturnValue(auditResult(reportWith({ ...cleanCounts, info: 1, low: 2 })));
    expect(await invokeAudit()).toBe(1);
    expectAuditAttempts(3);
    expect(boundary.verify).not.toHaveBeenCalled();
  });

  it.each(["moderate", "high", "critical"])("fails immediately for a confirmed %s finding", async (level) => {
    boundary.spawnSync.mockReturnValue(auditResult(reportWith({ ...cleanCounts, [level]: 1 }), 1));
    expect(await invokeAudit()).toBe(1);
    expectAuditAttempts(1);
  });

  it.each([
    ["registry outage", auditResult(registryError, 1)],
    ["empty output", { status: 0, signal: null, stdout: "", stderr: "" }],
    ["malformed JSON", { status: 0, signal: null, stdout: "not JSON", stderr: "" }],
    ["array report", auditResult([])],
    ["empty counts", auditResult(reportWith({}))],
    ["array counts", auditResult(reportWith([]))],
    ["negative counts", auditResult(reportWith({ ...cleanCounts, moderate: -1 }))],
    ["missing count", auditResult(reportWith({ moderate: 0, high: 0 }))],
    ["failed invocation", { status: null, signal: null, stdout: "", stderr: "npm was not found" }],
    ["zero counts with exit 1", auditResult(cleanReport, 1)],
    ["zero counts with exit 2", auditResult(cleanReport, 2)],
    ["zero counts without an exit status", auditResult(cleanReport, null)],
    ["zero counts with a termination signal", { ...auditResult(cleanReport), signal: "SIGTERM" }],
    ["zero counts with a spawn error", { ...auditResult(cleanReport), error: new Error("spawn npm ENOENT") }],
    ["zero counts with an explicit report error", auditResult({ ...cleanReport, error: { code: "E503" } })],
  ])("returns a nonzero status after three unavailable attempts: %s", async (_label, result) => {
    boundary.spawnSync.mockReturnValue(result);
    const exitCode = await invokeAudit();
    expectAuditAttempts(3);
    expect(exitCode).not.toBe(0);
    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).not.toContain("بوابة التدقيق خضراء");
  });

  it.each([
    ["exit zero", auditResult(reportWith({ ...cleanCounts, high: 1 }))],
    ["terminated process", { ...auditResult(reportWith({ ...cleanCounts, high: 1 }), null), signal: "SIGTERM" }],
    ["process error", { ...auditResult(reportWith({ ...cleanCounts, high: 1 }), 2), error: new Error("synthetic process error") }],
  ])("still fails immediately for known blocking counts with %s", async (_label, result) => {
    boundary.spawnSync.mockReturnValue(result);
    expect(await invokeAudit()).toBe(1);
    expectAuditAttempts(1);
  });

  it("can recover from two unavailable attempts once complete scoped and production evidence arrives", async () => {
    boundary.spawnSync
      .mockReturnValueOnce(auditResult(registryError, 1))
      .mockReturnValueOnce(auditResult(registryError, 1))
      .mockReturnValueOnce(auditResult(fullAudit, 1))
      .mockReturnValueOnce(auditResult(productionAudit));
    expect(await invokeAudit()).toBe(0);
    expect(boundary.spawnSync).toHaveBeenCalledTimes(4);
    expect(vi.mocked(setTimeout).mock.calls.filter(([, delay]) => delay === 15_000)).toHaveLength(2);
    expect(boundary.verify).toHaveBeenCalledTimes(1);
  });

  it("fails when a retry finds a moderate vulnerability instead of treating recovery as success", async () => {
    boundary.spawnSync
      .mockReturnValueOnce(auditResult(registryError, 1))
      .mockReturnValueOnce(auditResult(reportWith({ ...cleanCounts, moderate: 1 }), 1));
    expect(await invokeAudit()).toBe(1);
    expectAuditAttempts(2);
  });
  it("blocks an additional low advisory without calling the verifier", async () => {
    const report = structuredClone(fullAudit);
    const extra = structuredClone(report.vulnerabilities.braces);
    extra.name = "other"; extra.severity = "low";
    report.vulnerabilities = { ...report.vulnerabilities, other: extra } as typeof report.vulnerabilities;
    report.metadata.vulnerabilities.low = 1;
    report.metadata.vulnerabilities.total += 1;
    boundary.spawnSync.mockReturnValue(auditResult(report, 1));
    expect(await invokeAudit()).toBe(1);
    expectAuditAttempts(1);
    expect(boundary.verify).not.toHaveBeenCalled();
  });

  it("fails on independent verifier failure rather than a count-based fallback", async () => {
    boundary.spawnSync.mockReturnValueOnce(auditResult(fullAudit, 1)).mockReturnValueOnce(auditResult(productionAudit));
    boundary.verify.mockRejectedValue(new Error("patched source mismatch"));
    expect(await invokeAudit()).toBe(1);
  });

  it.each([1, 2, null])("rejects a production zero report with process status %s", async (status) => {
    boundary.spawnSync.mockReturnValueOnce(auditResult(fullAudit, 1)).mockReturnValue(auditResult(productionAudit, status));
    expect(await invokeAudit()).toBe(1);
    expect(boundary.spawnSync).toHaveBeenCalledTimes(4);
    expect(boundary.verify).not.toHaveBeenCalled();
  });

  it("blocks production moderate findings even after an eligible full graph", async () => {
    const report = structuredClone(fullAudit);
    boundary.spawnSync.mockReturnValueOnce(auditResult(fullAudit, 1)).mockReturnValueOnce(auditResult(report, 1));
    expect(await invokeAudit()).toBe(1);
    expect(boundary.verify).not.toHaveBeenCalled();
  });

});
