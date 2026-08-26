import { describe, expect, it } from "vitest";

import { formatFileNumber } from "@/server/patients/file-number";

describe("formatFileNumber", () => {
  it("formats small numbers with six digits", () => {
    expect(formatFileNumber(1)).toBe("P-000001");
    expect(formatFileNumber(2)).toBe("P-000002");
    expect(formatFileNumber(999999)).toBe("P-999999");
  });

  it("does not truncate larger numbers", () => {
    expect(formatFileNumber(1000000)).toBe("P-1000000");
    expect(formatFileNumber(12345678)).toBe("P-12345678");
  });

  it("accepts numeric strings from PostgreSQL bigint", () => {
    expect(formatFileNumber("42")).toBe("P-000042");
    expect(formatFileNumber("1000000")).toBe("P-1000000");
  });

  it("throws on invalid sequence values (fail loud, never reuse)", () => {
    expect(() => formatFileNumber(-1)).toThrow();
    expect(() => formatFileNumber("not-a-number")).toThrow();
    expect(() => formatFileNumber(Number.NaN)).toThrow();
  });
});
