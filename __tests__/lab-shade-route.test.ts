import { beforeEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ requireSession: vi.fn(), updateLabOrderShades: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/db", () => ({ updateLabOrderShades: boundary.updateLabOrderShades }));
import { PATCH } from "../app/api/lab/[id]/route";
const specification = { version: 1, teeth: [{ toothCode: 11, cervical: { guide: "vita_classical", code: "A2" }, body: { guide: "vita_3d_master", code: "0M1" }, incisal: null }] };
const input = { action: "update_shade", shadeSpecification: specification, expectedShadeSpecification: null };
const patch = (body: unknown = input) => PATCH(new Request("http://synthetic.invalid/api/lab/1", {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: "1" }) });
beforeEach(() => {
  vi.resetAllMocks();
  boundary.requireSession.mockResolvedValue({ username: "synthetic-admin", role: "admin" });
  boundary.updateLabOrderShades.mockResolvedValue("updated");
});
describe("structured shade PATCH admission", () => {
  it.each([null, "assistant", "cashier", "accountant"])("rejects unauthorized %s before persistence", async role => {
    boundary.requireSession.mockResolvedValue(role ? { username: "synthetic-staff", role } : null);
    expect((await patch()).status).toBe(role ? 403 : 401);
    expect(boundary.updateLabOrderShades).not.toHaveBeenCalled();
  });
  it.each(["admin", "reception", "doctor"])("passes validated optimistic versions and actor for %s", async role => {
    const session = { username: "synthetic-staff", role };
    boundary.requireSession.mockResolvedValue(session);
    expect((await patch()).status).toBe(200);
    expect(boundary.updateLabOrderShades).toHaveBeenCalledWith(1, { shadeSpecification: specification, expectedShadeSpecification: null, session });
  });
  it("requires the observed previous value and rejects unknown metadata", async () => {
    for (const body of [{ action: "update_shade", shadeSpecification: specification },
      { ...input, shadeSpecification: { ...specification, patientName: "PRIVATE_CANARY" } }]) {
      expect((await patch(body)).status).toBe(400);
    }
    expect(boundary.updateLabOrderShades).not.toHaveBeenCalled();
  });
  it.each([["conflict", 409], ["forbidden", 403], ["not_found", 404], ["invalid", 400]] as const)("returns %s without false success", async (result, status) => {
    boundary.updateLabOrderShades.mockResolvedValue(result);
    expect((await patch()).status).toBe(status);
  });
});
