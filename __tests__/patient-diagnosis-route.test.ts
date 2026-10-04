import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), list: vi.fn(), record: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.access }));
vi.mock("@/lib/db", () => ({
  listPatientDiagnoses: mocks.list, recordPatientDiagnosis: mocks.record, recordAudit: mocks.audit,
  DiagnosisAssociationError: class extends Error {
    constructor() { super("تعذّر ربط التشخيص بملف المريض والسجل المحدد."); }
  },
}));
import { DiagnosisAssociationError } from "../lib/db";
import { GET, POST } from "../app/api/patients/[id]/diagnoses/route";

const context = { params: Promise.resolve({ id: "11" }) };
const post = (extra: Record<string, unknown> = {}) => POST(new Request("http://test.invalid/api/patients/11/diagnoses", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: { note: "Synthetic diagnosis" }, ...extra }),
}), context);
const get = (query = "") => GET(new Request(`http://test.invalid/api/patients/11/diagnoses${query}`), context);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ role: "doctor", username: "synthetic-doctor", partyId: 31 });
  mocks.access.mockResolvedValue(true); mocks.list.mockResolvedValue([]);
  mocks.record.mockResolvedValue({ id: 51, version: 7 }); mocks.audit.mockResolvedValue(undefined);
});

describe("diagnosis clinical authorization and patient/case route", () => {
  it.each(["reception", "assistant", "cashier", "accountant"])("denies %s authoring even with patient read access", async (role) => {
    mocks.session.mockResolvedValue({ role, username: "synthetic-reader" });
    expect((await post({ orthoCaseId: 21 })).status).toBe(403);
    expect(mocks.record).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it.each(["doctor", "admin"])("preserves canonical patient access for %s", async (role) => {
    mocks.session.mockResolvedValue({ role, username: "synthetic-clinician" }); mocks.access.mockResolvedValue(false);
    expect((await post({ orthoCaseId: 21 })).status).toBe(403); expect((await get("?orthoCaseId=21")).status).toBe(403);
    expect(mocks.record).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled();
  });
  it("requires a session for reads and writes", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await post()).status).toBe(401); expect((await get()).status).toBe(401);
    expect(mocks.record).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled();
  });
  it.each([21, "21", null, undefined])("preserves valid optional linkage %j and canonical author", async (orthoCaseId) => {
    const response = await post({ orthoCaseId, createdBy: "spoofed-author" }); expect(response.status).toBe(201);
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ patientId: 11, orthoCaseId: orthoCaseId == null ? null : 21,
      visitId: null, createdBy: "synthetic-doctor" })); expect(mocks.audit).toHaveBeenCalledOnce();
  });
  it.each([0, -1, 1.5, 2147483648, true, false, [], [21], {}, "", " ", "1e2", "2.5", "bad"])("rejects supplied malformed case %j without writes", async (orthoCaseId) => {
    expect((await post({ orthoCaseId })).status).toBe(400); expect(mocks.record).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("maps a DB ownership refusal to a nonrevealing 400 without audit", async () => {
    mocks.record.mockRejectedValue(new DiagnosisAssociationError()); const response = await post({ orthoCaseId: 22 });
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ message: "تعذّر ربط التشخيص بملف المريض والسجل المحدد." });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("preserves unscoped patient history and explicitly forwards a case scope", async () => {
    const records = [{ id: 1, orthoCaseId: null }, { id: 2, orthoCaseId: 21 }, { id: 3, orthoCaseId: 22 }];
    mocks.list.mockResolvedValue(records); const response = await get();
    expect(await response.json()).toEqual({ diagnoses: records }); expect(mocks.list).toHaveBeenLastCalledWith(11);
    expect((await get("?orthoCaseId=21")).status).toBe(200); expect(mocks.list).toHaveBeenLastCalledWith(11, 21);
  });
  it.each(["", "0", "-1", "1.5", "1e2", "2147483648", "bad", "21&orthoCaseId=22"])("rejects malformed or duplicate read scope %s", async (value) => {
    expect((await get(`?orthoCaseId=${value}`)).status).toBe(400); expect(mocks.list).not.toHaveBeenCalled();
  });
  it("keeps failed reads and writes as failures", async () => {
    mocks.list.mockRejectedValue(new Error("synthetic read")); mocks.record.mockRejectedValue(new Error("synthetic write"));
    expect((await get("?orthoCaseId=21")).status).toBe(500); expect((await post()).status).toBe(500); expect(mocks.audit).not.toHaveBeenCalled();
  });
});
