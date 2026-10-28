import { beforeEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ requireSession: vi.fn(), updateLabOrderClinical: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/db", () => ({ updateLabOrderClinical: boundary.updateLabOrderClinical }));
import { PATCH } from "../app/api/lab/[id]/route";
const previous = { doctorId: null, workType: "طقم جزئي", toothNumbers: "11 (crown)", shade: "OM3", shadeSpecification: null, partyId: null, labName: "Synthetic lab", labPhone: null };
const clinical = { ...previous, doctorId: 12, toothNumbers: "11 (denture_tooth)" };
const payload = { action: "update_clinical", clinical, expectedClinical: previous };
const patch = (body: unknown = payload) => PATCH(new Request("http://synthetic.invalid/api/lab/1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: "1" }) });
beforeEach(() => { vi.resetAllMocks(); boundary.requireSession.mockResolvedValue({ username: "synthetic-admin", role: "admin" }); boundary.updateLabOrderClinical.mockResolvedValue("updated"); });
describe("clinical correction route", () => {
  it("forwards explicit correction and observed legacy snapshot", async () => {
    expect((await patch()).status).toBe(200);
    expect(boundary.updateLabOrderClinical).toHaveBeenCalledWith(1, expect.objectContaining({ clinical, expectedClinical: previous }));
  });
  it.each(["cashier", "assistant", "accountant"])("denies %s", async role => {
    boundary.requireSession.mockResolvedValue({ username: "synthetic-staff", role });
    expect((await patch()).status).toBe(403); expect(boundary.updateLabOrderClinical).not.toHaveBeenCalled();
  });
  it.each([["financial_doctor_locked",409],["conflict",409],["financial_lab_locked",409],["invalid",400],["forbidden",403],["not_found",404]] as const)("maps %s without false success", async (result,status) => {
    boundary.updateLabOrderClinical.mockResolvedValue(result); expect((await patch()).status).toBe(status);
  });
  it("refuses implicit correction or absent observed version", async () => {
    expect((await patch({ ...payload, clinical: { ...clinical, toothNumbers: "11 (crown)" } })).status).toBe(400);
    expect((await patch({ action: "update_clinical", clinical })).status).toBe(400);
    expect(boundary.updateLabOrderClinical).not.toHaveBeenCalled();
  });
});
