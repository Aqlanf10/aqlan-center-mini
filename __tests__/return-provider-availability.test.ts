import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", listProviderBlocks: vi.fn() }));
import { listProviderBlocks } from "../lib/db";
import { judgeBookingInDay } from "../lib/book-appointment";
import type { DbClient } from "../lib/db";
import type { Appointment } from "../lib/schedule";
const date = "2030-01-20";
const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as DbClient;
const base = () => ({ sameDay: [] as Appointment[], client, date, time: "16:00", durationMinutes: 15, service: null,
  context: { chairs: 3, shifts: [{ start: "09:00", end: "20:00" }], nearCapacityPercent: 80, emergencyReserveMinutes: 0, newPatientDailyLimit: 0 },
  patientId: 19, providerId: 7, requireAssignedProvider: true, canOverride: false, overrideReason: "" });
beforeEach(() => { vi.mocked(listProviderBlocks).mockReset(); vi.mocked(listProviderBlocks).mockResolvedValue([]); });
it("a return with no service still refuses its responsible doctor's blocked window", async () => {
  vi.mocked(listProviderBlocks).mockResolvedValue([{ startsAt: `${date}T16:00:00+03:00`, endsAt: `${date}T17:00:00+03:00`, reason: "Synthetic travel" }] as Awaited<ReturnType<typeof listProviderBlocks>>);
  const result = await judgeBookingInDay(base());
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.conflict.message).toContain("الطبيب");
  expect(listProviderBlocks).toHaveBeenCalledWith(7, date, client);
});
it("a return with no service still refuses an existing same-doctor appointment", async () => {
  const existing: Appointment = { id: 90, patientId: 20, patientName: "Synthetic other patient", patientPhone: null,
    scheduledDate: date, scheduledTime: "16:00", durationMinutes: 30, doctorId: 7, note: null, status: "booked" };
  const result = await judgeBookingInDay({ ...base(), sameDay: [existing] });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.conflict.message).toContain("الطبيب");
});
it("does not invent provider consumption for unrelated untyped generic bookings", async () => {
  const result = await judgeBookingInDay({ ...base(), requireAssignedProvider: false });
  expect(result.ok).toBe(true);
  expect(listProviderBlocks).not.toHaveBeenCalled();
});
