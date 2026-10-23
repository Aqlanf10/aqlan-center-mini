import { beforeEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({
  requireSession: vi.fn(), listAppointmentsByDate: vi.fn(), findUserByUsername: vi.fn(),
  doctorOwnedPatientIds: vi.fn(), labWorkForPatients: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/db", () => ({ ...boundary, CLINIC_TIME_ZONE: "America/Los_Angeles" }));
vi.mock("@/lib/book-appointment", () => ({ bookAppointment: vi.fn() }));
import { GET } from "../app/api/appointments/route";

const list = [
  { id: 1, patientId: 31, doctorId: 9 }, { id: 2, patientId: 32, doctorId: null },
  { id: 3, patientId: 33, doctorId: 10 }, { id: 4, patientId: 34, doctorId: 10 },
];
const get = () => GET(new Request("http://test.invalid/api/appointments?date=2026-10-22"));
beforeEach(() => {
  vi.resetAllMocks();
  boundary.requireSession.mockResolvedValue({ username: "synthetic-staff", role: "reception" });
  boundary.listAppointmentsByDate.mockResolvedValue(list);
  boundary.labWorkForPatients.mockResolvedValue([]);
  boundary.findUserByUsername.mockResolvedValue({ partyId: 9, permissions: {} });
  boundary.doctorOwnedPatientIds.mockResolvedValue(new Set([33]));
});

describe("canonical zone on the unchanged appointment-list response", () => {
  it.each(["admin", "reception"])("preserves the %s array body and adds the canonical zone header", async (role) => {
    boundary.requireSession.mockResolvedValue({ username: "synthetic-staff", role });
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Clinic-Time-Zone")).toBe("America/Los_Angeles");
    expect(await response.json()).toEqual(list);
  });

  it.each(["restricted", "unlinked", "all"])("keeps %s doctor filtering unchanged while providing its display zone", async (scope) => {
    boundary.requireSession.mockResolvedValue({ username: "synthetic-doctor", role: "doctor" });
    boundary.findUserByUsername.mockResolvedValue(scope === "unlinked" ? null
      : { partyId: 9, permissions: { canViewAllAppointments: scope === "all" } });
    const response = await get();
    expect(response.headers.get("X-Clinic-Time-Zone")).toBe("America/Los_Angeles");
    expect(await response.json()).toEqual(scope === "unlinked" ? [] : scope === "all" ? list : list.slice(0, 3));
  });

  it("does not change failed-request status or expose an appointment payload", async () => {
    boundary.requireSession.mockResolvedValue(null);
    const unauthorized = await get();
    expect(unauthorized.status).toBe(401); expect(unauthorized.headers.has("X-Clinic-Time-Zone")).toBe(false);
    expect(boundary.listAppointmentsByDate).not.toHaveBeenCalled();
    boundary.requireSession.mockResolvedValue({ username: "synthetic-staff", role: "reception" });
    expect((await GET(new Request("http://test.invalid/api/appointments?date=bad"))).status).toBe(400);
    boundary.listAppointmentsByDate.mockRejectedValue(new Error("Synthetic failure"));
    expect((await get()).status).toBe(500);
  });
});
