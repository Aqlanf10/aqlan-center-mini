import { describe, expect, it } from "vitest";
import {
  calculateShiftAttendance,
} from "../lib/hr-contracts-attendance-shared";

describe("(HR-4) Shift and Attendance Calculations", () => {
  it("calculates normal shift on-time arrival accurately", () => {
    const res = calculateShiftAttendance({
      scheduledStart: "08:00",
      scheduledEnd: "16:00",
      checkIn: new Date("2026-10-10T08:00:00"),
      checkOut: new Date("2026-10-10T16:00:00"),
      graceMins: 15,
      crossesMidnight: false,
    });

    expect(res.status).toBe("present");
    expect(res.workMinutes).toBe(480);
    expect(res.lateMinutes).toBe(0);
    expect(res.overtimeMinutes).toBe(0);
  });

  it("handles grace period without marking late", () => {
    const res = calculateShiftAttendance({
      scheduledStart: "08:00",
      scheduledEnd: "16:00",
      checkIn: new Date("2026-10-10T08:10:00"), // 10 minutes late within 15 min grace
      checkOut: new Date("2026-10-10T16:00:00"),
      graceMins: 15,
      crossesMidnight: false,
    });

    expect(res.status).toBe("present");
    expect(res.lateMinutes).toBe(0);
  });

  it("marks late when arrival exceeds grace period", () => {
    const res = calculateShiftAttendance({
      scheduledStart: "08:00",
      scheduledEnd: "16:00",
      checkIn: new Date("2026-10-10T08:35:00"), // 35 minutes late
      checkOut: new Date("2026-10-10T16:00:00"),
      graceMins: 15,
      crossesMidnight: false,
    });

    expect(res.status).toBe("late");
    expect(res.lateMinutes).toBe(35);
  });

  it("detects incomplete punches when checkout is missing", () => {
    const res = calculateShiftAttendance({
      scheduledStart: "08:00",
      scheduledEnd: "16:00",
      checkIn: new Date("2026-10-10T08:00:00"),
      checkOut: null,
      graceMins: 15,
      crossesMidnight: false,
    });

    expect(res.status).toBe("incomplete");
    expect(res.isIncomplete).toBe(true);
    expect(res.workMinutes).toBe(0);
  });

  it("accurately calculates night shifts crossing midnight (20:00 to 04:00 next day)", () => {
    const res = calculateShiftAttendance({
      scheduledStart: "20:00",
      scheduledEnd: "04:00",
      checkIn: new Date("2026-10-10T20:00:00"),
      checkOut: new Date("2026-10-11T04:00:00"),
      graceMins: 15,
      crossesMidnight: true,
    });

    expect(res.status).toBe("present");
    expect(res.workMinutes).toBe(480); // 8 hours
    expect(res.lateMinutes).toBe(0);
  });

  it("computes overtime for hours worked past shift end", () => {
    const res = calculateShiftAttendance({
      scheduledStart: "08:00",
      scheduledEnd: "16:00",
      checkIn: new Date("2026-10-10T08:00:00"),
      checkOut: new Date("2026-10-10T18:00:00"), // 2 hours overtime
      graceMins: 15,
      crossesMidnight: false,
    });

    expect(res.workMinutes).toBe(600); // 10 hours
    expect(res.overtimeMinutes).toBe(120); // 2 hours overtime
  });
});
