import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClinicalMutationAuthorityError } from "../lib/clinical-mutation-authority";
const m = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), study: vi.fn(), discard: vi.fn(), create: vi.fn(), duplicate: vi.fn(), list: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: m.session }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: m.access }));
vi.mock("../lib/db", () => ({
  getCephStudy: m.study, discardAuthorizedCephAnalysis: m.discard,
  createAuthorizedCephAnalysis: m.create, duplicateAuthorizedCephAnalysis: m.duplicate, listPatientCephAnalyses: m.list,
  updateAuthorizedCephCalibration: vi.fn(), updateAuthorizedCephLandmarks: vi.fn(), updateAuthorizedCephDiagnosis: vi.fn(),
}));
import { POST as create } from "../app/api/patients/[id]/ceph/route";
import { POST as duplicate } from "../app/api/ceph/[id]/duplicate/route";
import { DELETE } from "../app/api/ceph/[id]/route";
const admitted = (role = "doctor") => ({ userId: 7, username: "synthetic-operator", role,
  credentialVersion: "synthetic-credential-version", expiresAt: Date.now() + 60_000 });
const call = (body: unknown = { note: "Synthetic discard reason" }) =>
  DELETE(new Request("https://test.invalid/api/ceph/71", { method: "DELETE",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: "71" }) });
beforeEach(() => {
  vi.resetAllMocks(); m.session.mockResolvedValue(admitted()); m.access.mockResolvedValue(true);
  m.study.mockResolvedValue({ analysis: { patientId: 11, documentId: 22, status: "draft" } });
  m.discard.mockResolvedValue({ ok: true });
  m.list.mockResolvedValue([]); m.create.mockResolvedValue({ ok: true, id: 81 }); m.duplicate.mockResolvedValue({ ok: true, id: 82 });
});
describe("ceph soft-discard authenticated HTTP boundary", () => {
  it.each(["admin", "doctor", "reception"])("preserves authorized clinic role %s", async role => {
    const session = admitted(role); m.session.mockResolvedValue(session);
    expect((await call()).status).toBe(200);
    expect(m.discard).toHaveBeenCalledExactlyOnceWith(71, "Synthetic discard reason",
      { patientId: 11, documentId: 22, session });
  });
  it("ignores forged patient, image and operator context in request JSON", async () => {
    const session = admitted(); m.session.mockResolvedValue(session);
    expect((await call({ note: "Keep this reason", patientId: 999, documentId: 999,
      by: "forged", session: { role: "admin" } })).status).toBe(200);
    expect(m.discard).toHaveBeenCalledExactlyOnceWith(71, "Keep this reason",
      { patientId: 11, documentId: 22, session });
  });
  it.each([401, 403, 409] as const)("maps transactional refusal %s without success", async status => {
    m.discard.mockRejectedValue(new ClinicalMutationAuthorityError(status, "Synthetic lifecycle refusal"));
    const response = await call();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ message: "Synthetic lifecycle refusal" });
  });
  it("keeps completed-history refusal as conflict", async () => {
    m.discard.mockResolvedValue({ ok: false, message: "Completed history cannot be discarded" });
    const response = await call();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: "Completed history cannot be discarded" });
  });
  it("does not report audit or storage failure as success", async () => {
    m.discard.mockRejectedValue(new Error("Synthetic private database error"));
    const response = await call();
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("Synthetic private");
  });
  it("requires session and patient imaging access before invoking the writer", async () => {
    m.session.mockResolvedValue(null); expect((await call()).status).toBe(401);
    expect(m.discard).not.toHaveBeenCalled();
    m.session.mockResolvedValue(admitted()); m.access.mockResolvedValue(false);
    expect((await call()).status).toBe(403); expect(m.discard).not.toHaveBeenCalled();
  });
});

describe("ceph creation and correction HTTP admission", () => {
  const createCall = (body: unknown) => create(new Request("https://test.invalid/api/patients/11/ceph", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: "11" }) });
  const duplicateCall = () => duplicate(new Request("https://test.invalid/api/ceph/71/duplicate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patientId: 999, documentId: 999, by: "forged", session: { role: "admin" } }),
  }), { params: Promise.resolve({ id: "71" }) });
  it.each(["admin", "doctor", "reception"])("preserves scoped clinic role %s for creation and correction", async role => {
    const session = admitted(role); m.session.mockResolvedValue(session);
    expect((await createCall({ documentId: 22, phase: "during", patientId: 999, createdBy: "forged", session: { role: "admin" } })).status).toBe(201);
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ patientId: 11, documentId: 22, phase: "during" }),
      { patientId: 11, documentId: 22, session });
    expect(m.create.mock.calls[0][0]).not.toHaveProperty("createdBy");
    expect((await duplicateCall()).status).toBe(201);
    expect(m.duplicate).toHaveBeenCalledExactlyOnceWith(71, { patientId: 11, documentId: 22, session });
  });
  it.each([401, 403, 409] as const)("maps current-authority refusal %s from both writers", async status => {
    const error = new ClinicalMutationAuthorityError(status, "Synthetic lifecycle refusal");
    m.create.mockRejectedValue(error); m.duplicate.mockRejectedValue(error);
    for (const response of [await createCall({ documentId: 22 }), await duplicateCall()]) {
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ message: "Synthetic lifecycle refusal" });
    }
  });
  it("keeps domain conflicts distinct from success", async () => {
    m.create.mockResolvedValue({ ok: false, message: "Draft already exists" });
    m.duplicate.mockResolvedValue({ ok: false, message: "Source must be completed" });
    expect((await createCall({ documentId: 22 })).status).toBe(409);
    expect((await duplicateCall()).status).toBe(409);
  });
});
