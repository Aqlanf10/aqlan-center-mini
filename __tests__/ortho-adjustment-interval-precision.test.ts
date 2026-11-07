import { describe, expect, it } from "vitest";
import { parseAdjustmentInterval } from "../lib/ortho-adjustment-interval";

describe("exact authored interval strings before numeric rounding", () => {
  it.each(["1.0000000000000001", "51.9999999999999999", "0.99999999999999999", "52.000000000000001", "10000000000000001e-16", ".10000000000000001e1", "1.000000000000000000000000000001", "1e-9999999999999999999"])("refuses fractional or out-of-range %s", value => {
    expect(parseAdjustmentInterval(value)).toBeNull();
  });
  it.each(["1.0", "1e0", "+1", " 04 ", ".1e1", "1.", "100e-2", "005200e-2", "0x34", "0o64", "0b110100", "0001.000e+0000", "52000000000000000000000000000000e-30"])("preserves exact integer spelling %s", value => {
    expect(parseAdjustmentInterval(value)).toBe(Number(value));
  });
  it("handles long mantissas and exponents using input-sized work", () => {
    expect(parseAdjustmentInterval("1." + "0".repeat(10000) + "1")).toBeNull();
    expect(parseAdjustmentInterval("1e+" + "0".repeat(10000))).toBe(1);
    expect(parseAdjustmentInterval("1" + "0".repeat(10000) + "e-10000")).toBe(1);
    expect(parseAdjustmentInterval("1e" + "9".repeat(10000))).toBeNull();
    expect(parseAdjustmentInterval("1e-" + "9".repeat(10000))).toBeNull();
  });
  it("does not claim to recover precision already lost in numeric inputs", () => {
    const parsed = JSON.parse("1.0000000000000001");
    expect(parsed).toBe(1);
    expect(parseAdjustmentInterval(parsed)).toBe(1);
  });
});
