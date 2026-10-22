import { describe, expect, it } from "vitest";
import { judgeFullCapacity, type FullCapacityInput } from "@/lib/capacity";
import type { Appointment } from "@/lib/schedule";

const date = "2026-10-21";
const appointment = (id: number, scheduledTime: string, durationMinutes = 30,
  overrides: Partial<Appointment> = {}): Appointment => ({
  id, patientId: id, patientName: "مريض", patientPhone: null,
  scheduledDate: date, scheduledTime, durationMinutes, status: "booked", note: null,
  ...overrides,
});
const judge = (appointments: Appointment[], overrides: Partial<FullCapacityInput> = {}) =>
  judgeFullCapacity({
    appointments, date, time: "10:00", durationMinutes: 60,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, chairs: 2,
    shifts: [{ start: "08:00", end: "20:00" }], nearCapacityPercent: 80,
    service: {
      requiresChair: true, requiresProvider: false, allowsConcurrentProviderWork: false,
      consumesEmergencyReserve: false, isActive: true, nameAr: "كشف",
    },
    ...overrides,
  });

// Exercise the production verdict, not a duplicate implementation of its counting logic.
describe("full capacity uses peak simultaneous chair occupancy", () => {
  it("admits a long booking across adjacent appointments on the remaining chair", () => {
    const verdict = judge([appointment(1, "10:00"), appointment(2, "10:30")]);
    expect(verdict.occupiedChairs).toBe(1);
    expect(verdict.state).toBe("NEAR_CAPACITY");
    expect(verdict.reasons).toEqual(["هذا آخر كرسيٍّ متاح في هذا الوقت."]);
  });

  it("counts partial overlaps at their peak, not every appointment touched", () => {
    const verdict = judge([
      appointment(1, "10:00"), appointment(2, "10:15"), appointment(3, "10:45", 15),
    ], { chairs: 3 });
    expect(verdict.occupiedChairs).toBe(2);
    expect(verdict.state).toBe("NEAR_CAPACITY");
  });

  it.each([
    ["full overlap", [appointment(1, "09:30", 120), appointment(2, "10:00", 60)], 2],
    ["brief partial overlap", [appointment(1, "10:00"), appointment(2, "10:29")], 2],
    ["triple overlap", [appointment(1, "10:00", 60), appointment(2, "10:15"), appointment(3, "10:20")], 3],
  ])("still blocks genuine saturation: %s", (_label, appointments, peak) => {
    const verdict = judge(appointments, { chairs: peak });
    expect(verdict.occupiedChairs).toBe(peak);
    expect(verdict.state).toBe("OVER_CAPACITY");
    expect(verdict.message).toContain(`(${peak} من ${peak})`);
  });

  it("ignores saturation outside the candidate window and touching endpoints", () => {
    const verdict = judge([
      appointment(1, "09:30"), appointment(2, "09:45", 15),
      appointment(3, "10:15", 15),
      appointment(4, "11:00"), appointment(5, "11:00"),
    ]);
    expect(verdict.occupiedChairs).toBe(1);
    expect(verdict.state).toBe("NEAR_CAPACITY");
  });

  it("is independent of appointment order when ends and starts share a minute", () => {
    const appointments = [appointment(1, "10:00"), appointment(2, "10:30"), appointment(3, "10:00", 60)];
    for (const rows of [appointments, [...appointments].reverse()]) {
      expect(judge(rows, { chairs: 3 }).occupiedChairs).toBe(2);
    }
  });

  it.each(["bufferBeforeMinutes", "bufferAfterMinutes"] as const)(
    "includes existing %s in the simultaneous peak", (buffer) => {
      const appointments = [appointment(1, "10:00"), appointment(2, "10:30")];
      appointments[buffer === "bufferAfterMinutes" ? 0 : 1][buffer] = 5;
      expect(judge(appointments)).toMatchObject({ occupiedChairs: 2, state: "OVER_CAPACITY" });
    },
  );

  it("includes candidate buffers and treats touching buffered windows as half-open", () => {
    const appointments = [
      appointment(1, "09:30", 20, { bufferAfterMinutes: 10 }),
      appointment(2, "11:00", 20, { bufferBeforeMinutes: 10 }),
    ];
    expect(judge(appointments, { durationMinutes: 50 }).occupiedChairs).toBe(0);
    expect(judge(appointments, {
      durationMinutes: 50, bufferBeforeMinutes: 5, bufferAfterMinutes: 5,
    })).toMatchObject({ occupiedChairs: 1, state: "NEAR_CAPACITY" });
  });

  it("keeps date, rescheduling, lifecycle, and no-chair filters", () => {
    const verdict = judge([
      appointment(1, "10:00", 60, { scheduledDate: "2026-10-22" }),
      appointment(2, "10:00", 60, { status: "cancelled" }),
      appointment(3, "10:00", 60, { status: "done" }),
      appointment(4, "10:00", 60, { status: "no_show" }),
      appointment(5, "10:00", 60, { occupiesChair: false, chairNo: 1 }),
      appointment(6, "10:00", 60),
      appointment(7, "10:00", 30, { status: "arrived" }),
      appointment(8, "10:30", 30, { chairNo: null }),
    ], { excludeId: 6, chairNo: 1 });
    expect(verdict).toMatchObject({ occupiedChairs: 1, state: "NEAR_CAPACITY" });
  });

  it("does not require chair capacity for a no-chair candidate", () => {
    const service = { ...judgeInputService(), requiresChair: false };
    expect(judge([appointment(1, "10:00", 60), appointment(2, "10:00", 60)], { service }))
      .toMatchObject({ occupiedChairs: 0, state: "AVAILABLE" });
  });

  it("still rejects an explicit chair collision despite spare aggregate capacity", () => {
    const verdict = judge([
      appointment(1, "10:00", 30, { chairNo: 1 }),
      appointment(2, "10:30", 30, { chairNo: 1 }),
    ], { chairNo: 1 });
    expect(verdict).toMatchObject({ occupiedChairs: 1, state: "OVER_CAPACITY" });
    expect(verdict.reasons).toEqual(["الكرسي رقم 1 مشغولٌ في هذا الوقت."]);
  });

  it("does not promise an unassigned chair when pinned reservations fragment every chair", () => {
    const verdict = judge([
      appointment(1, "10:00", 30, { chairNo: 1 }),
      appointment(2, "10:30", 30, { chairNo: 2 }),
    ]);
    expect(verdict.occupiedChairs).toBe(1);
    expect(verdict.state).toBe("OVER_CAPACITY");
  });

  it("allows adjacent pinned reservations on the same chair or with a spare third chair", () => {
    const first = appointment(1, "10:00", 30, { chairNo: 1 });
    expect(judge([first, appointment(2, "10:30", 30, { chairNo: 1 })]))
      .toMatchObject({ occupiedChairs: 1, state: "NEAR_CAPACITY" });
    expect(judge([first, appointment(2, "10:30", 30, { chairNo: 2 })], { chairs: 3 }))
      .toMatchObject({ occupiedChairs: 1, state: "AVAILABLE" });
  });

  it("does not reserve chairs from touching, inactive, no-chair, excluded, or other-date rows", () => {
    const verdict = judge([
      appointment(1, "10:00", 30, { chairNo: 1 }),
      appointment(2, "09:30", 30, { chairNo: 2 }),
      appointment(3, "11:00", 30, { chairNo: 2 }),
      appointment(4, "10:30", 30, { chairNo: 2, status: "cancelled" }),
      appointment(5, "10:30", 30, { chairNo: 2, occupiesChair: false }),
      appointment(6, "10:30", 30, { chairNo: 2 }),
      appointment(7, "10:30", 30, { chairNo: 2, scheduledDate: "2026-10-22" }),
    ], { excludeId: 6 });
    expect(verdict).toMatchObject({ occupiedChairs: 1, state: "NEAR_CAPACITY" });
  });

  it("includes service buffers in the whole-window pinned-chair check", () => {
    const verdict = judge([
      appointment(1, "09:30", 30, { chairNo: 1, bufferAfterMinutes: 5 }),
      appointment(2, "11:00", 30, { chairNo: 2, bufferBeforeMinutes: 5 }),
    ]);
    expect(verdict).toMatchObject({ occupiedChairs: 1, state: "OVER_CAPACITY" });
    expect(verdict.message).toContain("طوال مدة الموعد");
  });

  it("rejects mixed pinned fragmentation even when fewer chairs are pinned than configured", () => {
    const verdict = judge([
      appointment(1, "10:00", 30, { chairNo: 1 }),
      appointment(2, "10:30", 30, { chairNo: 2 }),
      appointment(3, "10:00", 60),
    ], { chairs: 3 });
    expect(verdict).toMatchObject({ occupiedChairs: 2, state: "OVER_CAPACITY" });
    expect(verdict.message).toContain("طوال مدة الموعد");
  });

  it.each([null, 1])("retains conservative mixed-pinning safety with outside pins (candidate chair %s)", (chairNo) => {
    // X must use chair 2 before 10:00; Y must use chair 1 after 11:00.
    // Their candidate-window portions are adjacent, but neither chair is free throughout.
    const verdict = judge([
      appointment(1, "09:30", 30, { chairNo: 1 }),
      appointment(2, "11:00", 30, { chairNo: 2 }),
      appointment(3, "09:30", 60),
      appointment(4, "10:30", 60),
    ], { chairNo });
    expect(verdict).toMatchObject({ occupiedChairs: 1, state: "OVER_CAPACITY" });
    expect(verdict.message).toContain("طوال مدة الموعد");
  });

  it("preserves doctor collision safety independently of spare chair capacity", () => {
    const verdict = judge([
      appointment(1, "10:00", 30, { doctorId: 9 }), appointment(2, "10:30"),
    ], { providerId: 9, service: { ...judgeInputService(), requiresProvider: true } });
    expect(verdict).toMatchObject({ occupiedChairs: 1, state: "OVER_CAPACITY" });
    expect(verdict.reasons).toEqual(["الطبيب لديه موعدٌ آخر يتداخل مع هذا الوقت."]);
  });
});

function judgeInputService(): FullCapacityInput["service"] {
  return {
    requiresChair: true, requiresProvider: false, allowsConcurrentProviderWork: false,
    consumesEmergencyReserve: false, isActive: true, nameAr: "كشف",
  };
}
