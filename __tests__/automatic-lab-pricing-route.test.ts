import { beforeEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({
  createLabOrder: vi.fn(), getSettings: vi.fn(), listParties: vi.fn(), recordAudit: vi.fn(), requireSession: vi.fn(), listLabServices: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/db", () => ({ ...boundary, findUserByUsername: vi.fn(), labCounts: vi.fn(),
  listLabNames: vi.fn(), listLabOrders: vi.fn() }));
import { POST } from "../app/api/lab/route";
import { LabOrderPricingConflict } from "../lib/lab-order-pricing";
import { withDefaults } from "../lib/settings";

const draft = { doctorId: 601, patientId: 101, visitId: 201, toothCode: 16, partyId: 301,
  labServiceId: 401, labName: "Synthetic FX lab", workType: "Synthetic crown",
  sentDate: "2026-10-03", dueDate: "2026-10-10", toothNumbers: "16,17,18" };
const created = { id: 501, patientId: 101, patientName: "Synthetic FX patient", labName: draft.labName,
  workType: draft.workType, dueDate: draft.dueDate, costMinor: 7500, costCurrency: "USD" };
const request = (extra: Record<string, unknown> = {}) => new Request("http://test.invalid/api/lab", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...draft, ...extra }),
});
beforeEach(() => {
  vi.resetAllMocks();
  boundary.requireSession.mockResolvedValue({ username: "synthetic-fx-admin", role: "admin" });
  boundary.getSettings.mockResolvedValue(withDefaults({ "finance.rate.USD": "531.125", "finance.rate.SAR": "141.25" }));
  boundary.listParties.mockImplementation(async kind => kind === "doctor" ? [{ id: 601, kind: "doctor", isActive: true }] : [{ id: 301 }]);
  boundary.listLabServices.mockResolvedValue([{ id: 401, name: "Synthetic crown", code: "CRN_TEST", isActive: true }]);
  boundary.createLabOrder.mockResolvedValue(created);
});

describe("actual lab POST automatic pricing error boundary (synthetic writer stub)", () => {
  it.each(["lab_order_exchange_rate_invalid", "lab_order_automatic_price_invalid"] as const)(
    "returns honest 409 for %s without success audit", async code => {
      const error = new LabOrderPricingConflict(code);
      boundary.createLabOrder.mockRejectedValue(error);
      const response = await POST(request());
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code, message: error.message });
      expect(boundary.recordAudit).not.toHaveBeenCalled();
    });
  it("retains omitted cost and currency for the canonical transactional resolver", async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(boundary.createLabOrder).toHaveBeenCalledWith(expect.objectContaining({
      costMinor: null, costCurrency: null, exchangeRate: 1, baseCurrency: "YER", source: "manual",
      patientId: 101, visitId: 201, toothCode: 16, toothNumbers: "16,17,18", labServiceId: 401,
    }));
    expect(boundary.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "lab_order.create", entityId: "501", details: expect.objectContaining({ التكلفة: 7500, العملة: "USD" }),
    }));
  });
  it.each([["USD", 531.125, 2500], ["SAR", 141.25, 2500], ["YER", 1, 25]])(
    "preserves explicit manual %s route conversion", async (costCurrency, exchangeRate, costMinor) => {
      expect((await POST(request({ cost: "25", costCurrency }))).status).toBe(201);
      expect(boundary.createLabOrder).toHaveBeenCalledWith(expect.objectContaining({ costMinor, costCurrency, exchangeRate }));
    });
  it("preserves explicit zero rejection", async () => {
    expect((await POST(request({ cost: "0", costCurrency: "YER" }))).status).toBe(400);
    expect(boundary.createLabOrder).not.toHaveBeenCalled();
  });
  it("preserves the explicit manual invalid-FX 409", async () => {
    boundary.getSettings.mockResolvedValue(withDefaults({ "finance.rate.USD": "invalid" }));
    expect((await POST(request({ cost: "25", costCurrency: "USD" }))).status).toBe(409);
    expect(boundary.createLabOrder).not.toHaveBeenCalled();
  });
  it("treats untyped lookalikes and storage failures as the existing 500", async () => {
    for (const error of [new Error("Synthetic failure"), { code: "lab_order_exchange_rate_invalid" }]) {
      boundary.createLabOrder.mockRejectedValue(error);
      expect((await POST(request())).status).toBe(500);
    }
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });
  it("retains unauthenticated admission", async () => {
    boundary.requireSession.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
    expect(boundary.createLabOrder).not.toHaveBeenCalled();
  });
});


describe("lab prescription creation admission", () => {
  it("requires explicit doctor attribution for a sent prescription", async () => {
    expect((await POST(request({ doctorId: null }))).status).toBe(400);
    expect(boundary.createLabOrder).not.toHaveBeenCalled();
  });
  it("rejects inactive or non-doctor parties", async () => {
    boundary.listParties.mockResolvedValue([{ id: 601, kind: "lab", isActive: true }]);
    expect((await POST(request())).status).toBe(409);
    expect(boundary.createLabOrder).not.toHaveBeenCalled();
  });
  it("binds doctor attribution to the logged-in doctor", async () => {
    boundary.requireSession.mockResolvedValue({ username: "synthetic-doctor", role: "doctor", partyId: 601 });
    expect((await POST(request({ doctorId: 602 }))).status).toBe(403);
    expect((await POST(request({ doctorId: null }))).status).toBe(201);
    expect(boundary.createLabOrder).toHaveBeenCalledWith(expect.objectContaining({ doctorId: 601 }));
  });
  it("rejects crown roles for dentures instead of silently remapping", async () => {
    expect((await POST(request({ workType: "Partial cast denture", toothNumbers: "16 (crown)" }))).status).toBe(400);
    expect(boundary.createLabOrder).not.toHaveBeenCalled();
  });
  it("also checks the canonical selected service for denture roles", async () => {
    boundary.listLabServices.mockResolvedValue([{ id: 401, name: "Partial cast denture", code: "DNT_CAST", isActive: true }]);
    expect((await POST(request({ toothNumbers: "16 (crown)" }))).status).toBe(400);
    expect(boundary.createLabOrder).not.toHaveBeenCalled();
  });
  it("persists validated multi-zone shades without converting the legacy global code", async () => {
    const shadeSpecification = { version: 1, teeth: [{ toothCode: 16, cervical: { guide: "vita_classical", code: "A2" }, body: { guide: "vita_3d_master", code: "0M1" }, incisal: null }] };
    expect((await POST(request({ shade: "BL2", shadeSpecification }))).status).toBe(201);
    expect(boundary.createLabOrder).toHaveBeenCalledWith(expect.objectContaining({ shade: "BL2", shadeSpecification }));
    boundary.createLabOrder.mockClear();
    expect((await POST(request({ shadeSpecification: { ...shadeSpecification, teeth: [{ ...shadeSpecification.teeth[0], toothCode: 21 }] } }))).status).toBe(400);
    expect(boundary.createLabOrder).not.toHaveBeenCalled();
  });
});
