import { describe, expect, it } from "vitest";
import { doctorAvailabilitySlots } from "../lib/appointment-availability";
import type { Appointment } from "../lib/schedule";

const date = "2030-04-08";
const appointment = (id: number, doctorId: number, time: string, status: Appointment["status"] = "booked"): Appointment => ({
  id, doctorId, patientId: id, patientName: `مريض ${id}`, patientPhone: null,
  scheduledDate: date, scheduledTime: time, durationMinutes: 30,
  status, note: null, occupiesChair: true,
});

const base = {
  date, doctorId: 7, durationMinutes: 30,
  service: {
    nameAr: "كشف", isActive: true, requiresProvider: true, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: false,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
  },
  context: {
    shifts: [{ start: "09:00", end: "11:00" }], chairs: 2,
    nearCapacityPercent: 80, emergencyReserveMinutes: 0, newPatientDailyLimit: 0,
  },
  appointments: [appointment(1, 7, "09:00"), appointment(2, 8, "09:30")],
  blocks: [{ startMinutes: 10 * 60, endMinutes: 10 * 60 + 30, reason: "غياب" }],
  today: "2029-01-01", nowMinutes: 0,
};

describe("doctor availability", () => {
  it("marks the selected doctor's booked and blocked windows unavailable while leaving free slots selectable", () => {
    const slots = doctorAvailabilitySlots(base);
    const at = (time: string) => slots.find((slot) => slot.time === time);
    expect(at("09:00")).toMatchObject({ status: "booked", label: "محجوز" });
    expect(at("09:15")?.status).toBe("booked");
    expect(at("09:30")?.status).toBe("available");
    expect(at("09:45")?.status).toBe("blocked");
    expect(at("10:00")?.status).toBe("blocked");
    expect(at("10:30")?.status).toBe("available");
  });

  it("also accounts for another doctor's chair use, cancelled bookings, and elapsed time", () => {
    const singleChair = doctorAvailabilitySlots({
      ...base, context: { ...base.context, chairs: 1 }, blocks: [],
      appointments: [appointment(2, 8, "09:30"), appointment(3, 7, "10:00", "cancelled")],
    });
    expect(singleChair.find((slot) => slot.time === "09:30")?.status).toBe("unavailable");
    expect(singleChair.find((slot) => slot.time === "10:00")?.status).toBe("available");
    const elapsed = doctorAvailabilitySlots({ ...base, appointments: [], blocks: [], today: date, nowMinutes: 9 * 60 + 10 });
    expect(elapsed.find((slot) => slot.time === "09:00")?.status).toBe("unavailable");
    expect(elapsed.find((slot) => slot.time === "09:15")?.status).toBe("available");
  });

  it("checks the selected chair even when another chair is free", () => {
    const appointments = [{ ...appointment(2, 8, "09:30"), chairNo: 1 }];
    const openChair = doctorAvailabilitySlots({ ...base, appointments, blocks: [] });
    const chosenChair = doctorAvailabilitySlots({ ...base, appointments, blocks: [], chairNo: 1 });
    expect(openChair.find((slot) => slot.time === "09:30")?.status).toBe("available");
    expect(chosenChair.find((slot) => slot.time === "09:30")?.status).toBe("unavailable");
  });

  it("marks slots unavailable when the daily new-patient limit has been reached", () => {
    const input = {
      ...base, context: { ...base.context, newPatientDailyLimit: 1 },
      appointments: [{ ...appointment(2, 8, "09:30"), isNewPatient: true }], blocks: [],
    };
    const existing = doctorAvailabilitySlots({ ...input, isNewPatient: false });
    const newcomer = doctorAvailabilitySlots({ ...input, isNewPatient: true });
    expect(existing.find((slot) => slot.time === "10:30")?.status).toBe("available");
    expect(newcomer.find((slot) => slot.time === "10:30")?.status).toBe("unavailable");
  });
});
