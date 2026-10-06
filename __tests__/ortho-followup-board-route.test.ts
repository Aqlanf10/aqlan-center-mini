import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("../lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", orthoFollowupBoard: vi.fn(), findUserByUsername: vi.fn(), doctorOwnedPatientIds: vi.fn(),
}));
import { GET } from "../app/api/ortho/followups/route";
import { requireSession } from "../lib/session";
import { doctorOwnedPatientIds, findUserByUsername, orthoFollowupBoard } from "../lib/db";
import type { OrthoFollowupRow } from "../lib/db";

const session = vi.mocked(requireSession);
const board = vi.mocked(orthoFollowupBoard);
const user = vi.mocked(findUserByUsername);
const owned = vi.mocked(doctorOwnedPatientIds);
const row = (patientId: number): OrthoFollowupRow => ({
  caseId: patientId + 100, patientId, patientName: `Patient ${patientId}`, patientPhone: "770123456",
  status: "active", phase: "aligning", startDate: "2026-01-01", lastAdjustmentDate: "2026-09-01",
  nextWeeks: 4, upperWire: null, lowerWire: null, nextAppointment: null, lastWasNoShow: false,
  bookingContext: { verified: true, pastUnresolvedAppointment: null, reviewAppointments: [{
    id: patientId + 200, date: "2026-10-07", time: "10:30", status: "booked",
    serviceName: `Service ${patientId}`, doctorName: `Doctor ${patientId}`, reason: "untyped_legacy",
  }], otherAppointments: [] },
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T21:30:00Z"));
  session.mockResolvedValue({ username: "synthetic", userId: 7, role: "doctor", partyId: 7, expiresAt: Date.now() + 60_000 });
  board.mockResolvedValue([row(10), row(20)]);
  user.mockResolvedValue({ permissions: { canViewAllPatients: false } } as NonNullable<Awaited<ReturnType<typeof findUserByUsername>>>);
  owned.mockResolvedValue(new Set([10]));
});
afterEach(() => { vi.useRealTimers(); });

describe("existing board API visibility with additive appointment context", () => {
  it("requires a session before loading any board context", async () => {
    session.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(board).not.toHaveBeenCalled();
  });
  it("preserves doctor ownership filtering, including nested booking labels", async () => {
    const response = await GET();
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.today).toBe("2026-10-06");
    expect(board).toHaveBeenCalledWith("2026-10-06");
    expect(owned).toHaveBeenCalledWith(7, [10, 20]);
    expect(JSON.stringify(payload)).toContain("Service 10");
    expect(JSON.stringify(payload)).not.toContain("Patient 20");
    expect(JSON.stringify(payload)).not.toContain("Service 20");
    expect(JSON.stringify(payload)).not.toContain("Doctor 20");
  });
  it.each(["admin", "reception"] as const)("preserves authorized %s board access", async (role) => {
    session.mockResolvedValue({ username: "synthetic", userId: 7, role, partyId: null, expiresAt: Date.now() + 60_000 });
    const payload = await (await GET()).json();
    expect(JSON.stringify(payload)).toContain("Service 10");
    expect(JSON.stringify(payload)).toContain("Service 20");
    expect(owned).not.toHaveBeenCalled();
  });
  it("preserves explicit canViewAllPatients while not redefining case ownership", async () => {
    user.mockResolvedValue({ permissions: { canViewAllPatients: true } } as NonNullable<Awaited<ReturnType<typeof findUserByUsername>>>);
    expect(JSON.stringify(await (await GET()).json())).toContain("Service 20");
    expect(owned).not.toHaveBeenCalled();
  });
  it("does not turn a failed projection query into an empty successful board", async () => {
    board.mockRejectedValue(new Error("Synthetic projection unavailable"));
    const response = await GET();
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("buckets");
  });
});
