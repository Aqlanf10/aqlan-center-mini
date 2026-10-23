import { beforeEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({
  requireSession: vi.fn(), getAppointment: vi.fn(), canAccessPatient: vi.fn(),
  query: vi.fn(), ensureSchema: vi.fn(), markReminderSent: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: boundary.canAccessPatient }));
vi.mock("@/lib/db", () => ({ ...boundary, getPool: () => ({ query: boundary.query }) }));
vi.mock("@/lib/waiting-list-match", () => ({ findWaitingCandidatesForSlot: vi.fn() }));
vi.mock("@/lib/book-appointment", () => ({ rescheduleAppointment: vi.fn() }));
import { PATCH } from "../app/api/appointments/[id]/route";
import { readManualReminderSnapshot, STALE_MANUAL_REMINDER_MESSAGE } from "../lib/manual-appointment-reminder";

const snapshot = {
  patientId: 31, patientName: "Synthetic reminder patient", patientPhone: "770123456",
  scheduledDate: "2026-10-22", scheduledTime: "10:00", status: "booked",
};
const request = (body: unknown) => new Request("http://test.invalid/api/appointments/7", {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const patch = (...values: unknown[]) => PATCH(request({ action: "reminded", snapshot: values.length ? values[0] : snapshot }), { params: Promise.resolve({ id: "7" }) });
beforeEach(() => {
  vi.resetAllMocks();
  boundary.requireSession.mockResolvedValue({ username: "synthetic-staff", role: "reception" });
  boundary.getAppointment.mockResolvedValue({ id: 7, ...snapshot });
  boundary.canAccessPatient.mockResolvedValue(true);
  boundary.query.mockResolvedValue({ rowCount: 1 });
});

describe("bounded displayed reminder snapshot", () => {
  it.each([
    undefined, null, [], {}, { ...snapshot, patientId: "31" }, { ...snapshot, patientId: 0 },
    { ...snapshot, patientId: Number.MAX_SAFE_INTEGER + 1 }, { ...snapshot, patientName: "" },
    { ...snapshot, patientName: "x".repeat(501) }, { ...snapshot, patientPhone: "x".repeat(101) },
    { ...snapshot, patientPhone: undefined }, { ...snapshot, patientPhone: 770123456 },
    { ...snapshot, scheduledDate: "2026-02-30" }, { ...snapshot, scheduledDate: "2026-2-03" },
    { ...snapshot, scheduledDate: "0000-01-01" }, { ...snapshot, scheduledTime: "24:00" },
    { ...snapshot, scheduledTime: "10:60" }, { ...snapshot, scheduledTime: "10:00:00" },
    { ...snapshot, status: "cancelled" }, { ...snapshot, status: "arrived" }, { ...snapshot, status: "done" },
  ])("refuses malformed context without database writes: %j", async (value) => {
    expect(readManualReminderSnapshot(value)).toBeNull();
    expect((await patch(value)).status).toBe(400);
    expect(boundary.query).not.toHaveBeenCalled();
  });

  it("requires a snapshot, including for an older client", async () => {
    const response = await PATCH(request({ action: "reminded" }), { params: Promise.resolve({ id: "7" }) });
    expect(response.status).toBe(400); expect(boundary.query).not.toHaveBeenCalled();
  });

  it.each(["booked", "no_show"])("accepts current %s context, including a null phone", async (status) => {
    expect((await patch({ ...snapshot, patientPhone: null, status })).status).toBe(200);
    expect(boundary.query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("UPDATE appointments"),
      [7, 31, "2026-10-22", "10:00", status, snapshot.patientName, null]);
    expect(boundary.markReminderSent).not.toHaveBeenCalled();
  });
});

describe("manual reminder authorized conditional write", () => {
  it.each(["admin", "reception", "doctor"])("preserves the resource authorization chain for %s", async (role) => {
    const session = { username: "synthetic-staff", role };
    boundary.requireSession.mockResolvedValue(session);
    expect((await patch()).status).toBe(200);
    expect(boundary.getAppointment).toHaveBeenCalledExactlyOnceWith(7);
    expect(boundary.canAccessPatient).toHaveBeenCalledExactlyOnceWith(session, 31);
    expect(boundary.query.mock.calls[0][1][1]).toBe(31);
  });

  it("rejects a foreign patient before parsing any snapshot", async () => {
    boundary.canAccessPatient.mockResolvedValue(false);
    expect((await patch(null)).status).toBe(404);
    expect(boundary.query).not.toHaveBeenCalled();
  });

  it("does not let an untrusted snapshot replace the patient bound by authorization", async () => {
    expect((await patch({ ...snapshot, patientId: 99 })).status).toBe(409);
    expect(boundary.canAccessPatient).toHaveBeenCalledWith(expect.anything(), 31);
    expect(boundary.query).not.toHaveBeenCalled();
  });

  it("returns a recoverable conflict when the atomic update rejects a changed row", async () => {
    boundary.query.mockResolvedValue({ rowCount: 0 });
    const response = await patch();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: STALE_MANUAL_REMINDER_MESSAGE });
    expect(boundary.query).toHaveBeenCalledOnce(); // No retry with freshly read fields.
  });

  it("keeps ordinary identical retries valid rather than using reminder time as a version", async () => {
    expect((await patch()).status).toBe(200); expect((await patch()).status).toBe(200);
    expect(boundary.query).toHaveBeenCalledTimes(2);
  });

  it("does not claim success on a write failure", async () => {
    boundary.query.mockRejectedValue(new Error("Synthetic database failure"));
    expect((await patch()).status).toBe(500); expect(boundary.query).toHaveBeenCalledOnce();
  });

  it("rejects an expired session without a resource lookup or write", async () => {
    boundary.requireSession.mockResolvedValue(null);
    expect((await patch()).status).toBe(401);
    expect(boundary.getAppointment).not.toHaveBeenCalled(); expect(boundary.query).not.toHaveBeenCalled();
  });

  it("preserves missing-resource and invalid-ID behavior", async () => {
    boundary.getAppointment.mockResolvedValue(null);
    expect((await patch()).status).toBe(404);
    expect((await PATCH(request({ action: "reminded", snapshot }), { params: Promise.resolve({ id: "-1" }) })).status).toBe(400);
    expect(boundary.query).not.toHaveBeenCalled();
  });
});
