import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClinicalMutationAuthorityError } from "../lib/clinical-mutation-authority";
import { parseCephCalibrationState, sameCephCalibrationState } from "../lib/ceph-completion-snapshot";
const m = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), study: vi.fn(), calibration: vi.fn(), diagnosis: vi.fn(), landmarks: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: m.session }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: m.access }));
vi.mock("../lib/db", () => ({ getCephStudy: m.study, updateAuthorizedCephCalibration: m.calibration, updateAuthorizedCephDiagnosis: m.diagnosis,
  updateAuthorizedCephLandmarks: m.landmarks, discardAuthorizedCephAnalysis: vi.fn() }));
import { PATCH } from "../app/api/ceph/[id]/route";
const cal = { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 };
const empty = { calibration: null, mmPerPixel: null };
const diagnosis = { skeletal: null, dental: null, softTissue: null, note: null, finalDx: "Reviewed" };
const call = (body: unknown) => PATCH(new Request("http://localhost/api/ceph/71", { method: "PATCH",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: "71" }) });
beforeEach(() => {
  vi.clearAllMocks(); m.session.mockResolvedValue({ username: "doctor-A", role: "doctor" }); m.access.mockResolvedValue(true);
  m.study.mockResolvedValue({ analysis: { patientId: 11, documentId: 22 } }); m.calibration.mockResolvedValue({ ok: true, calibration: cal, mmPerPixel: 0.1 });
  m.diagnosis.mockResolvedValue({ ok: true, diagnosis });
});
describe("mandatory category-local clinical CAS at PATCH", () => {
  it("forwards an explicitly absent ruler and returns authoritative tuple and scale", async () => {
    const res = await call({ calibration: cal, expectedCalibration: empty }); expect(res.status).toBe(200);
    expect(m.calibration).toHaveBeenCalledExactlyOnceWith(71, cal, empty, { patientId: 11, documentId: 22, session: await m.session() });
    expect(await res.json()).toEqual({ ok: true, calibration: cal, mmPerPixel: 0.1 });
  });
  it("forwards an explicitly absent diagnosis without substituting a fetched current value", async () => {
    m.study.mockResolvedValue({ analysis: { patientId: 11, documentId: 22 }, diagnosis });
    const res = await call({ diagnosis, expectedDiagnosis: null }); expect(res.status).toBe(200);
    expect(m.diagnosis).toHaveBeenCalledExactlyOnceWith(71, diagnosis, null, { patientId: 11, documentId: 22, session: await m.session() });
  });
  it("passes all exact prior diagnosis fields, preserving whitespace", async () => {
    const prior = { ...diagnosis, note: " exact prior text " };
    expect((await call({ diagnosis, expectedDiagnosis: prior })).status).toBe(200);
    expect(m.diagnosis.mock.calls[0][2]).toEqual(prior);
  });
  it.each([
    { calibration: cal }, { calibration: cal, expectedCalibration: null }, { calibration: cal, expectedCalibration: { calibration: null } },
    { calibration: cal, expectedCalibration: { calibration: cal, mmPerPixel: "0.1" } },
    { diagnosis }, { diagnosis, expectedDiagnosis: {} }, { diagnosis, expectedDiagnosis: { finalDx: "Incomplete" } },
  ])("rejects omitted/malformed precondition %# before any clinical writer", async body => {
    expect((await call(body)).status).toBe(400); expect(m.calibration).not.toHaveBeenCalled(); expect(m.diagnosis).not.toHaveBeenCalled(); expect(m.landmarks).not.toHaveBeenCalled();
  });
  it.each(["calibration", "diagnosis"])("surfaces a stale %s as409 without refreshing/retrying", async kind => {
    const writer = kind === "calibration" ? m.calibration : m.diagnosis; writer.mockResolvedValue({ ok: false, message: "Changed" });
    const res = await call(kind === "calibration" ? { calibration: cal, expectedCalibration: empty } : { diagnosis, expectedDiagnosis: null });
    expect(res.status).toBe(409); expect(writer).toHaveBeenCalledTimes(1); expect(m.study).toHaveBeenCalledTimes(1);
  });
  it("retains role and patient scope checks even for correctly shaped preconditions", async () => {
    m.session.mockResolvedValue({ username: "staff", role: "reception" });
    expect((await call({ diagnosis, expectedDiagnosis: null })).status).toBe(403); expect(m.study).not.toHaveBeenCalled();
    m.session.mockResolvedValue({ username: "doctor", role: "doctor" }); m.access.mockResolvedValue(false);
    expect((await call({ calibration: cal, expectedCalibration: empty })).status).toBe(403); expect(m.calibration).not.toHaveBeenCalled();
  });
});
describe("shared calibration state contract", () => {
  it("accepts truthful null states and canonicalizes tuple property order without mutation", () => {
    expect(parseCephCalibrationState(empty)).toEqual(empty);
    expect(sameCephCalibrationState({ calibration: cal, mmPerPixel: 0.1 }, { mmPerPixel: 0.1, calibration: { mm: 10, y2: 0, x2: 100, y1: 0, x1: 0 } })).toBe(true);
  });
  it("does not equate same scale with different ruler source", () => {
    expect(sameCephCalibrationState({ calibration: cal, mmPerPixel: 0.1 }, { calibration: { ...cal, x1: 10, x2: 110 }, mmPerPixel: 0.1 })).toBe(false);
  });
  it.each([undefined, {}, { calibration: cal, mmPerPixel: NaN }, { calibration: { ...cal, x1: Infinity }, mmPerPixel: 0.1 }])("fails closed on malformed state %#", value => {
    expect(parseCephCalibrationState(value)).toBeNull(); expect(sameCephCalibrationState(value, value)).toBe(false);
  });
});

