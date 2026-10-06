import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClinicalDoctorIdentityConflict } from "../lib/clinical-doctor-identity";

const boundary = vi.hoisted(() => ({
  requireSession: vi.fn(), canAccessPatient: vi.fn(), getClinicalVisit: vi.fn(), getSettings: vi.fn(),
  saveClinicalNotes: vi.fn(), setVisitProcedures: vi.fn(), signClinicalVisit: vi.fn(), recordAudit: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: boundary.canAccessPatient }));
vi.mock("@/lib/db", () => ({ ...boundary, addVisitAddendum: vi.fn(), CLINIC_TIME_ZONE: "Asia/Aden",
  ClinicalPlanConflict: class extends Error {}, ProcedurePriceRejected: class extends Error {}, InventoryShortage: class extends Error {},
}));
import { POST } from "../app/api/visits/[id]/clinical/route";

const line = { serviceId: 401, toothCode: 11, surfaces: null, quantity: 1, unitPriceMinor: 100,
  doctorId: 12, planItemId: null, note: null };
const current = () => ({ id: 201, patientId: 101, patientName: "Synthetic patient", doctorId: 11,
  arrivedAt: new Date().toISOString(), procedures: [line], status: "open" });
const request = (body: Record<string, unknown>) => new Request("https://test.invalid/api/visits/201/clinical", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const post = (body: Record<string, unknown>) => POST(request(body), { params: Promise.resolve({ id: "201" }) });

beforeEach(() => {
  vi.resetAllMocks();
  boundary.requireSession.mockResolvedValue({ username: "synthetic-doctor", role: "doctor", partyId: 11 });
  boundary.canAccessPatient.mockResolvedValue(true);
  boundary.getClinicalVisit.mockImplementation(async () => current());
  boundary.getSettings.mockResolvedValue({});
  boundary.saveClinicalNotes.mockResolvedValue(true);
  boundary.setVisitProcedures.mockResolvedValue(true);
  boundary.signClinicalVisit.mockResolvedValue({ reason: null, visit: current(), invoiceId: 701, duesMinor: 100, invoiceCurrency: "YER" });
});

describe("actual clinical POST identity errors and combined-save boundary (DB-free stubs)", () => {
  it.each(["doctor", "admin"])("%s save returns a controlled 409 without separately committing notes", async (role) => {
    boundary.requireSession.mockResolvedValue({ username: "synthetic", role, partyId: 11 });
    const error = new ClinicalDoctorIdentityConflict();
    boundary.setVisitProcedures.mockRejectedValue(error);
    const response = await post({ doctorId: 11, diagnosis: "Changed diagnosis", billingCurrency: "YER", procedures: [{ ...line, doctorId: 91 }] });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: error.code, message: error.message });
    expect(boundary.saveClinicalNotes).not.toHaveBeenCalled();
    expect(boundary.recordAudit).not.toHaveBeenCalled();
    expect(boundary.setVisitProcedures).toHaveBeenCalledWith(expect.objectContaining({
      clinicalNotes: expect.objectContaining({ diagnosis: "Changed diagnosis", doctorId: 11 }),
      procedures: [expect.objectContaining({ doctorId: 91 })],
    }));
  });
  it.each(["doctor", "admin"])("%s sign exposes identity refusal without a success audit", async (role) => {
    boundary.requireSession.mockResolvedValue({ username: "synthetic", role, partyId: 11 });
    const error = new ClinicalDoctorIdentityConflict();
    boundary.signClinicalVisit.mockRejectedValue(error);
    const response = await post({ action: "sign" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: error.code, message: error.message });
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });
  it("keeps explicit doctor B when the visit doctor is A and saves notes in that same domain call", async () => {
    expect((await post({ doctorId: 11, diagnosis: "Reviewed", procedures: [line] })).status).toBe(200);
    expect(boundary.saveClinicalNotes).not.toHaveBeenCalled();
    expect(boundary.setVisitProcedures).toHaveBeenCalledWith(expect.objectContaining({
      visitId: 201, clinicalNotes: expect.objectContaining({ doctorId: 11, diagnosis: "Reviewed" }),
      procedures: [expect.objectContaining({ doctorId: 12 })],
    }));
  });
  it("keeps null performer inheritance and plan identity unmodified", async () => {
    expect((await post({ doctorId: 11, procedures: [{ ...line, doctorId: null, planItemId: 801 }] })).status).toBe(200);
    expect(boundary.setVisitProcedures).toHaveBeenCalledWith(expect.objectContaining({
      procedures: [expect.objectContaining({ doctorId: null, planItemId: 801 })],
    }));
  });
  it("retains standalone notes-only saves", async () => {
    expect((await post({ doctorId: 11, diagnosis: "Notes only" })).status).toBe(200);
    expect(boundary.saveClinicalNotes).toHaveBeenCalledWith(expect.objectContaining({ visitId: 201, diagnosis: "Notes only" }));
    expect(boundary.setVisitProcedures).not.toHaveBeenCalled();
  });
  it("keeps the signed-visit 409 for combined and note-only save races", async () => {
    boundary.setVisitProcedures.mockResolvedValue(false);
    expect((await post({ doctorId: 11, procedures: [line] })).status).toBe(409);
    expect(boundary.saveClinicalNotes).not.toHaveBeenCalled();
    boundary.saveClinicalNotes.mockResolvedValue(false);
    expect((await post({ doctorId: 11 })).status).toBe(409);
  });
  it("rejects an invalid billing currency before saving either notes or work", async () => {
    expect((await post({ doctorId: 11, diagnosis: "Must not save", procedures: [line], billingCurrency: "INVALID" })).status).toBe(400);
    expect(boundary.saveClinicalNotes).not.toHaveBeenCalled();
    expect(boundary.setVisitProcedures).not.toHaveBeenCalled();
  });
  it("preserves assistant notes-only behavior and procedure-edit denial", async () => {
    boundary.requireSession.mockResolvedValue({ username: "synthetic-assistant", role: "assistant", partyId: 91 });
    expect((await post({ doctorId: 11, diagnosis: "Assistant note" })).status).toBe(200);
    boundary.saveClinicalNotes.mockClear();
    expect((await post({ doctorId: 11, procedures: [{ ...line, doctorId: 91 }] })).status).toBe(403);
    expect(boundary.saveClinicalNotes).not.toHaveBeenCalled();
    expect(boundary.setVisitProcedures).not.toHaveBeenCalled();
  });
  it("preserves patient isolation and authentication admission", async () => {
    boundary.canAccessPatient.mockResolvedValue(false);
    expect((await post({ doctorId: 11, procedures: [line] })).status).toBe(403);
    boundary.requireSession.mockResolvedValue(null);
    expect((await post({ doctorId: 11, procedures: [line] })).status).toBe(401);
    expect(boundary.saveClinicalNotes).not.toHaveBeenCalled();
    expect(boundary.setVisitProcedures).not.toHaveBeenCalled();
  });
  it("does not turn unrelated writer failures into identity conflicts", async () => {
    boundary.setVisitProcedures.mockRejectedValue(new Error("Synthetic unrelated storage failure"));
    expect((await post({ doctorId: 11, procedures: [line] })).status).toBe(500);
  });
});
