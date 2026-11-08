import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ requireSession: vi.fn(), canAccessPatient: vi.fn(),
  getClinicalVisit: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: boundary.canAccessPatient }));
vi.mock("@/lib/db", () => ({ ...boundary, CLINIC_TIME_ZONE: "Asia/Aden",
  addVisitAddendum: vi.fn(), getSettings: vi.fn(), recordAudit: vi.fn(), saveClinicalNotes: vi.fn(),
  setVisitProcedures: vi.fn(), signAuthorizedClinicalVisit: vi.fn(),
  ClinicalPlanConflict: class extends Error {}, ProcedurePriceRejected: class extends Error {},
  InventoryShortage: class extends Error {},
}));
import { ClinicalPlanConflict } from "../lib/db";
import { GET } from "../app/api/visits/[id]/clinical/route";
const get = (id = "201") => GET(new Request(`https://test.invalid/api/visits/${id}/clinical`),
  { params: Promise.resolve({ id }) });
const visit = { id: 201, patientId: 101, arrivedAt: new Date().toISOString(),
  patientName: "Synthetic patient", status: "signed", ortho: { caseId: 301, visitAdjustmentId: 401 } };

beforeEach(() => {
  vi.resetAllMocks();
  boundary.requireSession.mockResolvedValue({ username: "synthetic-doctor", role: "doctor", partyId: 11 });
  boundary.canAccessPatient.mockResolvedValue(true);
  boundary.getClinicalVisit.mockResolvedValue(visit);
});

describe("clinical GET recorded orthodontic scope failure", () => {
  it("returns a controlled 409 for an explicit history conflict without a partial clinical payload", async () => {
    boundary.getClinicalVisit.mockRejectedValue(new ClinicalPlanConflict("Synthetic generic scope conflict"));
    const response = await get();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: "Synthetic generic scope conflict" });
  });
  it("does not expose unrelated storage errors or treat them as scope conflicts", async () => {
    boundary.getClinicalVisit.mockRejectedValue(new Error("Synthetic private storage details"));
    const response = await get();
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("Synthetic private");
  });
  it("preserves authorized historical data and actor scope", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(visit);
    expect(boundary.getClinicalVisit).toHaveBeenCalledWith(201, { actorPartyId: 11 });
    expect(boundary.canAccessPatient).toHaveBeenCalledWith(expect.objectContaining({ partyId: 11 }), 101);
  });
  it("preserves patient access refusal", async () => {
    boundary.canAccessPatient.mockResolvedValue(false);
    expect((await get()).status).toBe(403);
  });
  it("does not read an unauthenticated request", async () => {
    boundary.requireSession.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(boundary.getClinicalVisit).not.toHaveBeenCalled();
  });
  it("does not read an invalid visit ID", async () => {
    expect((await get("invalid")).status).toBe(400);
    expect(boundary.getClinicalVisit).not.toHaveBeenCalled();
  });
  it("preserves the missing visit response", async () => {
    boundary.getClinicalVisit.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });
  it("preserves the assistant historical visit restriction", async () => {
    boundary.requireSession.mockResolvedValue({ username: "synthetic-assistant", role: "assistant" });
    boundary.getClinicalVisit.mockResolvedValue({ ...visit, arrivedAt: "2020-01-01T00:00:00.000Z" });
    expect((await get()).status).toBe(403);
  });
});