describe("authenticated ceph draft request admission", () => {
  it.each(["calibration", "diagnosis", "landmarks"] as const)("binds %s to server patient, image and actor despite forged JSON", async kind => {
    const admitted = { userId: 7, username: "doctor-A", role: "doctor", expiresAt: Date.now() + 60_000 };
    m.session.mockResolvedValue(admitted);
    m.landmarks.mockResolvedValue({ ok: true });
    const payload = kind === "calibration" ? { calibration: cal, expectedCalibration: empty }
      : kind === "diagnosis" ? { diagnosis, expectedDiagnosis: null }
      : { landmarks: [{ code: "S", x: 10, y: 20, source: "manual" }], expectedLandmarks: [] };
    const response = await call({ ...payload, patientId: 99, documentId: 999, by: "forged", session: { role: "admin" } });
    expect(response.status).toBe(200);
    const writer = kind === "calibration" ? m.calibration : kind === "diagnosis" ? m.diagnosis : m.landmarks;
    expect(writer).toHaveBeenCalledOnce();
    expect(writer.mock.calls[0].at(-1)).toEqual({ patientId: 11, documentId: 22, session: admitted });
  });
  it.each([401, 403, 409] as const)("maps transactional refusal %s without calibration success", async status => {
    m.calibration.mockRejectedValue(new ClinicalMutationAuthorityError(status, "Synthetic authorization refusal"));
    const response = await call({ calibration: cal, expectedCalibration: empty });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ message: "Synthetic authorization refusal" });
  });
});

describe("authored diagnosis admission without silent loss",()=>{
 it.each(["skeletal","dental","softTissue","note","finalDx"])("refuses oversized %s before writer",async field=>{
  expect((await call({diagnosis:{...diagnosis,[field]:"x".repeat(2001)},expectedDiagnosis:null})).status).toBe(400);
  expect(m.diagnosis).not.toHaveBeenCalled();
 });
 it.each([123,false,[],{},null])("refuses malformed required conclusion %j",async value=>{
  expect((await call({diagnosis:{...diagnosis,finalDx:value},expectedDiagnosis:null})).status).toBe(400);
  expect(m.diagnosis).not.toHaveBeenCalled();
 });
 it.each(["skeletal","dental","softTissue","note"])("refuses malformed optional %s before writer",async field=>{
  for(const value of [123,false,[],{}]) {
   expect((await call({diagnosis:{...diagnosis,[field]:value},expectedDiagnosis:null})).status).toBe(400);
   expect(m.diagnosis).not.toHaveBeenCalled();
  }
 });
 it("retains exact input and CAS at trimmed 2000-character limit",async()=>{
  const value={...diagnosis,note:"  "+"x".repeat(2000)+"  "};
  expect((await call({diagnosis:value,expectedDiagnosis:diagnosis})).status).toBe(200);
  expect(m.diagnosis.mock.calls[0][1]).toEqual(value); expect(m.diagnosis.mock.calls[0][2]).toEqual(diagnosis);
 });
});
