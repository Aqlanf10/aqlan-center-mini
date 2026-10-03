import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "../lib/auth";
import { canReadAppointment, patientAppointmentReadParameters, patientAppointmentVisibility, type AppointmentReadScope } from "../lib/appointment-read-scope";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), user: vi.fn(), ownedIds: vi.fn(), owns: vi.fn(), todayVisit: vi.fn(),
  file: vi.fn(), appointments: vi.fn(), lab: vi.fn(), update: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", findUserByUsername: mocks.user,
  doctorOwnedPatientIds: mocks.ownedIds, doctorOwnsPatient: mocks.owns,
  patientHasVisitToday: mocks.todayVisit, getPatientFile: mocks.file,
  listAppointmentsByDate: mocks.appointments, labWorkForPatients: mocks.lab,
  updatePatient: mocks.update,
}));
import { resolveAppointmentReadScope } from "../lib/appointment-read-access";
import { GET as calendarGet } from "../app/api/appointments/route";
import { GET as patientGet, PATCH as patientPatch } from "../app/api/patients/[id]/route";

const patientId = 91;
const doctorSession: SessionPayload = { userId: 10, username: "synthetic-doctor", role: "doctor", partyId: 7, expiresAt: 0 };
const ctx = { params: Promise.resolve({ id: String(patientId) }) };
const rows = [
  { id: 101, patientId, doctorId: null },
  { id: 102, patientId, doctorId: 8 },
  { id: 103, patientId: 92, doctorId: 7 },
  { id: 104, patientId: 93, doctorId: 8 },
];
function doctor(permissions: Record<string, boolean> = {}) {
  mocks.session.mockResolvedValue(doctorSession);
  mocks.user.mockResolvedValue({ isActive: true, partyId: 7, permissions: {
    canViewAllPatients: true, canViewAllAppointments: false, ...permissions,
  } });
}
beforeEach(() => {
  vi.clearAllMocks(); doctor();
  mocks.ownedIds.mockResolvedValue(new Set([93]));
  mocks.owns.mockResolvedValue(false); mocks.todayVisit.mockResolvedValue(true);
  mocks.file.mockResolvedValue({ patient: { id: patientId }, visits: [], appointments: [] });
  mocks.appointments.mockResolvedValue(rows); mocks.lab.mockResolvedValue([]);
});

describe("canonical calendar read scope", () => {
  it("preserves unassigned, own-provider and owned-patient rows without treating all-patient access as all-calendar", async () => {
    const scope = await resolveAppointmentReadScope(doctorSession, [91, 92, 93, 91]);
    expect(scope).toEqual({ kind: "doctor", doctorPartyId: 7, ownedPatientIds: new Set([93]) });
    expect(mocks.ownedIds).toHaveBeenCalledWith(7, [91, 92, 93]);
    expect(rows.filter((row) => canReadAppointment(scope, row)).map((row) => row.id)).toEqual([101, 103, 104]);
    const response = await calendarGet(new Request("http://test.invalid/api/appointments?date=2026-10-03"));
    expect(response.status).toBe(200);
    expect((await response.json()).map((row: { id: number }) => row.id)).toEqual([101, 103, 104]);
    expect(mocks.lab).toHaveBeenCalledWith([91, 92, 93]);
  });

  it("keeps the explicit all-appointment grant separate from all-patient access", async () => {
    doctor({ canViewAllPatients: false, canViewAllAppointments: true });
    expect(await resolveAppointmentReadScope(doctorSession, [91])).toEqual({ kind: "all" });
    expect(mocks.ownedIds).not.toHaveBeenCalled();
  });

  it.each(["admin", "reception"])("retains full %s calendar reads", async (role) => {
    expect(await resolveAppointmentReadScope({ ...doctorSession, role }, [91])).toEqual({ kind: "all" });
    expect(mocks.user).not.toHaveBeenCalled();
  });

  it.each(["assistant", "cashier", "accountant"])("reuses the existing role boundary for %s", async (role) => {
    expect(await resolveAppointmentReadScope({ ...doctorSession, role }, [91])).toEqual({ kind: "none" });
    expect(mocks.user).not.toHaveBeenCalled();
  });

  it("preserves the canonical session-party fallback and closes only ownership on lookup failure", async () => {
    mocks.user.mockRejectedValue(new Error("synthetic read failure"));
    mocks.ownedIds.mockRejectedValue(new Error("synthetic read failure"));
    const scope = await resolveAppointmentReadScope(doctorSession, [91]);
    expect(scope).toEqual({ kind: "doctor", doctorPartyId: 7, ownedPatientIds: new Set() });
    expect(canReadAppointment(scope, rows[0])).toBe(true);
    expect(canReadAppointment(scope, rows[1])).toBe(false);
    expect(canReadAppointment(scope, rows[2])).toBe(true);
  });

  it("returns no appointments for an unlinked doctor without an all-calendar grant", async () => {
    mocks.user.mockResolvedValue({ partyId: null, permissions: { canViewAllPatients: true } });
    expect(await resolveAppointmentReadScope({ ...doctorSession, partyId: null }, [91])).toEqual({ kind: "none" });
  });
});

