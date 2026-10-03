import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "../lib/auth";

// Mocked, patient-linked reads only. This does not start a server or database.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), user: vi.fn(), ownedIds: vi.fn(), owns: vi.fn(), todayVisit: vi.fn(),
  list: vi.fn(), create: vi.fn(), createInternal: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db", () => ({
  findUserByUsername: mocks.user, doctorOwnedPatientIds: mocks.ownedIds,
  doctorOwnsPatient: mocks.owns, patientHasVisitToday: mocks.todayVisit,
  listPatientReferralsForRead: mocks.list, createReferral: mocks.create, createInternalReferral: mocks.createInternal,
}));
import { GET } from "../app/api/patients/[id]/referrals/route";

const session: SessionPayload = { userId: 10, username: "synthetic-doctor", role: "doctor", partyId: 7, expiresAt: 0 };
const request = new Request("http://test.invalid/api/patients/91/referrals");
const context = { params: Promise.resolve({ id: "91" }) };
const row = { id: 41, patientId: 91, reason: "Synthetic preserved reason", status: "sent", appointmentVisibility: "scoped" };
function doctor(permissions: Record<string, boolean> = {}) {
  mocks.session.mockResolvedValue(session);
  mocks.user.mockResolvedValue({ isActive: true, partyId: 7, permissions: {
    canViewAllPatients: true, canViewAllAppointments: false, ...permissions,
  } });
}
beforeEach(() => {
  vi.clearAllMocks(); doctor();
  mocks.ownedIds.mockResolvedValue(new Set()); mocks.owns.mockResolvedValue(false);
  mocks.todayVisit.mockResolvedValue(true); mocks.list.mockResolvedValue([row]);
});

describe("patient referral GET uses the shared calendar reader after patient access", () => {
  it("keeps the response array and separates all-patient access from all-calendar access", async () => {
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([row]);
    expect(mocks.ownedIds).toHaveBeenCalledWith(7, [91]);
    expect(mocks.list).toHaveBeenCalledWith(91, { kind: "doctor", doctorPartyId: 7, ownedPatientIds: new Set() });
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.createInternal).not.toHaveBeenCalled();
  });
  it("passes the canonical owned-patient exception through unchanged", async () => {
    mocks.ownedIds.mockResolvedValue(new Set([91]));
    expect((await GET(request, context)).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(91, { kind: "doctor", doctorPartyId: 7, ownedPatientIds: new Set([91]) });
  });
  it("respects the separate explicit all-calendar grant", async () => {
    doctor({ canViewAllAppointments: true });
    expect((await GET(request, context)).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(91, { kind: "all" });
    expect(mocks.ownedIds).not.toHaveBeenCalled();
  });
  it.each(["admin", "reception"])("preserves %s calendar scope", async (role) => {
    mocks.session.mockResolvedValue({ ...session, role });
    expect((await GET(request, context)).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(91, { kind: "all" });
  });
  it("does not turn calendar permission into access to a different patient", async () => {
    doctor({ canViewAllPatients: false, canViewAllAppointments: true });
    expect((await GET(request, context)).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.ownedIds).not.toHaveBeenCalled();
  });
  it("retains the canonical ownership failure behavior without broadening metadata", async () => {
    mocks.ownedIds.mockRejectedValue(new Error("Synthetic lookup failure"));
    expect((await GET(request, context)).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(91, { kind: "doctor", doctorPartyId: 7, ownedPatientIds: new Set() });
  });
  it("requires a valid session before reading referral or calendar data", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await GET(request, context)).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.user).not.toHaveBeenCalled();
  });
});
