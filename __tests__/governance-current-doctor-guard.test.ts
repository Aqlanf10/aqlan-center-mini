import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "@/lib/auth";
const mocks = vi.hoisted(() => ({ user: vi.fn(), owns: vi.fn(), today: vi.fn() }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", ensureSchema: vi.fn(), getPool: vi.fn(),
  doctorOwnsPatient: mocks.owns, findUserByUsername: mocks.user, patientHasVisitToday: mocks.today,
}));
import { canAccessPatient } from "@/lib/patient-access";

const session: SessionPayload = {
  userId: 7, username: "synthetic-doctor", role: "doctor", partyId: 7,
  expiresAt: Date.now() + 60000,
};
const current = {
  id: 7, username: "synthetic-doctor", role: "doctor", isActive: true, partyId: 7,
  permissions: { canViewXrays: true, canViewAllPatients: true },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue(current);
  mocks.owns.mockResolvedValue(true);
});
describe("governance: current doctor identity remains bound to clinical access", () => {
  it.each([{ id: 8 }, { username: "synthetic-other" }, { role: "reception" }, { isActive: false }])(
    "rejects changed identity even with broad grants: %j", async change => {
      mocks.user.mockResolvedValue({ ...current, ...change });
      expect(await canAccessPatient(session, 91, "canViewXrays")).toBe(false);
      expect(mocks.owns).not.toHaveBeenCalled();
    },
  );
  it.each([null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid party link: %s", async partyId => {
      mocks.user.mockResolvedValue({ ...current, partyId, permissions: { canViewXrays: true } });
      expect(await canAccessPatient(session, 91, "canViewXrays")).toBe(false);
      expect(mocks.owns).not.toHaveBeenCalled();
    },
  );
  it("retains separate image grant and valid ownership", async () => {
    mocks.user.mockResolvedValue({ ...current, permissions: { canViewAllPatients: true } });
    expect(await canAccessPatient(session, 91, "canViewXrays")).toBe(false);
    mocks.user.mockResolvedValue({ ...current, permissions: { canViewXrays: true } });
    expect(await canAccessPatient(session, 91, "canViewXrays")).toBe(true);
    expect(mocks.owns).toHaveBeenCalledExactlyOnceWith(7, 91);
    mocks.user.mockResolvedValue(current);
    expect(await canAccessPatient(session, 91, "canViewXrays")).toBe(true);
  });
});
