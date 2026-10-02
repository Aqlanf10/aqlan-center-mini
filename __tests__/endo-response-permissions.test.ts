import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: vi.fn() }));
vi.mock("@/lib/endodontics-db", () => ({
  listPatientEndo: vi.fn(), openEndoTreatment: vi.fn(), changeEndoStatus: vi.fn(),
  saveEndoVisit: vi.fn(), addEndoAddendum: vi.fn(), setEndoCrown: vi.fn(),
  OPEN_ENDO_MESSAGE: {}, ENDO_STATUS_MESSAGE: {}, SAVE_ENDO_VISIT_MESSAGE: {}, ENDO_ADDENDUM_MESSAGE: {}, ENDO_CROWN_MESSAGE: {},
}));
import { requireSession } from "../lib/session";
import { canAccessPatient } from "../lib/patient-access";
import * as db from "../lib/endodontics-db";
import { GET, POST } from "../app/api/patients/[id]/endo/route";
import { PATCH as status } from "../app/api/patients/[id]/endo/[treatmentId]/route";
import { PATCH as crown } from "../app/api/patients/[id]/endo/[treatmentId]/crown/route";
import { PUT } from "../app/api/patients/[id]/endo/[treatmentId]/visits/route";
import { POST as addendum } from "../app/api/patients/[id]/endo/[treatmentId]/visits/[endoVisitId]/addenda/route";
import { summarizeEndo } from "../lib/endodontics";
const view = { id: 1, status: "completed", crownRequired: true, restorativeStatus: "temporary",
  crownPlanItem: { id: 999, name: "PRIVATE PLAN TITLE", status: "done" }, crown: "planned_done",
  summary: summarizeEndo([], new Map()), nextAction: "PRIVATE PLAN TITLE", visits: [] } as unknown as db.EndoTreatmentView;
const params = { params: Promise.resolve({ id: "1", treatmentId: "1", endoVisitId: "1" }) };
const req = (body: object = {}) => new Request("https://synthetic.invalid/api/patients/1/endo", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireSession).mockResolvedValue({ username: "synthetic", role: "doctor", userId: 1, expiresAt: Date.now() + 10000 });
  vi.mocked(canAccessPatient).mockImplementation(async (_session, _id, capability) => capability !== "canViewPlans");
  vi.mocked(db.listPatientEndo).mockResolvedValue([view]);
  vi.mocked(db.openEndoTreatment).mockResolvedValue({ ok: true, treatment: view });
  vi.mocked(db.changeEndoStatus).mockResolvedValue({ ok: true, treatment: view });
  vi.mocked(db.saveEndoVisit).mockResolvedValue({ ok: true, treatment: view, created: false, unchanged: false });
  vi.mocked(db.addEndoAddendum).mockResolvedValue({ ok: true, created: true, treatment: view });
  vi.mocked(db.setEndoCrown).mockResolvedValue({ ok: true, treatment: view });
});
describe("Endodontics response permissions across actual handlers", () => {
  it.each(["doctor", "assistant"] as const)("redacts plan fields and derived progress for %s on GET", async (role) => {
    vi.mocked(requireSession).mockResolvedValue({ username: "synthetic", role, userId: 1, expiresAt: Date.now() + 10000 });
    const response = await GET(req(), params);
    const text = await response.text();
    expect(response.status).toBe(200); expect(text).not.toContain("PRIVATE"); expect(text).not.toContain("999");
    expect(JSON.parse(text).treatments[0]).toMatchObject({ crownPlanItem: null, crown: "ready" });
  });
  it.each([
    ["open", () => POST(req({ caseId: 1, toothCode: 36 }), params)],
    ["status", () => status(req({ status: "completed" }), params)],
    ["visit", () => PUT(req({ visitId: 1, stage: "review", note: "clinical" }), params)],
    ["addendum", () => addendum(req({ text: "correction", requestKey: "endo:handler-key" }), params)],
    ["crown", () => crown(req({ crownRequired: false }), params)],
  ] as const)("also redacts the %s mutation response", async (_name, run) => {
    const response = await run(); const text = await response.text();
    expect(response.status).toBeLessThan(300); expect(text).not.toContain("PRIVATE"); expect(text).not.toContain("999");
    expect(JSON.parse(text).crownPlanItem).toBeNull();
  });
  it("returns the complete authorized view", async () => {
    vi.mocked(canAccessPatient).mockResolvedValue(true);
    expect(await (await GET(req(), params)).json()).toEqual({ treatments: [view] });
  });
});
