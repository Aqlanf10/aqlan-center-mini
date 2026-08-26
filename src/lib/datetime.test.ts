import { describe, expect, it } from "vitest";

import {
  addDaysToIsoDate,
  APP_TIMEZONE,
  coerceDate,
  getAppDayRangeUtc,
  getTodayIsoDate,
  getZonedParts,
  zonedTimeToUtc,
} from "@/lib/datetime";

describe("datetime layer (Asia/Aden, UTC+03:00)", () => {
  it("uses the clinic timezone by default", () => {
    expect(APP_TIMEZONE).toBe("Asia/Aden");
  });

  it("keeps 'today' anchored to Aden, not UTC, late in the UTC day", () => {
    // 22:00 UTC on Jan 15 is already 01:00 on Jan 16 in Aden.
    const instant = new Date("2026-01-15T22:00:00Z");
    expect(getTodayIsoDate(instant)).toBe("2026-01-16");
  });

  it("keeps 'today' aligned with UTC early in the UTC day", () => {
    // 05:00 UTC on Jan 15 is 08:00 in Aden — same calendar day.
    const instant = new Date("2026-01-15T05:00:00Z");
    expect(getTodayIsoDate(instant)).toBe("2026-01-15");
  });

  it("returns a UTC day range that starts at Aden midnight (21:00 UTC)", () => {
    const instant = new Date("2026-03-10T12:00:00Z"); // 15:00 in Aden
    const range = getAppDayRangeUtc(instant);

    expect(range.isoDate).toBe("2026-03-10");
    expect(range.startUtc.toISOString()).toBe("2026-03-09T21:00:00.000Z");
    expect(range.endUtc.toISOString()).toBe("2026-03-10T21:00:00.000Z");
  });

  it("converts Aden wall-clock midnight to the correct UTC instant", () => {
    const utc = zonedTimeToUtc({ year: 2026, month: 1, day: 16, hour: 0 });
    expect(utc.toISOString()).toBe("2026-01-15T21:00:00.000Z");
  });

  it("reads zoned calendar parts in Aden time", () => {
    const parts = getZonedParts(new Date("2026-01-15T22:30:00Z"));
    expect(parts).toEqual({
      year: 2026,
      month: 1,
      day: 16,
      hour: 1,
      minute: 30,
      second: 0,
    });
  });

  it("adds days across month and year boundaries", () => {
    expect(addDaysToIsoDate("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDaysToIsoDate("2025-12-31", 1)).toBe("2026-01-01");
    expect(addDaysToIsoDate("2026-02-28", 7)).toBe("2026-03-07");
    expect(addDaysToIsoDate("2026-06-15", -10)).toBe("2026-06-05");
  });

  it("works for a DST-observing timezone as well (America/New_York)", () => {
    // America/New_York switches to EDT on 2026-03-08 02:00 local.
    const range = getAppDayRangeUtc(
      new Date("2026-03-08T15:00:00Z"),
      "America/New_York"
    );
    expect(range.isoDate).toBe("2026-03-08");
    // Midnight New York on Mar 8 (EST, UTC-5) is 05:00 UTC.
    expect(range.startUtc.toISOString()).toBe("2026-03-08T05:00:00.000Z");
  });
});

/* ------------------------------------------------------------------ */
/* coerceDate — raw driver date value normalization                    */
/* ------------------------------------------------------------------ */

describe("coerceDate", () => {
  it("passes through valid Date objects", () => {
    const d = new Date("2026-08-27T06:00:00.000Z");
    expect(coerceDate(d)).toEqual(d);
  });

  it("returns null for null/undefined", () => {
    expect(coerceDate(null)).toBeNull();
    expect(coerceDate(undefined)).toBeNull();
  });

  it("returns null for invalid Dates and garbage strings", () => {
    expect(coerceDate(new Date("not a date"))).toBeNull();
    expect(coerceDate("garbage")).toBeNull();
  });

  it("parses PostgreSQL text timestamps with short offsets", () => {
    // postgres.js raw sql values arrive like this
    const d = coerceDate("2026-08-27 06:00:00+00");
    expect(d).not.toBeNull();
    expect(d?.toISOString()).toBe("2026-08-27T06:00:00.000Z");
  });

  it("parses ISO strings and T-form with short offsets", () => {
    expect(coerceDate("2026-08-27T06:00:00Z")?.toISOString()).toBe(
      "2026-08-27T06:00:00.000Z"
    );
    expect(coerceDate("2026-08-27T06:00:00+00")?.toISOString()).toBe(
      "2026-08-27T06:00:00.000Z"
    );
  });
});
