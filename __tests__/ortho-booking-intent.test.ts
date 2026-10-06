import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", findUserByUsername: vi.fn(), doctorOwnedPatientIds: vi.fn(), labWorkForPatients: vi.fn(), listAppointmentsByDate: vi.fn(),
  getAppointment: vi.fn(), insertAppointmentOnClient: vi.fn(), moveAppointmentOnClient: vi.fn(), recordAudit: vi.fn(),
  writeAppointmentAcrossDays: vi.fn(), writeAppointmentInDay: vi.fn(),
}));
vi.mock("../lib/capacity-context", () => ({ evaluateCapacity: vi.fn(), loadCapacityContext: vi.fn(), resolveService: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: vi.fn() }));
import { bookAppointment, type BookAppointmentInput } from "../lib/book-appointment";
import { findUserByUsername, insertAppointmentOnClient, writeAppointmentInDay } from "../lib/db";
import { loadCapacityContext, resolveService } from "../lib/capacity-context";
import { requireSession } from "../lib/session";
import { POST } from "../app/api/appointments/route";
import { FOLLOWUP_SERVICE_REVIEW_MESSAGE } from "../lib/ortho-booking-intent";
import type { AppointmentService } from "../lib/appointment-services";
const service = (): AppointmentService => ({ id: 81, code: "ORTHO_FOLLOW_UP", nameAr: "Periodic synthetic", nameEn: null,
  specialty: "orthodontics", legacyType: "follow_up", isActive: true, defaultDurationMinutes: 10,
  bufferBeforeMinutes: 1, bufferAfterMinutes: 2, requiresChair: true, requiresProvider: true,
  allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 50, badgeClass: null,
  sortOrder: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01", createdBy: null, updatedBy: null });
const request = (): BookAppointmentInput => ({ patientId: 19, date: "2030-01-15", time: "16:00", durationMinutes: 45,
  serviceId: 81, appointmentType: "follow_up", bookingIntent: "ortho_follow_up", doctorId: 7 });
const actor = { username: "synthetic", role: "reception", channel: "ui" as const };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadCapacityContext).mockResolvedValue({ chairs: 3, shifts: [{ start: "09:00", end: "20:00" }], nearCapacityPercent: 80, emergencyReserveMinutes: 0, newPatientDailyLimit: 0 });
  vi.mocked(resolveService).mockResolvedValue(service());
  vi.mocked(writeAppointmentInDay).mockImplementation(async ({ commit }) => ({ ok: true, value: await commit({} as never) }));
  vi.mocked(insertAppointmentOnClient).mockResolvedValue({ id: 101 } as never);
  vi.mocked(requireSession).mockResolvedValue({ username: "synthetic", role: "reception", userId: 1, expiresAt: Date.now() + 60_000 });
  vi.mocked(findUserByUsername).mockResolvedValue(null);
});

describe("untouched board intent validates the exact resolved scheduling service", () => {
  it.each(["removed", "inactive", "specialty", "code", "legacy", "wrong_id", "invalid_duration"])("rejects %s catalogue identity before the writer", async (change) => {
    const resolved = service();
    if (change === "inactive") resolved.isActive = false;
    if (change === "specialty") resolved.specialty = "endodontics";
    if (change === "code") resolved.code = "ORTHO_START";
    if (change === "legacy") resolved.legacyType = "consultation";
    if (change === "wrong_id") resolved.id = 82;
    if (change === "invalid_duration") resolved.defaultDurationMinutes = 0;
    vi.mocked(resolveService).mockResolvedValue(change === "removed" ? null : resolved);
    expect(await bookAppointment(request(), actor)).toEqual({ ok: false, status: 400, message: FOLLOWUP_SERVICE_REVIEW_MESSAGE });
    expect(resolveService).toHaveBeenCalledTimes(1); expect(writeAppointmentInDay).not.toHaveBeenCalled();
    expect(insertAppointmentOnClient).not.toHaveBeenCalled();
  });
  it.each([null, undefined])("rejects absent explicit service %s even if the real legacy resolver would find a row", async (serviceId) => {
    expect(await bookAppointment({ ...request(), serviceId }, actor)).toMatchObject({ ok: false, status: 400 });
    expect(writeAppointmentInDay).not.toHaveBeenCalled();
  });
  it("rejects contrary appointment type under protected intent", async () => {
    expect(await bookAppointment({ ...request(), appointmentType: "consultation" }, actor)).toMatchObject({ ok: false, status: 400 });
    expect(writeAppointmentInDay).not.toHaveBeenCalled();
  });
  it.each(["follow_up", null])("persists the same validated service without re-resolving (legacy %s)", async (legacyType) => {
    vi.mocked(resolveService).mockResolvedValueOnce({ ...service(), legacyType }).mockResolvedValue(null);
    expect(await bookAppointment(request(), actor)).toMatchObject({ ok: true });
    expect(resolveService).toHaveBeenCalledTimes(1);
    expect(insertAppointmentOnClient).toHaveBeenCalledWith({}, expect.objectContaining({ patientId: 19, serviceId: 81,
      appointmentType: "follow_up", durationMinutes: 45, doctorId: 7, bufferBeforeMinutes: 1, bufferAfterMinutes: 2 }));
  });
  it("leaves explicit manual choices and generic entrypoints on their existing path", async () => {
    vi.mocked(resolveService).mockResolvedValue({ ...service(), specialty: "endodontics", legacyType: "endo", code: "ENDO" });
    expect(await bookAppointment({ ...request(), bookingIntent: undefined, appointmentType: "endo" }, actor)).toMatchObject({ ok: true });
    expect(writeAppointmentInDay).toHaveBeenCalledTimes(1);
  });
  it("forwards protected intent through the actual HTTP handler and refuses a stale resolved service", async () => {
    vi.mocked(resolveService).mockResolvedValue({ ...service(), specialty: "endodontics" });
    const result = await POST(new Request("http://example.test/api/appointments", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(request()) }));
    expect(result.status).toBe(400); expect(await result.json()).toEqual({ message: FOLLOWUP_SERVICE_REVIEW_MESSAGE });
    expect(writeAppointmentInDay).not.toHaveBeenCalled();
  });
});
