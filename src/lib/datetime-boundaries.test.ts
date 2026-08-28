import { describe, expect, it } from "vitest";

import {
  addDaysToIsoDate,
  formatDateTimeLocalInput,
  getAppDayRangeUtc,
  getTodayIsoDate,
  parseDateTimeLocal,
} from "@/lib/datetime";

/**
 * Asia/Aden is UTC+03:00 with no DST. The critical boundary: UTC 21:00 is
 * 00:00 of the NEXT calendar day in Aden. Every "today" computation must
 * cross that boundary correctly or the clinic loses/ghosts a whole day.
 */
const TZ = "Asia/Aden";

describe("parseDateTimeLocal (clinic timezone wall-clock -> UTC instant)", () => {
  it("converts morning Aden times correctly", () => {
    const instant = parseDateTimeLocal("2026-08-27T09:00", TZ);
    expect(instant?.toISOString()).toBe("2026-08-27T06:00:00.000Z");
  });

  it("crosses the midnight boundary: 00:30 Aden is 21:30 UTC the previous day", () => {
    const instant = parseDateTimeLocal("2026-08-28T00:30", TZ);
    expect(instant?.toISOString()).toBe("2026-08-27T21:30:00.000Z");
  });

  it("23:59 Aden is still the same UTC day", () => {
    const instant = parseDateTimeLocal("2026-08-27T23:59", TZ);
    expect(instant?.toISOString()).toBe("2026-08-27T20:59:00.000Z");
  });

  it("round-trips through formatDateTimeLocalInput", () => {
    const wall = "2026-08-27T14:45";
    const instant = parseDateTimeLocal(wall, TZ);
    expect(instant).not.toBeNull();
    expect(formatDateTimeLocalInput(instant!, TZ)).toBe(wall);
  });

  it("rejects malformed values", () => {
    expect(parseDateTimeLocal("2026-08-27", TZ)).toBeNull();
    expect(parseDateTimeLocal("2026-08-27 09:00", TZ)).toBeNull();
    expect(parseDateTimeLocal("not-a-date", TZ)).toBeNull();
    expect(parseDateTimeLocal("", TZ)).toBeNull();
  });

  it("rejects impossible wall-clock values", () => {
    expect(parseDateTimeLocal("2026-13-01T10:00", TZ)).toBeNull();
    expect(parseDateTimeLocal("2026-08-32T10:00", TZ)).toBeNull();
    expect(parseDateTimeLocal("2026-08-27T25:00", TZ)).toBeNull();
  });
});

describe("getAppDayRangeUtc (clinic day window)", () => {
  it("treats UTC 20:59 as the same clinic day", () => {
    // 2026-08-27T20:59Z == 23:59 in Aden on Aug 27.
    const { isoDate, startUtc, endUtc } = getAppDayRangeUtc(
      new Date("2026-08-27T20:59:00Z"),
      TZ
    );
    expect(isoDate).toBe("2026-08-27");
    expect(startUtc.toISOString()).toBe("2026-08-26T21:00:00.000Z");
    expect(endUtc.toISOString()).toBe("2026-08-27T21:00:00.000Z");
  });

  it("rolls to the NEXT clinic day at UTC 21:00 (Aden midnight)", () => {
    const { isoDate, startUtc } = getAppDayRangeUtc(
      new Date("2026-08-27T21:00:00Z"),
      TZ
    );
    expect(isoDate).toBe("2026-08-28");
    expect(startUtc.toISOString()).toBe("2026-08-27T21:00:00.000Z");
  });

  it("keeps an appointment at UTC 21:30 inside the Aug-28 clinic day", () => {
    // An appointment stored as 2026-08-27T21:30Z is 00:30 Aden on Aug 28:
    // it must appear on the Aug 28 Today screen, not Aug 27.
    const appointment = new Date("2026-08-27T21:30:00Z");
    const day28 = getAppDayRangeUtc(new Date("2026-08-28T06:00:00Z"), TZ);
    expect(appointment >= day28.startUtc).toBe(true);
    expect(appointment < day28.endUtc).toBe(true);

    const day27 = getAppDayRangeUtc(new Date("2026-08-27T06:00:00Z"), TZ);
    expect(appointment < day27.endUtc).toBe(false);
  });

  it("getTodayIsoDate agrees with the range window", () => {
    const at = new Date("2026-08-27T21:00:00Z");
    expect(getTodayIsoDate(at, TZ)).toBe("2026-08-28");
  });
});

describe("addDaysToIsoDate (recall arithmetic)", () => {
  it("adds days across month and year boundaries", () => {
    expect(addDaysToIsoDate("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDaysToIsoDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysToIsoDate("2026-02-28", 21)).toBe("2026-03-21");
  });

  it("handles leap-year February", () => {
    expect(addDaysToIsoDate("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("supports the default 21-day recall exactly", () => {
    expect(addDaysToIsoDate("2026-08-06", 21)).toBe("2026-08-27");
  });

  it("throws on malformed input instead of guessing", () => {
    expect(() => addDaysToIsoDate("2026/08/06", 21)).toThrow();
    expect(() => addDaysToIsoDate("", 21)).toThrow();
  });
});
