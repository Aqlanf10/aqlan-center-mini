import { describe, expect, it } from "vitest";

import { resolveReportRange } from "@/server/reports/queries";

describe("resolveReportRange", () => {
  const now = new Date("2026-08-27T10:00:00Z"); // 2026-08-27 13:00 clinic (+03)

  it("defaults to today (clinic-day window)", () => {
    const range = resolveReportRange({ now });
    expect(range.preset).toBe("today");
    expect(range.startUtc.toISOString()).toBe("2026-08-26T21:00:00.000Z"); // 00:00 +03
    expect(range.endUtc.getTime() - range.startUtc.getTime()).toBe(24 * 3600 * 1000);
  });

  it("last7days spans 7 clinic days ending today", () => {
    const range = resolveReportRange({ preset: "last7days", now });
    expect(range.preset).toBe("last7days");
    const days =
      (range.endUtc.getTime() - range.startUtc.getTime()) / (24 * 3600 * 1000);
    expect(days).toBe(7);
  });

  it("thisMonth covers the whole clinic month", () => {
    const range = resolveReportRange({ preset: "thisMonth", now });
    expect(range.preset).toBe("thisMonth");
    expect(range.startUtc.toISOString()).toBe("2026-07-31T21:00:00.000Z");
    expect(range.endUtc.toISOString()).toBe("2026-08-31T21:00:00.000Z");
  });

  it("custom range uses clinic-timezone midnights (exclusive end)", () => {
    const range = resolveReportRange({
      preset: "custom",
      from: "2026-08-20",
      to: "2026-08-25",
      now,
    });
    expect(range.startUtc.toISOString()).toBe("2026-08-19T21:00:00.000Z");
    expect(range.endUtc.toISOString()).toBe("2026-08-25T21:00:00.000Z"); // Aug 26 00:00 +03
  });

  it("custom with invalid dates falls back to today", () => {
    const range = resolveReportRange({ preset: "custom", from: "garbage", to: "2026-08-25", now });
    expect(range.preset).toBe("today"); // invalid from → preset ignored → today window
    expect(range.endUtc.getTime() - range.startUtc.getTime()).toBe(24 * 3600 * 1000);
  });

  it("custom with from > to falls back to today", () => {
    const range = resolveReportRange({
      preset: "custom",
      from: "2026-08-25",
      to: "2026-08-20",
      now,
    });
    expect(range.endUtc.getTime() - range.startUtc.getTime()).toBe(24 * 3600 * 1000);
  });

  it("unknown preset falls back to today", () => {
    const range = resolveReportRange({ preset: "allTime", now });
    expect(range.preset).toBe("today");
  });
});
