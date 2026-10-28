import { describe, expect, it } from "vitest";
import { getLabBridgeTeeth } from "../lib/lab";
import { PERMANENT_UPPER, PERMANENT_LOWER, PRIMARY_UPPER, PRIMARY_LOWER } from "../lib/dental";

describe("lab bridge anatomical range", () => {
  it.each([
    [11, 21, [11, 21]],
    [13, 23, [13, 12, 11, 21, 22, 23]],
    [43, 33, [43, 42, 41, 31, 32, 33]],
    [53, 63, [53, 52, 51, 61, 62, 63]],
    [83, 73, [83, 82, 81, 71, 72, 73]],
    [16, 14, [16, 15, 14]],
    [36, 34, [34, 35, 36]],
  ] as const)("uses anatomical adjacency between %i and %i", (start, end, expected) => {
    expect(getLabBridgeTeeth(start, end)).toEqual(expected);
    expect(getLabBridgeTeeth(end, start)).toEqual(expected);
  });

  it.each([PERMANENT_UPPER, PERMANENT_LOWER, PRIMARY_UPPER, PRIMARY_LOWER])(
    "uses only actual FDI codes across a whole arch",
    (...arch) => {
      expect(getLabBridgeTeeth(arch[0], arch[arch.length - 1])).toEqual(arch);
      for (const tooth of arch) expect(getLabBridgeTeeth(tooth, tooth)).toEqual([tooth]);
    },
  );

  it.each([
    [11, 31], [21, 41], [51, 71], [61, 81],
    [11, 51], [31, 71], [28, 65],
    [19, 21], [20, 21], [29, 11], [56, 61], [66, 51],
    [0, 11], [-11, 11], [11.5, 21], [Number.NaN, 21], [11, Number.POSITIVE_INFINITY],
  ])("refuses invalid or incompatible endpoints %s / %s", (start, end) => {
    expect(getLabBridgeTeeth(start, end)).toBeNull();
    expect(getLabBridgeTeeth(end, start)).toBeNull();
  });

  it("does not mutate canonical arch arrays or alias them", () => {
    const before = [...PERMANENT_UPPER];
    const result = getLabBridgeTeeth(18, 28)!;
    result.reverse();
    expect(PERMANENT_UPPER).toEqual(before);
    expect(getLabBridgeTeeth(18, 28)).toEqual(before);
  });
});
