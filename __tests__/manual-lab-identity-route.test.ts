import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  createLabOrder: vi.fn(), getSettings: vi.fn(), listParties: vi.fn(), recordAudit: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: async () => ({ username: "synthetic-lab-admin", role: "admin" }) }));
vi.mock("@/lib/db", () => ({
  ...boundary, findUserByUsername: vi.fn(), labCounts: vi.fn(), listLabNames: vi.fn(),
  listLabOrders: vi.fn(), listLabServices: vi.fn(),
}));
import { POST } from "../app/api/lab/route";
import { LabOrderIdentityConflict } from "../lib/lab-order-identity";
import { PENDING_LAB_NAME } from "../lib/lab";

// In-process mapping only, with synthetic already-linked context. No HTTP server,
// real patient information, or unlinked-visit authorization/privacy exercise.
const draft = {
  patientId: 101, visitId: 201, toothCode: 16, labName: "Synthetic identity lab",
  workType: "Synthetic crown", sentDate: "2026-10-03", dueDate: "2026-10-10",
};
const created = {
  id: 301, patientId: 101, visitId: 201, patientName: "Synthetic lab owner A",
  labName: draft.labName, workType: draft.workType, dueDate: draft.dueDate,
  costMinor: null, costCurrency: null,
};
const request = (extra: Record<string, unknown> = {}) => new Request("http://test.invalid/api/lab", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...draft, ...extra }),
});
beforeEach(() => {
  vi.resetAllMocks();
  boundary.getSettings.mockResolvedValue({});
  boundary.listParties.mockResolvedValue([]);
  boundary.createLabOrder.mockResolvedValue(created);
  boundary.recordAudit.mockResolvedValue(undefined);
});

describe("manual lab identity response mapping", () => {
  it.each(["sent", "needed"])("maps typed %s identity conflict to 409 without success audit", async status => {
    const conflict = new LabOrderIdentityConflict();
    boundary.createLabOrder.mockRejectedValue(conflict);
    const response = await POST(request({ status }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "lab_order_identity_changed", message: conflict.message });
    expect(boundary.createLabOrder).toHaveBeenCalledTimes(1);
    expect(boundary.createLabOrder).toHaveBeenCalledWith(expect.objectContaining({ patientId: 101, visitId: 201, status }));
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });
  it("retains duplicate linked-tooth 409 without success audit", async () => {
    boundary.createLabOrder.mockResolvedValue(null);
    const response = await POST(request({ status: "needed" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: "طلب مختبر مسجَّل سلفًا لهذا السن في هذه الزيارة." });
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });
  it.each([
    new Error("Synthetic storage failure"),
    Object.assign(new Error("Synthetic lookalike"), { code: "lab_order_identity_changed", name: "LabOrderIdentityConflict" }),
  ])("keeps unexpected errors at 500 without success audit (%s)", async error => {
    boundary.createLabOrder.mockRejectedValue(error);
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "تعذّر حفظ العمل. تأكد من المريض وأعد المحاولة." });
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });
  it("retains unclassified null result as 500", async () => {
    boundary.createLabOrder.mockResolvedValue(null);
    const response = await POST(request({ visitId: null }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "تعذّر حفظ العمل." });
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });
  it.each([201, null])("retains 201 and one success audit with visitId=%s", async visitId => {
    const result = { ...created, visitId };
    boundary.createLabOrder.mockResolvedValue(result);
    const response = await POST(request({ visitId }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(result);
    expect(boundary.createLabOrder).toHaveBeenCalledWith(expect.objectContaining({
      patientId: 101, visitId, source: "manual", status: "sent", createdBy: "synthetic-lab-admin", actorRole: "admin",
    }));
    expect(boundary.recordAudit).toHaveBeenCalledTimes(1);
    expect(boundary.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "lab_order.create", entity: "lab_order", entityId: "301", actor: "synthetic-lab-admin", actorRole: "admin",
    }));
  });
  it("retains quick-needed normalization and success audit", async () => {
    const response = await POST(request({ status: "needed", labName: undefined, sentDate: undefined, dueDate: undefined }));
    expect(response.status).toBe(201);
    expect(boundary.createLabOrder).toHaveBeenCalledWith(expect.objectContaining({
      patientId: 101, visitId: 201, toothCode: 16, status: "needed", labName: PENDING_LAB_NAME,
    }));
    expect(boundary.recordAudit).toHaveBeenCalledTimes(1);
  });
});
