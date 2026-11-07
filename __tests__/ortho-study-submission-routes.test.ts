import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiRouteVerdict } from "../lib/http-permissions";
const state = vi.hoisted(() => ({ session: { userId: 7, username: "synthetic-study", role: "doctor", expiresAt: 4102444800000 } as Record<string, unknown> | null,
  access: true, read: vi.fn(), save: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: async () => state.session }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: async () => state.access }));
vi.mock("../lib/ortho-study-submission-store", () => ({ getStudySubmissionRecovery: state.read, transitionStudySubmission: state.save }));
import { GET, POST } from "../app/api/ortho/[id]/case-study/recovery/route";
import { JSON_BODY_LIMIT_BYTES } from "../lib/security-limits";
const context = { params: Promise.resolve({ id: "41" }) };
const command = { actorId:7, clinicalCaseId: 51, commandId: "synthetic_study_route_0001", requestFingerprint: "a".repeat(64), action: "acknowledge" };
const post = (body: unknown = { patientId: 19, ...command }, query = "") => new Request(`http://localhost/api/ortho/41/case-study/recovery${query}`,
  { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = (query = "?patientId=19") => new Request(`http://localhost/api/ortho/41/case-study/recovery${query}`);
beforeEach(() => { state.session = { userId: 7, username: "synthetic-study", role: "doctor", expiresAt: 4102444800000 }; state.access = true;
  state.read.mockReset(); state.save.mockReset(); state.read.mockResolvedValue({ ok: true, revision: null }); state.save.mockResolvedValue({ ok: true, replayed: false }); });
describe("durable study recovery route admission", () => {
  it.each(["/recovery"])("has exact registered scope for %s", path => {
    expect(apiRouteVerdict(`/api/ortho/41/case-study${path}`, "GET")).toEqual({ kind: "registered", pattern: `/api/ortho/[id]/case-study${path}`, access: ["admin", "reception", "doctor"] });
    expect(apiRouteVerdict(`/api/ortho/41/case-study${path}`, "POST")).toMatchObject({ kind: "registered", access: ["admin", "doctor"] });
    expect(apiRouteVerdict(`/api/ortho/41/case-study${path}`, "DELETE").kind).not.toBe("registered");
  });
  it.each(["reception", "assistant", "accountant", "cashier"])("denies %s writes before persistence", async role => {
    state.session = { ...state.session, role }; expect((await POST(post(), context)).status).toBe(403); expect(state.save).not.toHaveBeenCalled();
  });
  it("admits reception read only with the same private response policy", async () => {
    state.session = { ...state.session, role: "reception" };
    const response = await GET(get(), context); expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(state.read).toHaveBeenCalledWith(expect.objectContaining({ patientId: 19, orthoCaseId: 41, session: state.session }));
  });
  it("refuses unauthenticated and cross-patient requests before any source access", async () => {
    state.session = null; expect((await GET(get(), context)).status).toBe(401); state.session = { userId: 7, role: "doctor" }; state.access = false;
    expect((await GET(get(), context)).status).toBe(403); expect((await POST(post(), context)).status).toBe(403);
    expect(state.read).not.toHaveBeenCalled(); expect(state.save).not.toHaveBeenCalled();
  });
  it("rejects duplicate or foreign query fields and malformed identity", async () => {
    for (const query of ["?patientId=19&patientId=20", "?patientId=19&invoiceId=7", "?patientId=0", "?patientId=19&revisionId=abc"])
      expect((await GET(get(query), context)).status).toBe(400);
    expect((await POST(post({ patientId: 19, ...command, planId: 2 }), context)).status).toBe(400);
    expect(state.read).not.toHaveBeenCalled(); expect(state.save).not.toHaveBeenCalled();
  });
  it("bounds bodies and returns uncertain errors without inventing success", async () => {
    expect((await POST(post({ patientId: 19, command: "x".repeat(JSON_BODY_LIMIT_BYTES) }), context)).status).toBe(413);
    expect(state.save).not.toHaveBeenCalled(); state.save.mockRejectedValue(Error("synthetic transport failure"));
    const response = await POST(post(), context); expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, code: "write_unconfirmed" });
  });
});
