import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "../lib/auth";
import { parseDoctorPermissions } from "../lib/doctor-permissions";

// Invoke the real handlers and body validation with synthetic data only.
// All persistence and session boundaries are mocked; no database is opened.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), user: vi.fn(), create: vi.fn(), update: vi.fn(),
  audit: vi.fn(), opening: vi.fn(), duplicates: vi.fn(), file: vi.fn(),
  owns: vi.fn(), visitToday: vi.fn(), settings: vi.fn(), locked: vi.fn(),
  search: vi.fn(), browse: vi.fn(), delete: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  findUserByUsername: mocks.user,
  createPatient: mocks.create,
  updatePatient: mocks.update,
  recordAudit: mocks.audit,
  setPatientOpeningBalance: mocks.opening,
  duplicateCandidates: mocks.duplicates,
  getPatientFile: mocks.file,
  doctorOwnsPatient: mocks.owns,
  patientHasVisitToday: mocks.visitToday,
  getSettings: mocks.settings,
  isPeriodLocked: mocks.locked,
  searchPatients: mocks.search,
  browsePatients: mocks.browse,
  deletePatientCascade: mocks.delete,
}));
import { POST } from "../app/api/patients/route";
import { PATCH } from "../app/api/patients/[id]/route";

const session: SessionPayload = {
  userId: 10, username: "synthetic-write-doctor", role: "doctor", partyId: 7, expiresAt: 0,
};
const patient = {
  id: 91, patientNumber: "SYNTHETIC-91", fullName: "Synthetic patient before",
  gender: "unknown", phone: null,
};
const fullName = "Synthetic patient after";
function currentDoctor(permissions: unknown = parseDoctorPermissions(null)) {
  return {
    id: session.userId, username: session.username, role: session.role,
    isActive: true, partyId: 7, permissions,
  };
}
function request(method: "POST" | "PATCH") {
  return new Request(`http://test.invalid/api/patients${method === "PATCH" ? "/91" : ""}`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify({ fullName }),
  });
}
function expectNoWrites() {
  for (const writer of [mocks.create, mocks.update, mocks.audit, mocks.opening, mocks.delete]) {
    expect(writer).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue(session);
  mocks.user.mockResolvedValue(currentDoctor());
  mocks.duplicates.mockResolvedValue([]);
  mocks.file.mockResolvedValue({ patient });
  mocks.owns.mockResolvedValue(true);
  mocks.visitToday.mockResolvedValue(true);
  mocks.create.mockResolvedValue({ ...patient, fullName });
  mocks.update.mockResolvedValue({ ...patient, fullName });
});

const cases = [
  { method: "POST" as const, permission: "canAddPatient", status: 201,
    invoke: (req: Request) => POST(req), writer: mocks.create },
  { method: "PATCH" as const, permission: "canEditPatient", status: 200,
    invoke: (req: Request) => PATCH(req, { params: Promise.resolve({ id: "91" }) }), writer: mocks.update },
];

describe.each(cases)("$method patient write authority", ({ method, permission, status, invoke, writer }) => {
  it.each(["missing", "failed"])("rejects a %s trusted-user lookup before consuming the body or writing", async (mode) => {
    if (mode === "missing") mocks.user.mockResolvedValue(null);
    else mocks.user.mockRejectedValue(new Error("Synthetic lookup failure"));
    const req = request(method);
    const response = await invoke(req);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: expect.any(String) });
    expect(req.bodyUsed).toBe(false);
    expect(mocks.user).toHaveBeenCalledExactlyOnceWith(session.username);
    expect(mocks.owns).not.toHaveBeenCalled();
    expect(mocks.file).not.toHaveBeenCalled();
    expect(mocks.duplicates).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("keeps the explicit permission refusal before any write", async () => {
    mocks.user.mockResolvedValue(currentDoctor({ ...parseDoctorPermissions(null), [permission]: false }));
    expect((await invoke(request(method))).status).toBe(403);
    expectNoWrites();
  });

  it.each([
    ["explicit grant", { canAddPatient: true, canEditPatient: true }],
    ["normalized defaults", parseDoctorPermissions(null)],
    ["absent permissions", undefined],
    ["null permissions", null],
    ["unspecified flags", {}],
  ])("preserves the existing %s permission rules for a present user", async (_label, permissions) => {
    const user = currentDoctor();
    user.permissions = permissions;
    mocks.user.mockResolvedValue(user);
    const response = await invoke(request(method));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ id: patient.id, fullName });
    expect(writer).toHaveBeenCalledTimes(1);
    if (method === "POST") {
      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ fullName }));
      expect(mocks.update).not.toHaveBeenCalled();
    } else {
      expect(mocks.owns).toHaveBeenCalledExactlyOnceWith(7, patient.id);
      expect(mocks.update).toHaveBeenCalledWith(patient.id, expect.objectContaining({ fullName }));
      expect(mocks.create).not.toHaveBeenCalled();
    }
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.opening).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it.each(["admin", "reception", "assistant"] as const)("preserves the existing %s role path", async (role) => {
    mocks.session.mockResolvedValue({ ...session, role });
    mocks.user.mockRejectedValue(new Error("Doctor-only lookup must not run"));
    expect((await invoke(request(method))).status).toBe(status);
    expect(mocks.user).not.toHaveBeenCalled();
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it("still rejects an absent session", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await invoke(request(method))).status).toBe(401);
    expect(mocks.user).not.toHaveBeenCalled();
    expectNoWrites();
  });
});

describe("PATCH patient access remains independent of edit permission", () => {
  it("rejects a non-owned patient even with explicit edit and all-patient view grants", async () => {
    mocks.user.mockResolvedValue(currentDoctor({ canEditPatient: true, canViewAllPatients: true }));
    mocks.owns.mockResolvedValue(false);
    expect((await PATCH(request("PATCH"), { params: Promise.resolve({ id: "91" }) })).status).toBe(403);
    expect(mocks.owns).toHaveBeenCalledExactlyOnceWith(7, patient.id);
    expectNoWrites();
  });
});
