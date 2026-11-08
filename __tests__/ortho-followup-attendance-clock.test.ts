import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveFollowupAttendanceCutoff } from "../lib/ortho-followup-attendance";

const ZONE = "Asia/Aden";
afterEach(() => { vi.useRealTimers(); });

describe("follow-up scheduled-slot cutoff contract", () => {
  it("keeps a valid explicit instant without consulting the later wall clock", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T09:00:00Z"));
    expect(resolveFollowupAttendanceCutoff("2026-10-05", ZONE, new Date("2026-10-05T20:59:59.123Z"))).toEqual({
      kind: "explicit_instant", instant: "2026-10-05T20:59:59.123Z", timeZone: ZONE,
    });
  });
  it("uses captured now for a matching current clinic day, including UTC rollover", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T21:30:00.456Z"));
    expect(resolveFollowupAttendanceCutoff("2026-10-06", ZONE)).toEqual({
      kind: "captured_now", instant: "2026-10-05T21:30:00.456Z", timeZone: ZONE,
    });
  });
  it.each(["2026-10-04", "2026-10-07"])("labels non-current date %s as an exclusive midnight cutoff, never mixing today's time", (day) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T21:30:00.456Z"));
    expect(resolveFollowupAttendanceCutoff(day, ZONE)).toEqual({
      kind: "date_only_before_midnight", instant: null, timeZone: ZONE,
    });
  });
  it.each(["2026-02-30", "2025-02-29", "2026-13-01", "2026-1-01", "not-a-day", "0000-01-01", "2026-10-05T00:00:00Z"])("rejects invalid calendar date %s", (day) => {
    expect(() => resolveFollowupAttendanceCutoff(day, ZONE)).toThrow(RangeError);
  });
  it("accepts a real leap day in date-only mode", () => {
    expect(resolveFollowupAttendanceCutoff("2024-02-29", ZONE).kind).toBe("date_only_before_midnight");
  });
  it.each([new Date("invalid"), null, "2026-10-05T09:00:00Z", 1791190800000])("rejects a malformed explicit clock %s", (asOf) => {
    expect(() => resolveFollowupAttendanceCutoff("2026-10-05", ZONE, asOf as Date)).toThrow(RangeError);
  });
  it("rejects a mismatched explicit clock instead of silently falling back", () => {
    expect(() => resolveFollowupAttendanceCutoff("2026-10-05", ZONE, new Date("2026-10-05T21:00:00Z"))).toThrow(RangeError);
  });
  it.each(["2026-11-01T05:30:00.123Z", "2026-11-01T06:30:00.123Z"])("preserves repeated-hour instant %s; SQL ordering remains local scheduled-slot ordering", (instant) => {
    expect(resolveFollowupAttendanceCutoff("2026-11-01", "America/New_York", new Date(instant))).toEqual({
      kind: "explicit_instant", instant, timeZone: "America/New_York",
    });
  });
});
