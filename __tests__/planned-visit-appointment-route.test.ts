import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ start: vi.fn(), audit: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: async () => ({username: "synthetic-reception", role: "reception"}) }));
vi.mock("../lib/reception-handoff-db", () => ({ listReceptionHandoffs: vi.fn() }));
vi.mock("../lib/db", () => ({ ActiveVisitExists: class extends Error {}, addVisit: vi.fn(), listTodayVisits: vi.fn(), recordAudit: state.audit, startVisitFromPlannedVisit: state.start }));
const { POST } = await import("../app/api/visits/route");
const post = () => POST(new Request("http://localhost/api/visits", { method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({plannedVisitId: 123}) }));
beforeEach(() => { state.start.mockReset(); state.audit.mockReset(); });
it("maps appointment conflict to 409 with rebooking guidance and no creation audit", async () => {
  state.start.mockResolvedValue({appointmentConflict: true});
  const response = await post();
  expect(response.status).toBe(409);
  expect((await response.json()).message).toContain("أعد الحجز");
  expect(state.start).toHaveBeenCalledWith({plannedVisitId: 123, actor: "synthetic-reception", actorRole: "reception"});
  expect(state.audit).not.toHaveBeenCalled();
});
it.each([[null, 404], [{alreadyActive: true, visitId: 9}, 409], [{id: 9, patientName: "synthetic"}, 201]])("preserves existing result %j mapping", async (result, status) => {
  state.start.mockResolvedValue(result);
  expect((await post()).status).toBe(status);
});
