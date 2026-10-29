import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "../lib/db";
vi.mock("../lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", listProviderBlocks: vi.fn(async () => []) }));
import { judgeBookingInDay } from "../lib/book-appointment";
import { validateBookingRequest } from "../lib/booking";
import { createPortalToken, readPortalToken, toPortalAppointment } from "../lib/portal";

describe("booking portal admission and privacy regressions", () => {
  const base = {
    sameDay: [], client: {} as DbClient, date: "2026-10-30", time: "10:00",
    durationMinutes: 30, service: null, patientId: null, canOverride: true, overrideReason: "synthetic override",
    context: { shifts: [{ start: "09:00", end: "12:00" }, { start: "16:00", end: "20:00" }],
      chairs: 3, nearCapacityPercent: 80, emergencyReserveMinutes: 0, newPatientDailyLimit: 0 },
  };
  it.each(["08:45", "11:45", "14:00", "19:45"])("rejects outside shift %s even with capacity override", async time => {
    const result = await judgeBookingInDay({ ...base, time });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict.canOverride).toBe(false);
  });
  it("uses the configured working weekdays, including Friday when open", async () => {
    const closed = await judgeBookingInDay({ ...base, context: { ...base.context, workingDays: [0, 1, 2, 3, 4, 6] } });
    expect(closed.ok).toBe(false);
    const open = await judgeBookingInDay({ ...base, context: { ...base.context, workingDays: [5] } });
    expect(open.ok).toBe(true);
  });
  it("rejects normalized invalid calendar dates", () => {
    expect(validateBookingRequest({ fullName: "مريض اصطناعي", phone: "777000001", preferredDate: "2027-02-30" }, "2027-02-01").ok).toBe(false);
  });
  it("does not expose internal appointment notes", () => {
    const result = toPortalAppointment({ id: 1, scheduledDate: "2026-10-30", scheduledTime: "10:00", durationMinutes: 30,
      appointmentType: null, note: "INTERNAL_SYNTHETIC_NOTE", status: "booked" }, null, "2026-10-29");
    expect(JSON.stringify(result)).not.toContain("INTERNAL_SYNTHETIC_NOTE");
  });
  it("rejects malformed signed envelopes and invalid patient IDs", () => {
    vi.stubEnv("SESSION_SECRET", "synthetic-portal-regression-secret-123456789");
    const payload = { patientId: 1, patientNumber: "SYNTH-1", fullName: "اصطناعي", expiresAt: Date.now() + 60_000 };
    expect(readPortalToken(createPortalToken(payload))).toEqual(payload);
    expect(readPortalToken(`${createPortalToken(payload)}.extra`)).toBeNull();
    for (const patientId of [-1, 0, 1.5]) expect(readPortalToken(createPortalToken({ ...payload, patientId }))).toBeNull();
    vi.unstubAllEnvs();
  });
});
