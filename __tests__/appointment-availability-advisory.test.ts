import { describe, expect, it } from "vitest";
import { doctorAvailabilitySuggestions } from "../lib/appointment-availability-advisory";
import { doctorBookingDay } from "../lib/doctor-booking-window";
import type { RosterSources } from "../lib/doctor-clinical-roster";
import type { Appointment } from "../lib/schedule";
import { whatsAppLink } from "../lib/reminders";

const date = "2030-04-08";
function sources(): RosterSources {
  return {
    staff: [{ id: 1, userId: 5, department: "doctors", workStatus: "active", hireDate: "2020-01-01", endDate: null }],
    accounts: [{ id: 5, partyId: 7, active: true }], parties: [{ id: 7, kind: "doctor", active: true }], partyLinks: null,
    schedules: [{ id: 1, staffId: 1, department: null, active: true, effectiveFrom: "2030-01-01", effectiveTo: null,
      workingDays: [0, 1, 2, 3, 4, 5, 6], start: "09:00", end: "13:00", secondStart: null, secondEnd: null,
      crossesMidnight: false, scheduleType: "morning", updatedAt: "synthetic-v1" }], leaves: [],
  };
}
const base = {
  date, doctorId: 7, durationMinutes: 30, timeZone: "Asia/Aden", today: "2029-01-01", nowMinutes: 0,
  service: { nameAr: "كشف", isActive: true, requiresProvider: true, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
  context: { shifts: [{ start: "08:00", end: "21:00" }], chairs: 2, nearCapacityPercent: 80,
    emergencyReserveMinutes: 0, newPatientDailyLimit: 0 },
  appointments: [] as Appointment[], blocks: [],
};
function advice(s = sources(), patch: Partial<typeof base> = {}) {
  return doctorAvailabilitySuggestions({ ...base, ...patch, roster: doctorBookingDay(s, 7, patch.date ?? date, "Asia/Aden") });
}
const at = (result: ReturnType<typeof advice>, time: string) => result.slots.find(slot => slot.time === time);

describe("read-only duty-aware appointment suggestions", () => {
  it("qualifies available slots and excludes off-duty clinic hours without revealing source IDs", () => {
    const result = advice();
    expect(result).toMatchObject({ purpose: "advisory_only", bookingGuaranteed: false, rosterStatus: "resolved", timeZone: "Asia/Aden" });
    expect(at(result, "09:00")).toEqual({ time: "09:00", status: "available", label: "مقترح" });
    expect(at(result, "08:30")).toMatchObject({ status: "unavailable", label: "خارج جدول الدوام" });
    expect(at(result, "12:45")?.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toMatch(/staffId|sourceSchedule|leaveId|revision|workingDays/);
  });
  it("supports evening, continuous and split shifts without inventing availability in the break", () => {
    const s = sources(); Object.assign(s.schedules[0], { start: "16:00", end: "20:00", scheduleType: "evening" });
    expect(at(advice(s), "09:00")?.status).toBe("unavailable");
    expect(at(advice(s), "16:00")?.status).toBe("available");
    Object.assign(s.schedules[0], { start: "09:00", end: "13:00", secondStart: "13:00", secondEnd: "20:00", scheduleType: "split" });
    expect(at(advice(s), "12:45")?.status).toBe("available");
    s.schedules[0].secondStart = "16:00";
    expect(at(advice(s), "12:45")?.status).toBe("unavailable");
    expect(at(advice(s), "15:45")?.status).toBe("unavailable");
    expect(at(advice(s), "16:00")?.status).toBe("available");
  });
  it("distinguishes known day off and full-day leave from unresolved evidence", () => {
    const s = sources(); s.schedules[0].workingDays = [0];
    expect(advice(s)).toMatchObject({ rosterStatus: "resolved", slots: [] });
    s.schedules[0].workingDays = [1];
    s.leaves.push({ id: 1, staffId: 1, startDate: date, endDate: date, status: "approved", partial: false, updatedAt: "v1" });
    expect(advice(s)).toMatchObject({ rosterStatus: "resolved", slots: [] });
    s.leaves[0].partial = true;
    expect(advice(s)).toMatchObject({ rosterStatus: "unknown", slots: [] });
  });
  it.each(["mapping", "schedule", "ambiguous", "invalid"])("never colors %s evidence green", kind => {
    const s = sources();
    if (kind === "mapping") s.accounts = [];
    if (kind === "schedule") s.schedules = [];
    if (kind === "ambiguous") s.schedules.push({ ...s.schedules[0], id: 2 });
    if (kind === "invalid") s.schedules[0].end = "invalid";
    expect(advice(s)).toMatchObject({ rosterStatus: "unknown", slots: [] });
  });
  it("uses inclusive effective dates and refuses an expired schedule", () => {
    const s = sources(); s.schedules[0].effectiveTo = date;
    expect(at(advice(s), "12:00")?.status).toBe("available");
    expect(advice(s, { date: "2030-04-09" })).toMatchObject({ rosterStatus: "unknown", slots: [] });
  });
  it("projects yesterday's night tail only within existing clinic civil-day hours", () => {
    const s = sources(); Object.assign(s.schedules[0], { start: "22:00", end: "04:00", crossesMidnight: true, scheduleType: "night", workingDays: [0] });
    const context = { ...base.context, shifts: [{ start: "00:00", end: "23:59" }] };
    expect(at(advice(s, { context }), "01:00")?.status).toBe("available");
    expect(at(advice(s), "09:00")?.status).toBe("unavailable");
    expect(at(advice(s, { context }), "22:00")?.status).toBe("unavailable");
    s.leaves.push({ id: 1, staffId: 1, startDate: "2030-04-07", endDate: "2030-04-07", status: "approved", partial: false, updatedAt: "v1" });
    expect(advice(s, { context })).toMatchObject({ rosterStatus: "resolved", slots: [] });
  });
  it("includes duration and both buffers when intersecting doctor and clinic periods", () => {
    const buffered = { ...base.service, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 };
    expect(at(advice(sources(), { service: buffered }), "09:00")?.status).toBe("unavailable");
    expect(at(advice(sources(), { service: buffered }), "09:15")?.status).toBe("available");
    expect(at(advice(sources(), { service: buffered }), "12:30")?.status).toBe("unavailable");
    const context = { ...base.context, shifts: [{ start: "10:00", end: "12:00" }] };
    expect(at(advice(sources(), { service: buffered, context }), "10:00")?.status).toBe("unavailable");
    expect(at(advice(sources(), { service: buffered, context }), "11:30")?.status).toBe("unavailable");
  });
  it("retains doctor, provider-block and chair occupancy checks and source immutability", () => {
    const appointments: Appointment[] = [{ id: 1, patientId: 1, patientName: "Synthetic private patient", patientPhone: null,
      doctorId: 7, scheduledDate: date, scheduledTime: "10:00", durationMinutes: 30, status: "booked", note: null, chairNo: 1 }];
    const before = JSON.stringify(appointments);
    expect(at(advice(sources(), { appointments }), "10:00")?.status).toBe("booked");
    expect(at(doctorAvailabilitySuggestions({ ...base, roster: doctorBookingDay(sources(), 7, date, "Asia/Aden"),
      blocks: [{ startMinutes: 600, endMinutes: 630, reason: "Private leave reason" }] }), "10:00")?.status).toBe("blocked");
    appointments[0].doctorId = 8;
    expect(at(advice(sources(), { appointments, context: { ...base.context, chairs: 1 } }), "10:00")?.status).toBe("unavailable");
    appointments[0].doctorId = 7;
    expect(JSON.stringify(appointments)).toBe(before);
  });
  it("does not suggest selected-doctor off-duty time even when the service does not require a provider", () => {
    expect(at(advice(sources(), { service: { ...base.service, requiresProvider: false } }), "08:00")?.status).toBe("unavailable");
  });
  it("retains the 12:00 clinic clock in the suggestion and decoded WhatsApp text", () => {
    const time = at(advice(), "12:00")!.time;
    const link = whatsAppLink({ id: 1, patientId: 1, patientName: "Synthetic", patientPhone: "777100001",
      scheduledDate: date, scheduledTime: time, durationMinutes: 30, status: "booked", note: null }, "upcoming")!;
    expect(time).toBe("12:00");
    expect(new URL(link).searchParams.get("text")).toContain("12:00 مساءً");
    expect(new URL(link).searchParams.get("text")).not.toContain("3:00");
  });
});
