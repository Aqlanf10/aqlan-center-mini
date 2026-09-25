import { describe, expect, it } from "vitest";
import { patientOverlap } from "../lib/book-appointment";
import type { Appointment } from "../lib/schedule";

const appointment = (id: number, patientId: number, time: string, duration: number, status = "booked") =>
  ({ id, patientId, patientName: "م", patientPhone: null, scheduledDate: "2026-08-12", scheduledTime: time,
    durationMinutes: duration, note: null, status }) as unknown as Appointment;

describe("P2-3 — one patient, one place at a time", () => {
  const day = [appointment(1, 7, "10:00", 60), appointment(2, 8, "10:00", 30), appointment(3, 7, "13:00", 30, "cancelled")];

  it("blocks an overlapping booking for the same patient (by duration, not only start)", () => {
    expect(patientOverlap(day, 7, "10:00", 30)?.id).toBe(1);
    expect(patientOverlap(day, 7, "10:30", 30)?.id).toBe(1);
    expect(patientOverlap(day, 7, "09:30", 45)?.id).toBe(1);
  });

  it("allows back-to-back, other patients, cancelled slots and the appointment itself", () => {
    expect(patientOverlap(day, 7, "11:00", 30)).toBeNull();
    expect(patientOverlap(day, 7, "09:00", 60)).toBeNull();
    expect(patientOverlap(day, 9, "10:00", 30)).toBeNull();
    expect(patientOverlap(day, 7, "13:00", 30)).toBeNull();
    expect(patientOverlap(day, 7, "10:15", 30, 1)).toBeNull();
  });
});
