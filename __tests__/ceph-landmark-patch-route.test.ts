import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  session: vi.fn(), access: vi.fn(), study: vi.fn(), landmarks: vi.fn(), calibration: vi.fn(), diagnosis: vi.fn(), discard: vi.fn(),
}));
vi.mock("../lib/session", () => ({ requireSession: mocks.session }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: mocks.access }));
vi.mock("../lib/db", () => ({
  getCephStudy: mocks.study, updateCephLandmarks: mocks.landmarks, updateCephCalibration: mocks.calibration,
  updateCephDiagnosis: mocks.diagnosis, discardCephAnalysis: mocks.discard,
}));
import { PATCH } from "../app/api/ceph/[id]/route";
const pt = { code: "S", x: 10, y: 20, source: "manual" };
const cal = { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 };
const call = (body: unknown) => PATCH(new Request("http://localhost/api/ceph/71", {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: "71" }) });
beforeEach(() => {
  vi.clearAllMocks(); mocks.session.mockResolvedValue({ username: "synthetic-doctor" }); mocks.access.mockResolvedValue(true);
  mocks.study.mockResolvedValue({ analysis: { patientId: 11 } });
  mocks.landmarks.mockResolvedValue({ ok: true, count: 0, removedCount: 1 });
  mocks.calibration.mockResolvedValue({ ok: true, mmPerPixel: 0.1 }); mocks.diagnosis.mockResolvedValue({ ok: true });
});
describe("ceph draft landmark PATCH", () => {
  it("forwards scoped removals and expected coordinates to one atomic domain call", async () => {
    const response = await call({ landmarks: [{ ...pt, code: "N" }], removeLandmarks: ["S"], expectedLandmarks: [pt] });
    expect(response.status).toBe(200);
    expect(mocks.landmarks).toHaveBeenCalledExactlyOnceWith(71, [{ ...pt, code: "N" }], "synthetic-doctor", ["S"], [pt]);
  });
  it("returns authoritative calibration scale without requiring a second GET", async () => {
    const response = await call({ calibration: cal }); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, mmPerPixel: 0.1 });
  });
  it.each([
    { removeLandmarks: ["S"] }, { removeLandmarks: "S" }, { removeLandmarks: ["INVALID"], expectedLandmarks: [pt] },
    { removeLandmarks: ["S"], expectedLandmarks: [] }, { removeLandmarks: ["S", "S"], expectedLandmarks: [pt] },
    { landmarks: [pt], removeLandmarks: ["S"], expectedLandmarks: [pt] }, { landmarks: [pt, { ...pt, x: null }] },
    { landmarks: [pt, null] }, { landmarks: [pt, { ...pt, code: "INVALID" }] }, { landmarks: [{ ...pt, x: "" }] },
    { landmarks: [{ ...pt, source: "wrong" }] }, { landmarks: [pt, pt] }, { expectedLandmarks: [null] },
    null, [], "bad body",
  ])("rejects malformed mutation before applying calibration or any landmark write: %j", async (bad) => {
    const body = bad;
    const response = await call(body); expect(response.status).toBe(400);
    expect(mocks.calibration).not.toHaveBeenCalled(); expect(mocks.landmarks).not.toHaveBeenCalled(); expect(mocks.diagnosis).not.toHaveBeenCalled();
  });
  it("returns conflict for a stale expected point", async () => {
    mocks.landmarks.mockResolvedValue({ ok: false, message: "changed" });
    const response = await call({ removeLandmarks: ["S"], expectedLandmarks: [pt] });
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ message: "changed" });
  });
  it.each([
    { x1: 0, y1: 0, x2: 1e308, y2: 0, mm: Number.MIN_VALUE },
    { x1: 0, y1: 0, x2: Number.MIN_VALUE, y2: 0, mm: 1e308 },
  ])("rejects nonfinite or zero resulting calibration scale: %j", async (calibration) => {
    const response = await call({ calibration }); expect(response.status).toBe(400);
    expect(mocks.calibration).not.toHaveBeenCalled();
  });
  it.each([
    { calibration: cal, landmarks: [pt], expectedLandmarks: [{ ...pt, x: 0 }] },
    { calibration: cal, removeLandmarks: ["S"], expectedLandmarks: [pt] },
    { calibration: cal, diagnosis: { finalDx: "Synthetic diagnosis" } },
    { landmarks: [pt], diagnosis: { finalDx: "Synthetic diagnosis" } },
  ])("rejects mixed transactions before any partial commit: %j", async (body) => {
    mocks.landmarks.mockResolvedValue({ ok: false, message: "stale" });
    const response = await call(body); expect(response.status).toBe(400);
    expect(mocks.calibration).not.toHaveBeenCalled(); expect(mocks.landmarks).not.toHaveBeenCalled(); expect(mocks.diagnosis).not.toHaveBeenCalled();
  });
  it.each([401, 403])("does not write for denied authority (%s)", async (status) => {
    if (status === 401) mocks.session.mockResolvedValue(null); else mocks.access.mockResolvedValue(false);
    const response = await call({ removeLandmarks: ["S"], expectedLandmarks: [pt] });
    expect(response.status).toBe(status); expect(mocks.landmarks).not.toHaveBeenCalled();
  });
});
