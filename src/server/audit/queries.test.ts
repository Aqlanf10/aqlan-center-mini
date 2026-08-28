import { describe, expect, it } from "vitest";

import { safeMetadataSummary } from "@/server/audit/queries";

describe("safeMetadataSummary", () => {
  it("keeps ordinary safe fields", () => {
    const summary = safeMetadataSummary({
      fileNumber: "P-000123",
      fullName: "أحمد محمد",
      status: "NO_SHOW",
    });
    expect(summary).toContain("fileNumber=P-000123");
    expect(summary).toContain("status=NO_SHOW");
  });

  it("never renders password-ish keys", () => {
    const summary = safeMetadataSummary({
      password: "hunter2",
      newPassword: "abc",
      passwordHash: "x",
      sessionToken: "tok",
      token: "tok",
      secret: "s",
      databaseUrl: "postgres://…",
      credentials: "c",
    });
    expect(summary).toBe("");
  });

  it("skips password-like keys even in nested naming", () => {
    const summary = safeMetadataSummary({
      CurrentPassword: "x", // blocked via lowercase includes check
      note: "ok",
    });
    expect(summary).toContain("note=ok");
    expect(summary).not.toContain("CurrentPassword");
  });

  it("bounds the summary length", () => {
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 30; i += 1) big[`key${i}`] = "value".repeat(10);
    expect(safeMetadataSummary(big).length).toBeLessThanOrEqual(300);
  });

  it("serializes non-primitives safely", () => {
    const summary = safeMetadataSummary({ meta: { a: 1 }, count: 2 });
    expect(summary).toContain("meta={\"a\":1}");
    expect(summary).toContain("count=2");
  });

  it("handles null/undefined metadata", () => {
    expect(safeMetadataSummary(null)).toBe("");
    expect(safeMetadataSummary(undefined)).toBe("");
    expect(safeMetadataSummary({ skip: null })).toBe("");
  });
});
