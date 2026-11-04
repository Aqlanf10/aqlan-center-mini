import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), study: vi.fn(),
  calibration: vi.fn(), points: vi.fn(), diagnosis: vi.fn(), discard: vi.fn(), complete: vi.fn(), duplicate: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: m.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: m.access }));
vi.mock("@/lib/db", () => ({ getCephStudy: m.study, updateCephCalibration: m.calibration,
  updateCephLandmarks: m.points, updateCephDiagnosis: m.diagnosis, discardCephAnalysis: m.discard,
  completeCephAnalysis: m.complete, duplicateCephAnalysis: m.duplicate }));
import { GET, PATCH, DELETE } from "../app/api/ceph/[id]/route";
import { POST as complete } from "../app/api/ceph/[id]/complete/route";
import { POST as duplicate } from "../app/api/ceph/[id]/duplicate/route";
const ctx = () => ({ params: Promise.resolve({ id: "7" }) });
const request = (method = "POST") => new Request("http://localhost/api/ceph/7", { method,
  ...(method === "GET" ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ diagnosis: { finalDx: "synthetic clinician text" } }) }) });
beforeEach(() => {
  vi.clearAllMocks(); m.access.mockResolvedValue(true);
  m.study.mockResolvedValue({ analysis: { id: 7, patientId: 11, status: "draft" }, landmarks: [] });
  for (const fn of [m.calibration, m.points, m.diagnosis, m.discard, m.complete, m.duplicate]) fn.mockResolvedValue({ ok: true });
});
describe("clinical ceph writes do not inherit administrative read access", () => {
  it.each(["reception", "assistant", "accountant", "cashier"])("denies all clinical mutations to %s even if patient access permits it", async role => {
    m.session.mockResolvedValue({ role, username: "synthetic" });
    expect((await PATCH(request("PATCH"), ctx())).status).toBe(403);
    expect((await DELETE(request("DELETE"), ctx())).status).toBe(403);
    expect((await complete(request(), ctx())).status).toBe(403);
    expect((await duplicate(request(), ctx())).status).toBe(403);
    expect(m.study).not.toHaveBeenCalled();
    for (const fn of [m.calibration, m.points, m.diagnosis, m.discard, m.complete, m.duplicate]) expect(fn).not.toHaveBeenCalled();
  });
  it("preserves the reception's separately authorized read", async () => {
    m.session.mockResolvedValue({ role: "reception", username: "synthetic" });
    const response = await GET(request("GET"), ctx());
    expect(response.status).toBe(200);
    expect(m.access).toHaveBeenCalledWith(expect.anything(), 11, "canViewXrays");
  });
  it.each(["doctor", "admin"])("retains explicit diagnosis writing for an authorized %s", async role => {
    m.session.mockResolvedValue({ role, username: "synthetic" });
    expect((await PATCH(request("PATCH"), ctx())).status).toBe(200);
    expect(m.access).toHaveBeenCalledWith(expect.anything(), 11, "canUploadXrays");
    expect(m.diagnosis).toHaveBeenCalledWith(7, expect.objectContaining({ finalDx: "synthetic clinician text" }), "synthetic");
  });
  it("still rejects a doctor's lost patient permission", async () => {
    m.session.mockResolvedValue({ role: "doctor", username: "synthetic" }); m.access.mockResolvedValue(false);
    expect((await PATCH(request("PATCH"), ctx())).status).toBe(403);
    expect(m.diagnosis).not.toHaveBeenCalled();
  });
});
