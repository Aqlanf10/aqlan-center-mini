import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({
  getClinicalVisit: vi.fn(), getPatient: vi.fn(), savePrescription: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: async () => ({ username: "synthetic-rx-admin", role: "admin" }) }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: async () => true }));
vi.mock("@/lib/db", () => ({ ...boundary, findUserByUsername: async () => ({ isActive: true, partyId: 7 }) }));
import { POST } from "../app/api/prescriptions/route";
import { PrescriptionIdentityConflict } from "../lib/prescription-identity";

// In-process response mapping with an already-linked synthetic clinically enabled
// admin fixture. No real authorization, HTTP server, or access-bypass exercise.
const draft = {
  patientId: 101, visitId: 201, diagnosis: "Synthetic diagnosis", notes: null, instructionsLang: "both",
  items: [{ name: "Metronidazole 500mg", dose: "500mg", form: "Tablets", frequency: "every 8 hours", duration: "3 days", instructions: "", instructionsEn: "" }],
};
const request = (extra: Record<string, unknown> = {}) => new Request("http://test.invalid/api/prescriptions", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...draft, ...extra }),
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SESSION_SECRET", "synthetic-prescription-identity-test-secret");
  boundary.getClinicalVisit.mockResolvedValue({ id: 201, patientId: 101 });
  boundary.getPatient.mockResolvedValue({ id: 101, medicalAlert: null });
  boundary.savePrescription.mockResolvedValue({ id: 301, createdAt: "2026-10-03T09:00:00.000Z" });
});
afterAll(() => { vi.unstubAllEnvs(); });
async function acknowledgedRequest() {
  boundary.getPatient.mockResolvedValue({ id: 101, medicalAlert: "حامل في الثلث الثاني" });
  const preview = await POST(request());
  expect(preview.status).toBe(200);
  const body = await preview.json();
  expect(body.requiresAcknowledgement).toBe(true);
  expect(boundary.savePrescription).not.toHaveBeenCalled();
  return request({ acknowledgedSafetyToken: body.acknowledgementToken });
}

describe("prescription identity conflict route mapping", () => {
  it.each([false, true])("maps typed stale identity to 409 (acknowledged: %s)", async acknowledged => {
    const input = acknowledged ? await acknowledgedRequest() : request();
    const conflict = new PrescriptionIdentityConflict();
    boundary.savePrescription.mockRejectedValue(conflict);
    const response = await POST(input);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "identity_changed", message: conflict.message });
    expect(boundary.savePrescription).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])("does not broaden unexpected failure mapping (acknowledged: %s)", async acknowledged => {
    const input = acknowledged ? await acknowledgedRequest() : request();
    boundary.savePrescription.mockRejectedValue(new Error("Synthetic storage failure"));
    const response = await POST(input);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "تعذّر حفظ الوصفة." });
  });
  it.each([false, true])("preserves success shape and issuer attribution (acknowledged: %s)", async acknowledged => {
    const input = acknowledged ? await acknowledgedRequest() : request();
    const response = await POST(input);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ id: 301, createdAt: "2026-10-03T09:00:00.000Z" });
    if (acknowledged) {
      expect(body.acknowledged).toBe(true);
      expect(body.safetyWarnings.length).toBeGreaterThan(0);
    } else expect(body).toEqual({ id: 301, createdAt: "2026-10-03T09:00:00.000Z" });
    expect(boundary.savePrescription).toHaveBeenCalledWith(expect.objectContaining({ patientId: 101, visitId: 201 }), "synthetic-rx-admin", 7);
  });
  it("retains route preflight rejection before saving a mismatched visit", async () => {
    boundary.getClinicalVisit.mockResolvedValue({ id: 201, patientId: 102 });
    expect((await POST(request())).status).toBe(400);
    expect(boundary.savePrescription).not.toHaveBeenCalled();
  });
  it("retains rejected acknowledgment without reaching the write fence", async () => {
    await acknowledgedRequest();
    const response = await POST(request({ acknowledgedSafetyToken: "synthetic-invalid-token" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ackRejected: true });
    expect(boundary.savePrescription).not.toHaveBeenCalled();
  });
  it("retains critical safety refusal before reaching the write fence", async () => {
    boundary.getPatient.mockResolvedValue({ id: 101, medicalAlert: "حساسية بنسلين شديدة" });
    const response = await POST(request({ items: [{ ...draft.items[0], name: "Amoxicillin 500mg" }] }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ blockReason: "critical_medication_safety" });
    expect(boundary.savePrescription).not.toHaveBeenCalled();
  });
});
