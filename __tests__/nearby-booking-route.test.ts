import { beforeEach, describe, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), book: vi.fn(), user: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: deps.session }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: deps.access }));
vi.mock("../lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", findUserByUsername: deps.user }));
vi.mock("../lib/book-appointment", () => ({ bookAppointment: deps.book }));
import { POST } from "../app/api/appointments/route";
import { parsePlannedRebookIntent } from "../lib/planned-visit-rebooking-contract";
const request = (extra = {}) => new Request("http://localhost/api/appointments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patientId: 19, date: "2026-12-23", time: "16:00", ...extra }) });
const conflict = { kind: "nearby_patient_appointments", message: "Existing appointment", confirmationToken: "signed-synthetic-token", nearbyAppointments: [{ id: 3, scheduledDate: "2026-12-24", scheduledTime: "16:00", doctorName: "Synthetic doctor" }] };
beforeEach(() => { vi.clearAllMocks(); deps.session.mockResolvedValue({ username: "synthetic", userId: 71, role: "reception" }); deps.access.mockResolvedValue(true); deps.user.mockResolvedValue(null); deps.book.mockResolvedValue({ ok: false, status: 409, conflict }); });
describe("nearby booking route boundary", () => {
  it("passes explicit confirmation, preserving the distinct warning response", async () => {
    const response = await POST(request({ nearbyAppointmentConfirmation: "signed-synthetic-token" }));
    expect(response.status).toBe(409); expect(await response.json()).toEqual(conflict);
    expect(deps.book.mock.calls[0][0].nearbyAppointmentConfirmation).toBe("signed-synthetic-token");
    expect(deps.book.mock.calls[0][1].username).toBe("synthetic");
    expect(deps.book.mock.calls[0][1].userId).toBe(71);
  });
  it("never looks up appointments for anonymous users", async () => { deps.session.mockResolvedValue(null); expect((await POST(request())).status).toBe(401); expect(deps.book).not.toHaveBeenCalled(); });
  it("refuses an inaccessible patient before loading appointment details", async () => { deps.access.mockResolvedValue(false); expect((await POST(request())).status).toBe(403); expect(deps.book).not.toHaveBeenCalled(); });
  it("bounds the confirmation field", async () => { await POST(request({ nearbyAppointmentConfirmation: "x".repeat(5000) })); expect(deps.book.mock.calls[0][0].nearbyAppointmentConfirmation.length).toBeLessThanOrEqual(4096); });
});
describe("planned rebook confirmation parsing", () => {
 const body = { expectedAppointmentId: 12, expectedGeneration: "a".repeat(32), date: "2026-12-23", time: "16:00", reason: "Synthetic reason", requestId: "synthetic-rebook-attempt-1" };
 it("accepts only a bounded opaque optional token without expanding booking authority", () => {
   expect(parsePlannedRebookIntent(10, { ...body, nearbyAppointmentConfirmation: "signed-token" })?.nearbyAppointmentConfirmation).toBe("signed-token");
   expect(parsePlannedRebookIntent(10, { ...body, nearbyAppointmentConfirmation: "x".repeat(4097) })).toBeNull();
   expect(parsePlannedRebookIntent(10, { ...body, nearbyAppointmentConfirmation: true })).toBeNull();
   expect(parsePlannedRebookIntent(10, { ...body, patientId: 99 })).toBeNull();
 });
});
