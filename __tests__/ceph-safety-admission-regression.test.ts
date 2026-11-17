import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({
  getCephStudy: vi.fn(), getPatient: vi.fn(), getSettingsSafe: vi.fn(),
  updateCephDiagnosis: vi.fn(), updateCephLandmarks: vi.fn(),
  updateCephCalibration: vi.fn(), discardCephAnalysis: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: vi.fn() }));
vi.mock("@/lib/ai", () => ({ aiChat: vi.fn(), getAiSettings: vi.fn() }));
import * as db from "@/lib/db";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { aiChat } from "@/lib/ai";
import { POST } from "@/app/api/ceph/[id]/ai-analyze/route";
import { PATCH } from "@/app/api/ceph/[id]/route";
const ctx = () => ({ params: Promise.resolve({ id: "101" }) });
const request = (body: unknown) => new Request("http://localhost/api/ceph/101", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireSession).mockResolvedValue({ userId: 1, username: "synthetic-reviewer", role: "doctor", expiresAt: Date.now() + 60000 });
  vi.mocked(db.getCephStudy).mockResolvedValue({ analysis: { patientId: 42, status: "draft" }, landmarks: [], measurements: [], diagnosis: null } as never);
  vi.mocked(db.getPatient).mockResolvedValue(null);
  vi.mocked(db.getSettingsSafe).mockResolvedValue({ "ai.clinical_external": "false" } as Awaited<ReturnType<typeof db.getSettingsSafe>>);
  vi.mocked(db.updateCephLandmarks).mockResolvedValue({ ok: true, count: 1 });
  vi.mocked(db.updateCephCalibration).mockResolvedValue({ ok: true, mmPerPixel: 1 });
  vi.mocked(canAccessPatient).mockImplementation(async (_session, _id, permission) => permission === "canViewXrays");
});
describe("synthetic cephalometry safety admission", () => {
  it("a read-only X-ray user must not save generated landmarks", async () => {
    const response = await POST(request({ action: "suggest-landmarks", save: true, imageWidth: 1000, imageHeight: 1000 }), ctx());
    expect(db.updateCephLandmarks).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });
  it("read-only landmark preview remains available and does not persist or call external AI", async () => {
    const response = await POST(request({ action: "suggest-landmarks", save: false }), ctx());
    expect(response.status).toBe(200);
    expect(db.updateCephLandmarks).not.toHaveBeenCalled();
    expect(aiChat).not.toHaveBeenCalled();
  });
  it("a read-only X-ray user must not save generated diagnosis", async () => {
    const response = await POST(request({ action: "generate-diagnosis", saveToDiagnosis: true, useAiChat: false }), ctx());
    expect(db.updateCephDiagnosis).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });
  it("external clinical analysis remains off when settings cannot be loaded", async () => {
    vi.mocked(db.getSettingsSafe).mockRejectedValue(new Error("settings unavailable"));
    const response = await POST(request({ action: "generate-diagnosis", useAiChat: true }), ctx());
    expect(response.status).toBe(200);
    expect(aiChat).not.toHaveBeenCalled();
  });
  it.each(["true", 1])("non-boolean truthy save flags cannot bypass write permission: %s", async (save) => {
    const response = await POST(request({ action: "suggest-landmarks", save }), ctx());
    expect(response.status).toBe(403);
    expect(db.updateCephLandmarks).not.toHaveBeenCalled();
  });
  it("rejects a bad batch before applying calibration from the same request", async () => {
    vi.mocked(canAccessPatient).mockResolvedValue(true);
    const response = await PATCH(request({ calibration: { x1: 0, y1: 0, x2: 10, y2: 0, mm: 10 }, landmarks: [{ code: "UNKNOWN", x: 4, y: 5 }] }), ctx());
    expect(response.status).toBe(400);
    expect(db.updateCephCalibration).not.toHaveBeenCalled();
    expect(db.updateCephLandmarks).not.toHaveBeenCalled();
  });
  it("null calibration coordinates must not be silently converted to zero", async () => {
    vi.mocked(canAccessPatient).mockResolvedValue(true);
    const response = await PATCH(request({ calibration: { x1: null, y1: 0, x2: 10, y2: 0, mm: 10 } }), ctx());
    expect(db.updateCephCalibration).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
  });
  it("invalid landmark batches must be rejected without partial writes", async () => {
    vi.mocked(canAccessPatient).mockResolvedValue(true);
    const response = await PATCH(request({ landmarks: [{ code: "N", x: 2, y: 3 }, { code: "UNKNOWN", x: 4, y: 5 }] }), ctx());
    expect(db.updateCephLandmarks).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
  });
  it("unauthenticated requests perform no clinical reads", async () => {
    vi.mocked(requireSession).mockResolvedValue(null);
    const response = await POST(request({ action: "suggest-landmarks", save: true }), ctx());
    expect(response.status).toBe(401);
    expect(db.getCephStudy).not.toHaveBeenCalled();
    expect(db.updateCephLandmarks).not.toHaveBeenCalled();
  });
});
