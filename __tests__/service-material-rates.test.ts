import { describe, expect, it } from "vitest";
import { commissionTimeKey } from "../lib/commission-time";
import { parseServiceMaterialRateChange, serviceMaterialRateAsOf } from "../lib/service-material-rates";

describe("service material rate policy history", () => {
  it("uses the exact event time, distinguishes explicit exemption and inheritance", () => {
    const t = (fraction: string) => `2026-09-15T11:00:00.${fraction}Z`;
    const timeline = new Map([[55, [
      { effectiveFrom: commissionTimeKey(t("000101")), rateBp: 2000 },
      { effectiveFrom: commissionTimeKey(t("000103")), rateBp: 0 },
      { effectiveFrom: commissionTimeKey(t("000105")), rateBp: null },
    ]]]);
    expect(["000100","000101","000102","000103","000104","000105"].map(f => serviceMaterialRateAsOf(timeline, 55, t(f))))
      .toEqual([null, 2000, 2000, 0, 0, null]);
    expect(serviceMaterialRateAsOf(timeline, 56, t("000102"))).toBeNull();
  });

  it("parses integer basis points and an explicit expected revision with a reason", () => {
    const input = { serviceId: 55, rateBp: 0, revision: "42", reason: "  synthetic change " };
    expect(parseServiceMaterialRateChange(input)).toEqual({ ...input, reason: "synthetic change" });
    expect(parseServiceMaterialRateChange({ ...input, rateBp: null, revision: null })).not.toBeNull();
    for (const bad of [
      { rateBp: -1 }, { rateBp: 10001 }, { rateBp: 0.02 }, { rateBp: "10" }, { rateBp: undefined },
      { serviceId: -1 }, { serviceId: 1.01 }, { serviceId: "55" }, { revision: "" },
      { revision: undefined }, { reason: "  " }, { reason: "x".repeat(301) },
    ]) expect(parseServiceMaterialRateChange({ ...input, ...bad })).toBeNull();
  });
});
