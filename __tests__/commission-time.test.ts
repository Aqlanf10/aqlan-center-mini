import { describe, expect, it } from "vitest";
import { commissionTimeKey, commissionTimestampIso } from "../lib/commission-time";

describe("exact commission event timestamps", () => {
  it("keeps before, equal and after within the same millisecond distinct", () => {
    const boundary = commissionTimeKey("2024-03-10T10:00:00.123500Z");
    expect(commissionTimeKey("2024-03-10T10:00:00.123499Z")).toBe(boundary - 1n);
    expect(commissionTimeKey("2024-03-10T10:00:00.123500Z")).toBe(boundary);
    expect(commissionTimeKey("2024-03-10T10:00:00.123501Z")).toBe(boundary + 1n);
  });

  it("normalizes timezone offsets and shorter fractional precision", () => {
    const expected = commissionTimeKey("2024-03-10T10:00:00.123000Z");
    expect(commissionTimeKey("2024-03-10T13:00:00.123+03:00")).toBe(expected);
    expect(commissionTimeKey("2024-03-10T10:00:00.123Z")).toBe(expected);
    expect(commissionTimeKey("2024-03-10T13:00:00.123499+03:00")).toBe(expected + 499n);
    expect(commissionTimeKey("2024-03-10T13:00:00.123499+0300")).toBe(expected + 499n);
    expect(commissionTimeKey("1970-01-01T00:00:00Z")).toBe(0n);
  });

  it("retains valid legacy Date inputs at their original precision", () => {
    for (const value of ["2024-03-10", "2024-03-10 10:00:00Z", "Sun, 10 Mar 2024 10:00:00 GMT"]) {
      expect(commissionTimeKey(value)).toBe(BigInt(Date.parse(value)) * 1000n);
    }
  });

  it("retains exact microseconds before the epoch and beyond safe numeric microseconds", () => {
    expect(commissionTimeKey("1969-12-31T23:59:59.999999Z")).toBe(-1n);
    const future = commissionTimeKey("2999-03-10T10:00:00.123500Z");
    expect(commissionTimeKey("2999-03-10T10:00:00.123499Z")).toBe(future - 1n);
    expect(commissionTimeKey("2999-03-10T10:00:00.123501Z")).toBe(future + 1n);
  });

  it.each(["not-a-time", "", "2024-99-10T10:00:00Z"])("refuses invalid event timestamps: %s", (value) => {
    expect(() => commissionTimeKey(value)).toThrow(RangeError);
  });

  it.each([
    ["2024-03-10T10:00:00.123Z", "123499", "2024-03-10T10:00:00.123499Z"],
    ["1969-12-31T23:59:59.999Z", "999999", "1969-12-31T23:59:59.999999Z"],
    ["0001-01-01T00:00:00.123Z", "123456", "0001-01-01T00:00:00.123456Z"],
    ["2024-03-10T01:00:00.123+03:00", "123456", "2024-03-09T22:00:00.123456Z"],
    ["+010000-01-01T00:00:00.123Z", "123456", "+010000-01-01T00:00:00.123456Z"],
    ["-000001-01-01T00:00:00.123Z", "123456", "-000001-01-01T00:00:00.123456Z"],
  ])("reattaches database fractions while retaining Date calendar semantics: %s", (date, fraction, expected) => {
    expect(commissionTimestampIso(new Date(date), fraction)).toBe(expected);
  });

  it("refuses an invalid native Date", () => {
    expect(() => commissionTimestampIso(new Date("invalid"), "123456")).toThrow(RangeError);
  });

  it.each(["", "123", "1234567", "abcdef"])("refuses invalid SQL microsecond projections: %s", (fraction) => {
    expect(() => commissionTimestampIso(new Date("2024-03-10T10:00:00Z"), fraction)).toThrow(RangeError);
  });
});
