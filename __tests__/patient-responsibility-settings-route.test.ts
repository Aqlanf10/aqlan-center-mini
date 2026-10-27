import { beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ session: vi.fn(), settings: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: deps.session }));
vi.mock("../lib/patient-responsibility-settings", () => ({ patientResponsibilitySettings: deps.settings,
  ResponsibilityError: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { GET, PATCH } from "../app/api/patients/[id]/responsibility/route";
import { ResponsibilityError } from "../lib/patient-responsibility-settings";
import { apiRouteVerdict } from "../lib/http-permissions";
const context = { params: Promise.resolve({ id: "19" }) };
const body = { kind: "ortho", sourceId: 3, expectedSourceFingerprint: "a".repeat(64), doctorId: 7, reason: "Synthetic transfer" };
const request = () => new Request("http://localhost/api/patients/19/responsibility?kind=ortho&sourceId=3", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); deps.session.mockResolvedValue({ userId: 1, username: "synthetic", role: "admin" }); deps.settings.mockResolvedValue({ doctorId: 7 }); });
it("passes exact patient/source and authenticated actor, never body authority", async () => { expect((await PATCH(request(), context)).status).toBe(200); expect(deps.settings).toHaveBeenCalledWith({ patientId: 19, kind: "ortho", sourceId: 3 }, { userId: 1, username: "synthetic", role: "admin" }, { expectedSourceFingerprint: body.expectedSourceFingerprint, doctorId: 7, reason: body.reason }); });
// No role-name gate in the route: the library decides from the actor's current grants and patient access.
it.each(["doctor", "reception"])("hands %s to the library and returns its grant refusal unchanged", async role => {
 deps.session.mockResolvedValue({ userId: 2, username: "synthetic", role });
 deps.settings.mockRejectedValue(new ResponsibilityError(403, "اعتماد الطبيب المسؤول يحتاج صلاحية تمنحها الإدارة من الإعدادات."));
 for (const response of [await PATCH(request(), context), await GET(request(), context)]) {
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ message: "اعتماد الطبيب المسؤول يحتاج صلاحية تمنحها الإدارة من الإعدادات." });
 }
 expect(deps.settings).toHaveBeenCalledTimes(2);
});
it("hides unexpected library failures behind a generic Arabic 500", async () => {
 deps.settings.mockRejectedValue(new Error("relation does not exist"));
 const response = await GET(request(), context);
 expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain("relation");
});
it("blocks anonymous requests", async () => { deps.session.mockResolvedValue(null); expect((await PATCH(request(), context)).status).toBe(401); expect(deps.settings).not.toHaveBeenCalled(); });
it("registers only roles that can reach patient files at the door; cashier, accountant and assistant are refused there", () => {
 for (const method of ["GET", "PATCH"]) expect(apiRouteVerdict("/api/patients/19/responsibility", method)).toMatchObject({ access: ["admin", "reception", "doctor"] });
});
