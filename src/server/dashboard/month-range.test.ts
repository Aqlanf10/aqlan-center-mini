import { describe, expect, it } from "vitest";

import { getAppMonthRangeUtc } from "@/lib/datetime";

describe("getAppMonthRangeUtc", () => {
  it("covers the whole clinic month for a mid-month instant", () => {
    // 2026-08-15 10:00 clinic time (UTC+3) = 07:00Z → month = August
    const midMonth = new Date("2026-08-15T07:00:00Z");
    const { startUtc, endUtc } = getAppMonthRangeUtc(midMonth);
    expect(startUtc.toISOString()).toBe("2026-07-31T21:00:00.000Z"); // Aug 1 00:00 +03
    expect(endUtc.toISOString()).toBe("2026-08-31T21:00:00.000Z"); // Sep 1 00:00 +03
  });

  it("handles December → January year rollover", () => {
    const december = new Date("2026-12-15T07:00:00Z");
    const { startUtc, endUtc } = getAppMonthRangeUtc(december);
    expect(startUtc.toISOString()).toBe("2026-11-30T21:00:00.000Z"); // Dec 1 00:00 +03
    expect(endUtc.toISOString()).toBe("2026-12-31T21:00:00.000Z"); // Jan 1 2027 00:00 +03
  });

  it("is stable at month boundaries (00:00 and 23:59 clinic time)", () => {
    const sepFirstStart = new Date("2026-08-31T21:00:00Z"); // Sep 1 00:00 +03
    expect(getAppMonthRangeUtc(sepFirstStart).startUtc.toISOString()).toBe(
      "2026-08-31T21:00:00.000Z"
    );
    const sepLastEnd = new Date("2026-09-30T20:59:59.999Z"); // Sep 30 23:59:59.999 +03
    expect(getAppMonthRangeUtc(sepLastEnd).endUtc.toISOString()).toBe(
      "2026-09-30T21:00:00.000Z"
    );
  });
});
