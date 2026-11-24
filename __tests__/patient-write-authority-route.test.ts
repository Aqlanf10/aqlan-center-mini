import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "../lib/auth";
import { restrictedRouteAllowed } from "../lib/role-routes";
import { parseDoctorPermissions } from "../lib/doctor-permissions";

// Invoke the real handlers and body validation with synthetic data only.
// All persistence and session boundaries are mocked; no database is opened.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), user: vi.fn(), create: vi.fn(), update: vi.fn(),
  audit: vi.fn(), opening: vi.fn(), patient: vi.fn(), file: vi.fn(),
  owns: vi.fn(), visitToday: vi.fn(), settings: vi.fn(), locked: vi.fn(),
  search: vi.fn(), browse: vi.fn(), delete: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  findUserByUsername: mocks.user,
  createPatientWithDuplicateReview: mocks.create,
  updatePatient: mocks.update,
  recordAudit: mocks.audit,
  setPatientOpeningBalance: mocks.opening,
  getPatient: mocks.patient,
  getPatientFile: mocks.file,
  doctorOwnsPatient: mocks.owns,
  patientHasVisitToday: mocks.visitToday,
  getSettings: mocks.settings,
  isPeriodLocked: mocks.locked,
  searchPatients: mocks.search,
  browsePatients: mocks.browse,
  deletePatientCascade: mocks.delete,
}));
import { GET, POST } from "../app/api/patients/route";
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
  mocks.patient.mockResolvedValue(patient);
  mocks.file.mockResolvedValue({ patient });
  mocks.owns.mockResolvedValue(true);
  mocks.visitToday.mockResolvedValue(true);
  mocks.create.mockResolvedValue({ ok: true, patient: { ...patient, fullName } });
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
      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ fullName }), false);
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

  it.each(["admin", "reception"] as const)("preserves the existing %s role path", async (role) => {
    mocks.session.mockResolvedValue({ ...session, role });
    mocks.user.mockRejectedValue(new Error("Doctor-only lookup must not run"));
    expect((await invoke(request(method))).status).toBe(status);
    expect(mocks.user).not.toHaveBeenCalled();
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it("does not grant the clinical assistant general patient write access", async () => {
    const req = request(method);
    expect(restrictedRouteAllowed("assistant", new URL(req.url).pathname, method)).toBe(false);
    if (method === "PATCH") {
      mocks.session.mockResolvedValue({ ...session, role: "assistant" });
      const response = await invoke(req);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ message: expect.any(String) });
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(req.bodyUsed).toBe(false);
      expect(mocks.file).not.toHaveBeenCalled();
      expect(mocks.visitToday).not.toHaveBeenCalled();
      expect(mocks.owns).not.toHaveBeenCalled();
      expect(mocks.user).not.toHaveBeenCalled();
      expectNoWrites();
    }
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

describe("reception contact maintenance", () => {
  it("saves a contact-only change and returns an administrative acknowledgement", async () => {
    const email = "reception-edit@example.invalid";
    const before = { ...patient, email: null, medicalAlert: "synthetic alert", note: "synthetic note", photoDocumentId: 12 };
    mocks.session.mockResolvedValue({ ...session, role: "reception" });
    mocks.patient.mockResolvedValue(before);
    mocks.update.mockResolvedValue({ ...before, email });
    const req = new Request("http://test.invalid/api/patients/91", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }),
    });
    const response = await PATCH(req, { params: Promise.resolve({ id: "91" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...patient, email });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith(patient.id, { email });
    expect(mocks.file).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });
});

describe("ordinary receptionist and clinician writes to the same synthetic file", () => {
  const context = { params: Promise.resolve({ id: String(patient.id) }) };
  const patch = (body: Record<string, unknown>) => PATCH(new Request("http://test.invalid/api/patients/91", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), context);
  const reception = { ...session, username: "synthetic-front-desk", role: "reception" as const };

  it("keeps the newer clinician changes when a delayed reception address save finishes", async () => {
    let row = { ...patient, address: "Old synthetic address", referralSource: "Synthetic referral",
      medicalAlert: "Previous synthetic alert", note: "Previous synthetic note" };
    let allowReceptionWrite!: () => void;
    let receptionRead!: () => void;
    const paused = new Promise<void>((resolve) => { allowReceptionWrite = resolve; });
    const started = new Promise<void>((resolve) => { receptionRead = resolve; });
    mocks.session.mockResolvedValue(reception);
    const delayedReceptionRead = async () => {
      const snapshot = { ...row };
      receptionRead();
      await paused;
      return snapshot;
    };
    let clinicianStarted = false;
    mocks.patient.mockImplementation(delayedReceptionRead);
    mocks.file.mockImplementation(async () => ({ patient: clinicianStarted ? { ...row } : await delayedReceptionRead() }));
    // Model the existing partial DB writer: only supplied keys replace values.
    mocks.update.mockImplementation(async (_id: number, writes: Partial<typeof row>) => {
      row = { ...row, ...writes }; return { ...row };
    });
    const pending = patch({ address: "New synthetic address" });
    await started;
    try {
      clinicianStarted = true;
      mocks.session.mockResolvedValue(session);
      expect((await patch({ medicalAlert: "New synthetic alert", note: "New synthetic clinician note" })).status).toBe(200);
    } finally { allowReceptionWrite(); }
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const result = await response.json();
    expect(result).toMatchObject({ address: "New synthetic address", referralSource: "Synthetic referral" });
    expect(result).not.toHaveProperty("medicalAlert");
    expect(result).not.toHaveProperty("note");
    expect(row).toMatchObject({ address: "New synthetic address", referralSource: "Synthetic referral",
      medicalAlert: "New synthetic alert", note: "New synthetic clinician note" });
    expect(mocks.update).toHaveBeenLastCalledWith(patient.id, { address: "New synthetic address" });
    expect(mocks.file).toHaveBeenCalledTimes(1); // only the authorized clinician used the full file
    const auditEvent = mocks.audit.mock.calls.find(([event]) => event.actor === reception.username)?.[0];
    expect(auditEvent?.details).toEqual({ "العنوان": { "قبل": "Old synthetic address", "بعد": "New synthetic address" } });
  });

  it("never copies the old birth date/year into a date or year-only write", async () => {
    mocks.session.mockResolvedValue(reception);
    mocks.patient.mockResolvedValue({ ...patient, birthYear: 2001, birthDate: "2001-07-12" });
    expect((await patch({ birthYear: "2002" })).status).toBe(200);
    expect(mocks.update).toHaveBeenLastCalledWith(patient.id, { birthYear: 2002 }, { reconcileYearOnlyBirthDate: true });
    expect((await patch({ birthDate: "2002-01-17" })).status).toBe(200);
    expect(mocks.update).toHaveBeenLastCalledWith(patient.id, { birthDate: "2002-01-17", birthYear: 2002 });
    expect((await patch({ birthDate: "" })).status).toBe(200);
    expect(mocks.update).toHaveBeenLastCalledWith(patient.id, { birthDate: null });
  });
});

describe("POST patient creation route boundary", () => {
  it.each(["assistant", "cashier", "accountant"] as const)("denies direct registration for %s before reading the body", async (role) => {
    mocks.session.mockResolvedValue({ ...session, role });
    const req = request("POST");
    const response = await POST(req);
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(req.bodyUsed).toBe(false);
    expect(mocks.user).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it.each([
    { id: 11 }, { username: "different-synthetic-doctor" },
    { role: "reception" }, { isActive: false },
  ])("rejects changed doctor identity before registration: %j", async (change) => {
    mocks.user.mockResolvedValue({ ...currentDoctor(), ...change });
    const req = request("POST");
    const response = await POST(req);
    expect(response.status).toBe(401);
    expect(req.bodyUsed).toBe(false);
    expectNoWrites();
  });
});

describe("patient collection cache boundary", () => {
  it.each(["?q=Synthetic", ""])("keeps receptionist GET responses private and administrative: %s", async (query) => {
    mocks.session.mockResolvedValue({ ...session, role: "reception" });
    const clinical = { ...patient, note: "synthetic clinical note", medicalAlert: "synthetic alert" };
    mocks.search.mockResolvedValue([clinical]);
    mocks.browse.mockResolvedValue({ rows: [clinical], total: 1 });
    const response = await GET(new Request("http://test.invalid/api/patients" + query));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    const rows = query ? body : body.rows;
    expect(rows).toEqual([{ id: patient.id, patientNumber: patient.patientNumber, fullName: patient.fullName, phone: patient.phone }]);
  });

  it("marks successful creation and unauthorized reads as private", async () => {
    const created = await POST(request("POST"));
    expect(created.status).toBe(201);
    expect(created.headers.get("Cache-Control")).toBe("private, no-store");
    mocks.session.mockResolvedValue(null);
    const denied = await GET(new Request("http://test.invalid/api/patients"));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each([["malformed", 400], ["oversized", 413]])("marks %s body errors as private before writes", async (mode, status) => {
    const req = new Request("http://test.invalid/api/patients", {
      method: "POST",
      headers: { "content-type": "application/json", ...(mode === "oversized" ? { "content-length": "999999999" } : {}) },
      body: "{",
    });
    const response = await POST(req);
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expectNoWrites();
  });

  it("marks search failures as private", async () => {
    mocks.search.mockRejectedValue(new Error("synthetic search failure"));
    const response = await GET(new Request("http://test.invalid/api/patients?q=Synthetic"));
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
