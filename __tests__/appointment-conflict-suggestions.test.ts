import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Appointment } from "../lib/schedule";
import type { AppointmentService } from "../lib/appointment-services";
import type { DbClient } from "../lib/db";

vi.mock("../lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  listProviderBlocks: vi.fn(),
}));

import { listProviderBlocks } from "../lib/db";
import { judgeBookingInDay } from "../lib/book-appointment";
import { evaluateCapacity, prepareCapacityEvaluator } from "../lib/capacity-context";

const date = "2026-10-27";
const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as DbClient;
const service: AppointmentService = {
  id: 1, code: "RCT", nameAr: "علاج جذور", nameEn: null, specialty: "endodontics",
  defaultDurationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
  requiresProvider: true, requiresChair: true, allowsConcurrentProviderWork: false,
  consumesEmergencyReserve: false, priority: 1, badgeClass: null, isActive: true,
  sortOrder: 1, legacyType: null, createdAt: "", createdBy: null, updatedAt: "", updatedBy: null,
};
const appointment = (over: Partial<Appointment> = {}): Appointment => ({
  id: 1, patientId: 12, patientName: "Synthetic", patientPhone: null,
  scheduledDate: date, scheduledTime: "16:00", durationMinutes: 30,
  doctorId: 1, status: "booked", note: null, occupiesChair: true, ...over,
});
const base = () => ({
  sameDay: [appointment()], client, date, time: "16:00", durationMinutes: 30,
  service, providerId: 1, patientId: 13, canOverride: false, overrideReason: "",
  context: { shifts: [{ start: "09:00", end: "20:00" }], chairs: 3,
    nearCapacityPercent: 80, emergencyReserveMinutes: 0, newPatientDailyLimit: 0 },
});
const blocks = vi.mocked(listProviderBlocks);
beforeEach(() => { blocks.mockReset(); blocks.mockResolvedValue([]); });

async function conflict(input: Parameters<typeof judgeBookingInDay>[0]) {
  const result = await judgeBookingInDay(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected booking conflict");
  return result.conflict;
}

describe("authoritative appointment conflict suggestions", () => {
  it.each(["16:00", "16:16"])("never re-suggests rejected same-doctor time %s with spare chairs", async time => {
    const result = await conflict({ ...base(), time });
    expect(result.suggestion).toBe("16:30");
    expect(result.suggestionMessage).toContain("16:30");
    expect(blocks).toHaveBeenCalledExactlyOnceWith(1, date, client);
  });

  it("respects both appointment and proposed service buffers at minute precision", async () => {
    const result = await conflict({ ...base(), sameDay: [appointment({ bufferAfterMinutes: 7 })],
      service: { ...service, bufferBeforeMinutes: 3 } });
    expect(result.suggestion).toBe("16:40");
  });

  it("loads provider blocks once and skips blocked alternatives", async () => {
    blocks.mockResolvedValue([{ startsAt: `${date}T16:30:00+03:00`, endsAt: `${date}T17:05:00+03:00`, reason: "Synthetic block" }] as Awaited<ReturnType<typeof listProviderBlocks>>);
    expect((await conflict(base())).suggestion).toBe("17:05");
    expect(blocks).toHaveBeenCalledTimes(1);
  });

  it("fails closed without repeated reads when provider verification fails", async () => {
    blocks.mockRejectedValue(new Error("Unavailable"));
    const result = await conflict(base());
    expect(result.suggestion).toBeNull();
    expect(result.message).toContain("تعذّر التحقّق");
    expect(blocks).toHaveBeenCalledTimes(1);
  });

  it("skips split-shift gaps and does not suggest a duration extending past closing", async () => {
    const input = base();
    input.context.shifts = [{ start: "09:00", end: "16:40" }, { start: "18:00", end: "19:00" }];
    expect((await conflict(input)).suggestion).toBe("18:00");
    input.context.shifts = [{ start: "09:00", end: "16:40" }];
    expect((await conflict(input)).suggestion).toBeNull();
  });

  it("honors an explicit chair even while other chairs and the selected doctor are free", async () => {
    expect((await conflict({ ...base(), chairNo: 2,
      sameDay: [appointment({ doctorId: 2, chairNo: 2 })] })).suggestion).toBe("16:30");
  });

  it("does not suggest overlap with the patient's other appointment", async () => {
    expect((await conflict({ ...base(), sameDay: [appointment(), appointment({
      id: 2, patientId: 13, doctorId: 2, scheduledTime: "16:30", durationMinutes: 45,
    })] })).suggestion).toBe("17:15");
  });

  it("excludes the appointment being rescheduled from provider and patient checks", async () => {
    expect((await conflict({ ...base(), excludeId: 2, sameDay: [appointment(), appointment({
      id: 2, patientId: 13, scheduledTime: "16:30", durationMinutes: 60,
    })] })).suggestion).toBe("16:30");
  });

  it("returns no alternative for a reached daily new-patient limit or inactive service", async () => {
    const input = base();
    input.context.newPatientDailyLimit = 1;
    expect((await conflict({ ...input, isNewPatient: true, sameDay: [appointment({ isNewPatient: true })] })).suggestion).toBeNull();
    expect((await conflict({ ...base(), service: { ...service, isActive: false } })).suggestion).toBeNull();
  });

  it.each([
    { providerId: 2 },
    { providerId: null },
    { service: { ...service, requiresProvider: false } },
    { service: { ...service, allowsConcurrentProviderWork: true } },
  ])("preserves legitimate parallel booking policy %#", async over => {
    expect(await judgeBookingInDay({ ...base(), ...over })).toMatchObject({ ok: true, overridden: false });
  });

  it("preserves authorized override but never overrides same-patient collision", async () => {
    expect(await judgeBookingInDay({ ...base(), canOverride: true, overrideReason: "Synthetic override" }))
      .toMatchObject({ ok: true, overridden: true });
    const result = await conflict({ ...base(), patientId: 12, canOverride: true, overrideReason: "Synthetic override" });
    expect(result.canOverride).toBe(false);
    expect(result.suggestion).toBeNull();
  });

  it("keeps the evaluateCapacity wrapper compatible with the prepared evaluator", async () => {
    const input = base();
    const evaluateAt = await prepareCapacityEvaluator(input);
    expect(evaluateAt(input.time)).toEqual(await evaluateCapacity(input));
    expect(evaluateAt("16:30").state).not.toBe("OVER_CAPACITY");
  });
});


describe("source-bound return provider fallback", () => {
  it("checks the assigned clinician when a return has no catalogue service", async () => {
    const result = await conflict({ ...base(), service: null, requireAssignedProvider: true });
    expect(result.suggestion).toBe("16:30");
    expect(blocks).toHaveBeenCalledExactlyOnceWith(1, date, client);
  });
  it("does not offer a provider-blocked alternative for a service-less return", async () => {
    blocks.mockResolvedValue([{ startsAt: `${date}T16:30:00+03:00`, endsAt: `${date}T17:05:00+03:00`, reason: "Synthetic block" }] as Awaited<ReturnType<typeof listProviderBlocks>>);
    const result = await conflict({ ...base(), service: null, requireAssignedProvider: true });
    expect(result.suggestion).toBe("17:05");
  });
});