describe("patient-local SQL parameter policy", () => {
  const scoped: AppointmentReadScope = { kind: "doctor", doctorPartyId: 7, ownedPatientIds: new Set([93]) };
  it.each([
    [{ kind: "all" }, 91, [true, null]],
    [{ kind: "none" }, 91, [false, null]],
    [scoped, 91, [false, 7]],
    [scoped, 93, [true, 7]],
  ] as [AppointmentReadScope, number, [boolean, number | null]][])("derives the query grants for %o patient %s", (scope, id, expected) => {
    expect(patientAppointmentReadParameters(scope, id)).toEqual(expected);
  });
  it("distinguishes hidden authority from a permitted subset and from all patient appointments", () => {
    expect(patientAppointmentVisibility({ kind: "none" }, 91)).toBe("hidden");
    expect(patientAppointmentVisibility(scoped, 91)).toBe("scoped");
    expect(patientAppointmentVisibility(scoped, 93)).toBe("all");
    expect(patientAppointmentVisibility({ kind: "all" }, 91)).toBe("all");
  });
  it("does not let a no-calendar scope expose unassigned references", () => {
    expect(canReadAppointment({ kind: "none" }, rows[0])).toBe(false);
  });
});

describe("patient GET only", () => {
  it("passes calendar scope into the database projection after independent patient authorization", async () => {
    const response = await patientGet(new Request("http://test.invalid/api/patients/91"), ctx);
    expect(response.status).toBe(200);
    expect(mocks.ownedIds).toHaveBeenCalledWith(7, [91]);
    expect(mocks.file).toHaveBeenCalledWith(91, { kind: "doctor", doctorPartyId: 7, ownedPatientIds: new Set([93]) });
  });
  it("keeps assistant patient access while passing no-calendar scope", async () => {
    mocks.session.mockResolvedValue({ ...doctorSession, role: "assistant" });
    expect((await patientGet(new Request("http://test.invalid"), ctx)).status).toBe(200);
    expect(mocks.file).toHaveBeenCalledWith(91, { kind: "none" });
  });
  it("does not grant patient access just because the calendar is wide", async () => {
    doctor({ canViewAllPatients: false, canViewAllAppointments: true });
    expect((await patientGet(new Request("http://test.invalid"), ctx)).status).toBe(403);
    expect(mocks.file).not.toHaveBeenCalled();
    expect(mocks.ownedIds).not.toHaveBeenCalled();
  });
  it("does not turn either wide read grant into a patient update grant", async () => {
    doctor({ canViewAllPatients: true, canViewAllAppointments: true, canEditPatient: true });
    const response = await patientPatch(new Request("http://test.invalid", {
      method: "PATCH", body: JSON.stringify({ fullName: "Changed synthetic name" }),
      headers: { "content-type": "application/json" },
    }), ctx);
    expect(response.status).toBe(403);
    expect(mocks.file).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.ownedIds).not.toHaveBeenCalled();
  });
});
