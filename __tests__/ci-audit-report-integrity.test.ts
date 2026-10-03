import { describe, expect, it } from "vitest";
import { decideAuditOutcome } from "../lib/ci-audit";

const zeroCounts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
const reportWith = (vulnerabilities: unknown) => ({ metadata: { vulnerabilities } });
const blockingLevels = ["moderate", "high", "critical"] as const;

describe("dependency audit report integrity", () => {
  it.each([
    ["empty object", {}],
    ["empty array", []],
    ["nonempty array", [0, 0, 0]],
    ["string", "0"],
    ["number", 0],
    ["null", null],
  ])("does not certify %s vulnerability counts as clean", (_label, counts) => {
    expect(decideAuditOutcome(reportWith(counts))).toBe("unavailable");
  });

  it.each(["info", "low", ...blockingLevels] as const)("requires an explicit %s count before reporting a clean audit", (level) => {
    const counts: Partial<typeof zeroCounts> = { ...zeroCounts };
    delete counts[level];
    expect(decideAuditOutcome(reportWith(counts))).toBe("unavailable");
  });

  describe.each(blockingLevels)("validates the %s count", (level) => {
    it.each([
      ["negative", -1],
      ["fractional", 0.5],
      ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
      ["NaN", Number.NaN],
      ["infinite", Number.POSITIVE_INFINITY],
      ["null", null],
      ["undefined", undefined],
      ["numeric string", "0"],
      ["nonnumeric string", "invalid"],
      ["boolean", false],
      ["array", []],
      ["object", {}],
    ])("rejects a %s value instead of coercing it", (_label, value) => {
      expect(decideAuditOutcome(reportWith({ ...zeroCounts, [level]: value }))).toBe("unavailable");
    });
  });

  it("cannot cancel a confirmed high count by adding a negative moderate count", () => {
    expect(decideAuditOutcome(reportWith({ ...zeroCounts, moderate: -1, high: 1 }))).toBe("unavailable");
  });

  it.each(["info", "low"] as const)("rejects a malformed nonblocking %s count", (level) => {
    expect(decideAuditOutcome(reportWith({ ...zeroCounts, [level]: -1 }))).toBe("unavailable");
  });

  it("rejects arrays at every structural boundary, even with attached properties", () => {
    const counts = Object.assign([], zeroCounts);
    const metadata = Object.assign([], { vulnerabilities: zeroCounts });
    const report = Object.assign([], { metadata: { vulnerabilities: zeroCounts } });
    expect(decideAuditOutcome(reportWith(counts))).toBe("unavailable");
    expect(decideAuditOutcome({ metadata })).toBe("unavailable");
    expect(decideAuditOutcome(report)).toBe("unavailable");
  });

  it("requires own counters instead of accepting inherited zero values", () => {
    expect(decideAuditOutcome(reportWith(Object.create(zeroCounts)))).toBe("unavailable");
  });

  it.each([{}, { code: "E503" }, "registry failure", null, false, 0, undefined])(
    "never certifies a zero summary accompanied by an explicit error: %j",
    (error) => {
      expect(decideAuditOutcome({ ...reportWith(zeroCounts), error })).toBe("unavailable");
    },
  );

  it("continues to reject known blocking counts even when the report also has an error", () => {
    expect(decideAuditOutcome({
      ...reportWith({ ...zeroCounts, high: 1 }),
      error: { code: "E503" },
    })).toBe("fail");
  });

  it("continues to pass a complete clean report and low-only findings", () => {
    expect(decideAuditOutcome(reportWith(zeroCounts))).toBe("pass");
    expect(decideAuditOutcome(reportWith({ ...zeroCounts, info: 2, low: 3 }))).toBe("pass");
  });

  it.each(blockingLevels)("continues to fail on any %s vulnerability", (level) => {
    expect(decideAuditOutcome(reportWith({ ...zeroCounts, [level]: 1 }))).toBe("fail");
  });
});
