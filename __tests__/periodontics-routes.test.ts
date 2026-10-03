import { beforeEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ requireSession: vi.fn(), canAccessPatient: vi.fn(), listPatientPerio: vi.fn(), savePerioExam: vi.fn(), addPerioAddendum: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: boundary.canAccessPatient }));
vi.mock("@/lib/periodontics-db", () => ({ ...boundary, PERIO_MESSAGE: {
  not_found: "غير موجود", revision_conflict: "تغيّر السجل", visit_signed: "موقّع", idempotency_conflict: "مفتاح مختلف", bad_case: "حالة غير صالحة",
} }));
import { GET } from "../app/api/patients/[id]/perio/route";
import { PUT } from "../app/api/patients/[id]/perio/visits/[visitId]/route";
import { POST } from "../app/api/patients/[id]/perio/exams/[examId]/addenda/route";
const context = { params: Promise.resolve({ id: "9", visitId: "21", examId: "7" }) };
const body = { doctorId: 3, caseId: null, expectedRevision: null, sites: [{ toothCode: 11, site: "MB", probingDepthMm: 0, bleedingOnProbing: false }] };
const request = (data: unknown, method = "PUT") => new Request("http://localhost/api/patients/9/perio", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
beforeEach(() => {
  vi.resetAllMocks(); boundary.requireSession.mockResolvedValue({ role: "doctor", username: "recorder", partyId: 99 }); boundary.canAccessPatient.mockResolvedValue(true);
  boundary.listPatientPerio.mockResolvedValue([]); boundary.savePerioExam.mockResolvedValue({ ok: true, created: true, unchanged: false, exam: { id: 7 } });
  boundary.addPerioAddendum.mockResolvedValue({ ok: true, created: true, unchanged: false, exam: { id: 7 } });
});
describe("patient-scoped periodontal routes", () => {
  it.each([null, { role: "cashier", username: "cashier" }, { role: "accountant", username: "accountant" }])("rejects unauthenticated/unauthorized reads and all writes", async (session) => {
    boundary.requireSession.mockResolvedValue(session); boundary.canAccessPatient.mockResolvedValue(false);
    expect((await GET(new Request("http://localhost"), context)).status).toBe(session ? 403 : 401);
    expect((await PUT(request(body), context)).status).toBe(session ? 403 : 401);
    expect(boundary.listPatientPerio).not.toHaveBeenCalled(); expect(boundary.savePerioExam).not.toHaveBeenCalled();
  });
  it("reception can read an accessible patient but cannot write or append", async () => {
    boundary.requireSession.mockResolvedValue({ role: "reception", username: "reception" });
    expect((await GET(new Request("http://localhost"), context)).status).toBe(200);
    expect((await PUT(request(body), context)).status).toBe(403);
    expect((await POST(request({ text: "Correction", requestKey: "perio:route-key" }, "POST"), context)).status).toBe(403);
  });
  it("fails closed for another patient's guard and before body/storage work", async () => {
    boundary.canAccessPatient.mockResolvedValue(false);
    expect((await PUT(request(body), context)).status).toBe(403); expect(boundary.savePerioExam).not.toHaveBeenCalled();
    expect((await POST(request({ text: "Correction", requestKey: "perio:route-key" }, "POST"), context)).status).toBe(403); expect(boundary.addPerioAddendum).not.toHaveBeenCalled();
  });
  it("passes explicit treating provider separately from recorder and route patient/visit", async () => {
    expect((await PUT(request(body), context)).status).toBe(201);
    expect(boundary.savePerioExam).toHaveBeenCalledWith({ patientId: 9, visitId: 21, expectedRevision: null,
      actor: "recorder", actorRole: "doctor", draft: { doctorId: 3, caseId: null, sites: body.sites } });
  });
  it("rejects missing revision, string/precision coercion and fabricated negative defaults", async () => {
    for (const changes of [{ expectedRevision: undefined }, { expectedRevision: "1" }, { doctorId: "3" }, { sites: [{ ...body.sites[0], probingDepthMm: 1.234 }] }, { sites: [{ toothCode: 11, site: "MB" }] }]) expect((await PUT(request({ ...body, ...changes }), context)).status).toBe(400);
    expect(boundary.savePerioExam).not.toHaveBeenCalled();
  });
  it.each([["not_found", 404], ["revision_conflict", 409], ["visit_signed", 409], ["bad_case", 400]])("returns structured refusal %s", async (reason, status) => {
    boundary.savePerioExam.mockResolvedValue({ ok: false, reason }); const response = await PUT(request(body), context);
    expect(response.status).toBe(status); expect(await response.json()).toHaveProperty("code", reason);
  });
  it("retains the exact request key and actor on append; reports uncertain save as500", async () => {
    expect((await POST(request({ text: "  Correction  ", requestKey: "perio:route-key" }, "POST"), context)).status).toBe(201);
    expect(boundary.addPerioAddendum).toHaveBeenCalledWith({ patientId: 9, examId: 7, text: "Correction", requestKey: "perio:route-key", actor: "recorder", actorRole: "doctor" });
    boundary.savePerioExam.mockRejectedValue(new Error("synthetic uncertain commit"));
    const response = await PUT(request(body), context); expect(response.status).toBe(500); expect((await response.json()).message).toContain("تحميل");
  });
});
