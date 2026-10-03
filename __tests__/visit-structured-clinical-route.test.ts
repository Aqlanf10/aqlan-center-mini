import { beforeEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), visit: vi.fn(), projection: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: boundary.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: boundary.access }));
vi.mock("@/lib/db", () => ({ getClinicalVisit: boundary.visit, CLINIC_TIME_ZONE: "UTC" }));
vi.mock("@/lib/visit-structured-clinical-db", () => ({ getVisitStructuredClinical: boundary.projection }));
import { GET } from "../app/api/visits/[id]/clinical/route";

const ready = { status: "ready", visitId: 91001, patientId: 92001, visitCaseId: null, signedAt: null, signedBy: null, endodontics: [], periodontics: [] };
const read = () => GET(new Request("http://localhost/api/visits/91001/clinical"), { params: Promise.resolve({ id: "91001" }) });
beforeEach(() => {
  vi.clearAllMocks();
  boundary.session.mockResolvedValue({ username: "Synthetic doctor", role: "doctor", partyId: 94001 });
  boundary.access.mockResolvedValue(true);
  boundary.visit.mockResolvedValue({ id: 91001, patientId: 92001, arrivedAt: new Date().toISOString(), procedures: [] });
  boundary.projection.mockResolvedValue(ready);
});
describe("authorized linked visit GET structured references", () => {
  it("augments the existing read with the authorized exact visit and patient", async () => {
    const response = await read();
    expect(response.status).toBe(200);
    expect(boundary.projection).toHaveBeenCalledWith(91001, 92001);
    expect(boundary.access.mock.invocationCallOrder[0]).toBeLessThan(boundary.projection.mock.invocationCallOrder[0]);
    expect(await response.json()).toMatchObject({ id: 91001, procedures: [], structuredClinical: ready });
  });
  it("never reads specialty data before access is granted", async () => {
    boundary.access.mockResolvedValue(false);
    expect((await read()).status).toBe(403);
    expect(boundary.projection).not.toHaveBeenCalled();
  });
  it("keeps the assistant today fence before the projection", async () => {
    boundary.session.mockResolvedValue({ username: "Synthetic assistant", role: "assistant" });
    boundary.visit.mockResolvedValue({ id: 91001, patientId: 92001, arrivedAt: "2000-01-01T00:00:00Z" });
    expect((await read()).status).toBe(403);
    expect(boundary.projection).not.toHaveBeenCalled();
  });
  it("returns explicit unavailable alongside the canonical visit if the projection fails", async () => {
    boundary.projection.mockRejectedValue(new Error("synthetic read failed"));
    const response = await read();
    expect(response.status).toBe(200);
    expect((await response.json()).structuredClinical).toEqual({ status: "unavailable", visitId: 91001, patientId: 92001 });
  });
  it("refuses an expired session before any visit or specialty read", async () => {
    boundary.session.mockResolvedValue(null);
    expect((await read()).status).toBe(401);
    expect(boundary.visit).not.toHaveBeenCalled();
    expect(boundary.projection).not.toHaveBeenCalled();
  });
});
