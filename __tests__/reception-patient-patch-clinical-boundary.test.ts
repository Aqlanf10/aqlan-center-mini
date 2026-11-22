import { beforeEach, describe, expect, it, vi } from "vitest";

// Entirely synthetic; never use live patient identifiers or attachments.
const deps = vi.hoisted(() => ({
  session: vi.fn(), file: vi.fn(), update: vi.fn(), user: vi.fn(),
  owns: vi.fn(), visit: vi.fn(), settings: vi.fn(), audit: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: deps.session }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  getPatientFile: deps.file, updatePatient: deps.update,
  findUserByUsername: deps.user, doctorOwnsPatient: deps.owns,
  patientHasVisitToday: deps.visit, getSettings: deps.settings,
  recordAudit: deps.audit,
}));
vi.mock("@/lib/patient", () => ({
  validatePatient: vi.fn((value: unknown) => ({ ok: true, value })),
}));
vi.mock("@/lib/audit-diff", () => ({
  PATIENT_AUDIT_FIELDS: [], auditChanges: vi.fn(() => ({})),
}));

import { PATCH } from "../app/api/patients/[id]/route";

const patientId = 73;
const patient = {
  id: patientId, patientNumber: "SYN-0073", fullName: "Synthetic Test Patient",
  phone: "000000000", altPhone: null, gender: "unknown", birthYear: 2000,
  birthDate: null, address: "Synthetic address", guardianName: null,
  guardianPhone: null, nationalId: "SYN-PRIVATE-ID",
  referralSource: null, referredBy: null, email: null, preferredChannel: null,
  flags: [], createdAt: "2026-01-01", photoDocumentId: 999,
  medicalAlert: "synthetic-secret-allergy", note: "synthetic-secret-clinical-note",
};

const patch = (body: Record<string, unknown>) => PATCH(
  new Request(`http://localhost/api/patients/${patientId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id: String(patientId) }) },
);

beforeEach(() => {
  vi.clearAllMocks();
  deps.session.mockResolvedValue({ role: "reception", username: "synthetic-reception" });
  deps.file.mockResolvedValue({ patient });
  deps.update.mockResolvedValue(patient);
  deps.user.mockResolvedValue({ permissions: {}, partyId: 7 });
  deps.owns.mockResolvedValue(true);
  deps.visit.mockResolvedValue(true);
  deps.audit.mockResolvedValue(null);
});

describe("P0 receptionist patient PATCH boundary (synthetic only)", () => {
  it.each(["medicalAlert", "note"])(
    "rejects receptionist edits of clinical field %s before reading patient file",
    async field => {
      const response = await patch({ [field]: "malicious overwrite" });
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(deps.file).not.toHaveBeenCalled();
      expect(deps.update).not.toHaveBeenCalled();
    },
  );

  it("preserves demographic contact edits but redacts clinical, identity and photo fields in PATCH response", async () => {
    const response = await patch({ phone: "000000001" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(deps.update).toHaveBeenCalledTimes(1);
    const result = await response.json();
    expect(result.id).toBe(patientId);
    expect(result.fullName).toBe(patient.fullName);
    expect(result.phone).toBe(patient.phone);
    for (const field of ["medicalAlert", "note", "photoDocumentId", "nationalId"]) {
      expect(result).not.toHaveProperty(field);
    }
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });

  it.each(["assistant", "cashier", "accountant"])(
    "rejects non-clinical role %s at route even without proxy", async role => {
      deps.session.mockResolvedValue({ role, username: `synthetic-${role}` });
      const response = await patch({ phone: "000000002" });
      expect(response.status).toBe(403);
      expect(deps.file).not.toHaveBeenCalled();
      expect(deps.update).not.toHaveBeenCalled();
    },
  );

  it("preserves clinician clinical edits and clinical return fields", async () => {
    deps.session.mockResolvedValue({ role: "doctor", username: "synthetic-doctor" });
    const response = await patch({ medicalAlert: "synthetic-new-allergy" });
    expect(response.status).toBe(200);
    const updated = await response.json();
    expect(updated.medicalAlert).toBe("synthetic-secret-allergy");
    expect(deps.update).toHaveBeenCalledTimes(1);
    expect(deps.owns).toHaveBeenCalledWith(7, patientId);
  });

  it("rejects unauthenticated writes without any file reads", async () => {
    deps.session.mockResolvedValue(null);
    expect((await patch({ phone: "000000003" })).status).toBe(401);
    expect(deps.file).not.toHaveBeenCalled();
  });
});
