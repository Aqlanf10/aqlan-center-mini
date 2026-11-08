import { beforeEach, describe, expect, it, vi } from "vitest";
import { JSON_BODY_LIMIT_BYTES } from "../lib/security-limits";
import type { CephCompletionSnapshot } from "../lib/ceph-completion-snapshot";
const m = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), study: vi.fn(), complete: vi.fn(), diagnosis: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: m.session }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: m.access }));
vi.mock("../lib/db", () => ({ getCephStudy: m.study, completeCephAnalysis: m.complete, updateAuthorizedCephDiagnosis: m.diagnosis,
  updateAuthorizedCephLandmarks: vi.fn(), updateAuthorizedCephCalibration: vi.fn(), discardAuthorizedCephAnalysis: vi.fn() }));
import { POST } from "../app/api/ceph/[id]/complete/route";
import { PATCH } from "../app/api/ceph/[id]/route";
const expectedSnapshot: CephCompletionSnapshot = { patientId: 11, documentId: 22, refSet: "builtin_default",
  calibration: { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 }, mmPerPixel: 0.1,
  landmarks: [{ code: "S", x: 10, y: 20, source: "manual" }], diagnosis: null };
const context = { params: Promise.resolve({ id: "71" }) };
const call = (body: unknown = { expectedSnapshot }) => POST(new Request("http://localhost/api/ceph/71/complete", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), context);
beforeEach(() => {
  vi.clearAllMocks(); m.session.mockResolvedValue({ username: "synthetic-doctor", role: "doctor" });
  m.access.mockResolvedValue(true); m.study.mockResolvedValue({ analysis: { patientId: 11, documentId: 22 } });
  m.complete.mockResolvedValue({ ok: true, measurements: [], summary: "Synthetic" });
});
describe("completion requires physician-reviewed input at its authenticated boundary", () => {
  it("passes the supplied snapshot to the locked domain command, never replacing it with current GET state", async () => {
    m.study.mockResolvedValue({ analysis: { patientId: 11, documentId: 99 }, landmarks: [] });
    expect((await call()).status).toBe(200);
    expect(m.complete).toHaveBeenCalledWith(71, "synthetic-doctor", expectedSnapshot, await m.session(), null);
  });
  it("never accepts a client-supplied attesting identity or session", async () => {
    const admitted = { userId: 18, username: "synthetic-doctor", role: "doctor", expiresAt: Date.now() + 60_000, credentialVersion: "server-credential" };
    m.session.mockResolvedValue(admitted);
    expect((await call({ expectedSnapshot, by: "forged-admin", session: { userId: 1, role: "admin" } })).status).toBe(200);
    expect(m.complete).toHaveBeenCalledWith(71, "synthetic-doctor", expectedSnapshot, admitted, null);
  });
  it("forwards the original viewed identity instead of substituting the latest study sources", async () => {
    const expectedSources = {schemaVersion:1,documentId:22,imageSha256:"a".repeat(64),referenceSetKey:"builtin_default",
      referenceSetSha256:"b".repeat(64),engineVersion:"original-engine",engineSourceSha256:"c".repeat(64)};
    m.study.mockResolvedValue({analysis:{patientId:11},completionSources:{state:"available",identity:{...expectedSources,imageSha256:"d".repeat(64)}}});
    expect((await call({expectedSnapshot,expectedSources})).status).toBe(200);
    expect(m.complete).toHaveBeenCalledWith(71,"synthetic-doctor",expectedSnapshot,await m.session(),expectedSources);
  });
  it.each([null,{},[],{schemaVersion:2},"hash"])("rejects explicitly malformed expectedSources %# before sealing", async expectedSources => {
    expect((await call({expectedSnapshot,expectedSources})).status).toBe(400); expect(m.complete).not.toHaveBeenCalled();
  });
  it.each([{}, null, [], { expectedSnapshot: null }, { expectedSnapshot: { ...expectedSnapshot, patientId: "11" } },
    { expectedSnapshot: { ...expectedSnapshot, landmarks: [{ code: "S", x: 1, y: 2 }] } }])("rejects omitted/malformed explicit state %# without sealing", async body => {
    expect((await call(body)).status).toBe(400); expect(m.complete).not.toHaveBeenCalled();
  });
  it("returns409 on stale state without silently refreshing or retrying", async () => {
    m.complete.mockResolvedValue({ ok: false, message: "Changed since review" });
    const res = await call(); expect(res.status).toBe(409); expect(await res.json()).toEqual({ message: "Changed since review" });
    expect(m.complete).toHaveBeenCalledTimes(1); expect(m.study).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed JSON and an oversized body before the domain write", async () => {
    const invalid = await POST(new Request("http://localhost/api/ceph/71/complete", { method: "POST", body: "{" }), context);
    expect(invalid.status).toBe(400);
    const large = await POST(new Request("http://localhost/api/ceph/71/complete", { method: "POST", headers: { "Content-Length": String(JSON_BODY_LIMIT_BYTES + 1) }, body: "{}" }), context);
    expect(large.status).toBe(413); expect(m.complete).not.toHaveBeenCalled();
  });
  it("retains admission and patient-scope guards before parsing snapshot state", async () => {
    m.session.mockResolvedValue({ username: "staff", role: "reception" }); expect((await call({})).status).toBe(403);
    expect(m.study).not.toHaveBeenCalled(); expect(m.complete).not.toHaveBeenCalled();
    m.session.mockResolvedValue({ username: "doctor", role: "doctor" }); m.access.mockResolvedValue(false);
    expect((await call({})).status).toBe(403); expect(m.complete).not.toHaveBeenCalled();
  });
  it("returns authoritative normalized diagnosis from successful PATCH without another read", async () => {
    const diagnosis = { skeletal: "a", dental: null, softTissue: null, note: null, finalDx: "Reviewed text" };
    m.diagnosis.mockResolvedValue({ ok: true, diagnosis });
    const res = await PATCH(new Request("http://localhost/api/ceph/71", { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ diagnosis: { finalDx: "  Reviewed text  ", skeletal: "  a  " }, expectedDiagnosis: null }) }), context);
    expect(res.status).toBe(200); expect(await res.json()).toEqual({ ok: true, diagnosis }); expect(m.study).toHaveBeenCalledTimes(1);
  });
});
