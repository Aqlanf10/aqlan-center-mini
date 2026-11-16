import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const boundary = vi.hoisted(() => ({
  requireSession: vi.fn(), canAccessPatient: vi.fn(), getClinicalVisit: vi.fn(), getSettings: vi.fn(),
  saveClinicalNotes: vi.fn(), setVisitProcedures: vi.fn(), signClinicalVisit: vi.fn(), recordAudit: vi.fn(),
  settleRejectedClinicalLabCommand: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: boundary.canAccessPatient }));
vi.mock("@/lib/clinical-lab-command-settlement", () => ({ settleRejectedClinicalLabCommand: boundary.settleRejectedClinicalLabCommand }));
vi.mock("@/lib/db", () => ({ ...boundary, addVisitAddendum: vi.fn(), CLINIC_TIME_ZONE: "Asia/Aden",
  ClinicalPlanConflict: class extends Error {}, ProcedurePriceRejected: class extends Error {}, InventoryShortage: class extends Error {},
}));
import { POST } from "../app/api/visits/[id]/clinical/route";

const session = { username: "synthetic-doctor", role: "doctor", partyId: 11 };
const command = () => ({ labRequestKey: "synthetic-scope-command", labPatientId: 101,
  doctorId: 11, diagnosis: "Synthetic unchanged-scope note", procedures: [], labRetirements: [] });
const post = (body: Record<string, unknown>) => POST(new Request("https://test.invalid/api/visits/201/clinical", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: "201" }) });
const noWrites = () => {
  expect(boundary.setVisitProcedures).not.toHaveBeenCalled();
  expect(boundary.saveClinicalNotes).not.toHaveBeenCalled();
  expect(boundary.signClinicalVisit).not.toHaveBeenCalled();
  expect(boundary.recordAudit).not.toHaveBeenCalled();
  expect(boundary.settleRejectedClinicalLabCommand).not.toHaveBeenCalled();
};
beforeEach(() => {
  vi.resetAllMocks();
  boundary.requireSession.mockResolvedValue(session);
  boundary.canAccessPatient.mockResolvedValue(true);
  boundary.getClinicalVisit.mockResolvedValue({ id: 201, patientId: 101, doctorId: 11,
    patientName: "Synthetic patient", procedures: [], status: "open" });
  boundary.getSettings.mockResolvedValue({});
  boundary.setVisitProcedures.mockResolvedValue(true);
});

describe("lab command sealed patient scope at clinical POST", () => {
  it.each([undefined, null, "101", 0, -1, 101.5, Number.MAX_SAFE_INTEGER + 1, true])(
    "refuses missing or non-positive-integer scope %s before source reads or writes", async labPatientId => {
      const response = await post({ ...command(), labPatientId });
      expect(response.status).toBe(400);
      expect(boundary.getClinicalVisit).not.toHaveBeenCalled();
      noWrites();
    },
  );
  it.each([202, null])("refuses a stale patient scope when visit now belongs to %s without settling or saving notes", async patientId => {
    boundary.getClinicalVisit.mockResolvedValue({ id: 201, patientId, doctorId: 11, procedures: [], status: "open" });
    const response = await post(command());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "source_changed" });
    noWrites();
  });
  it("forwards exact expected patient and sealed-body hash to the transactional writer", async () => {
    const body = command();
    const response = await post(body);
    expect(response.status).toBe(200);
    const requestHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    expect(boundary.setVisitProcedures).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      visitId: 201, procedures: [], clinicalNotes: expect.objectContaining({ diagnosis: body.diagnosis }),
      labCommand: { expectedPatientId: 101, requestKey: body.labRequestKey, requestHash, retirements: [], session },
    }));
    expect(await response.json()).toMatchObject({ labWorkCommand: {
      patientId: 101, visitId: 201, actor: session.username, requestKey: body.labRequestKey, requestHash,
    } });
    expect(boundary.saveClinicalNotes).not.toHaveBeenCalled();
    expect(boundary.settleRejectedClinicalLabCommand).not.toHaveBeenCalled();
  });
});
