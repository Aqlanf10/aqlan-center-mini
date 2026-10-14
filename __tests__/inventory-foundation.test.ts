import { beforeEach, describe, expect, it, vi } from "vitest";
import { stockStatus } from "../lib/inventory";
import { inventoryValuation } from "../lib/inventory-domain/valuation";
const mocks = vi.hoisted(() => ({ session: vi.fn(), detail: vi.fn(), items: vi.fn() }));
vi.mock("@/lib/inventory-domain/read", () => ({ inventoryDetailWithLinks: mocks.detail }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db", () => ({ getInventoryItemDetail: mocks.detail, updateInventoryItem: vi.fn(), listInventoryItems: mocks.items }));
import { GET } from "../app/api/inventory/[id]/route";
import { getInventorySummary } from "../lib/ai-tools/inventory-tools";
import type { AiToolContext } from "../lib/ai-tools/types";

beforeEach(() => { vi.clearAllMocks(); mocks.session.mockResolvedValue({ role: "doctor", username: "synthetic" }); });
describe("Inventory foundation desired invariants", () => {
  it("INV-09: an unknown opening price is not a known zero", () => {
    expect(inventoryValuation([{ kind: "in", qty: 10 }]).unitCostMinor).toBeNull();
  });
  it("INV-11: reaching the reorder boundary is low", () => { expect(stockStatus(5, 5)).toBe("low"); });
  it("INV-08: non-admin detail has no structured purchase price", async () => {
    mocks.detail.mockResolvedValue({ item: { id: 1 }, movements: [{ id: 1, kind: "in", qty: 10, unitCostMinor: 938475, payableId: 17 }], batches: { batches: [], adjustTotal: 0 } });
    const res = await GET(new Request("http://localhost/api/inventory/1"), { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain("unitCostMinor");
  });
  it("INV-12: existing summary reports unavailable without internal error disclosure", async () => {
    mocks.items.mockRejectedValue(new Error("private database detail"));
    const result = await getInventorySummary({}, { isDbConnected: true } as AiToolContext);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private database detail");
  });
});

describe("valuation completeness without historical repricing", () => {
  it("keeps true zero and ordinary WAC known", () => {
    expect(inventoryValuation([{ kind: "in", qty: 10, unitCostMinor: 0 }])).toMatchObject({ valueMinor: 0, costStatus: "known" });
    expect(inventoryValuation([{ kind: "in", qty: 10, unitCostMinor: 100 }, { kind: "in", qty: 10, unitCostMinor: 200 }, { kind: "out", qty: 2 }])).toMatchObject({ qty: 18, valueMinor: 2700, costStatus: "known" });
  });
  it("does not fill unknown purchases using preceding prices", () => {
    expect(inventoryValuation([{ kind: "in", qty: 10, unitCostMinor: 100 }, { kind: "in", qty: 10 }, { kind: "out", qty: 2 }])).toMatchObject({ valueMinor: null, unitCostMinor: null, costStatus: "missing" });
  });
  it("an exhausted pool can start a new known valuation", () => {
    expect(inventoryValuation([{ kind: "in", qty: 10 }, { kind: "out", qty: 10 }, { kind: "in", qty: 2, unitCostMinor: 100 }])).toMatchObject({ valueMinor: 200, costStatus: "known" });
  });
  it("unlinked historical returns remain estimated, not proven original costs", () => {
    expect(inventoryValuation([{ kind: "in", qty: 10, unitCostMinor: 100 }, { kind: "out", qty: 4 }, { kind: "in", qty: 1, isReturn: true }])).toMatchObject({ valueMinor: 700, costStatus: "estimated" });
    expect(inventoryValuation([{ kind: "in", qty: 1, isReturn: true }]).costStatus).toBe("missing");
  });
  it("missing stock and invalid value do not imply complete zero", () => {
    expect(inventoryValuation([{ kind: "adjust", qty: 2 }]).valueMinor).toBeNull();
    expect(() => inventoryValuation([{ kind: "in", qty: 1e20, unitCostMinor: 100 }])).toThrow("overflow");
  });
});

describe("detail authorization response", () => {
  it("admin retains purchase cost and existing payable reference", async () => {
    mocks.session.mockResolvedValue({ role: "admin", username: "synthetic" });
    mocks.detail.mockResolvedValue({ item: { id: 1 }, movements: [{ id: 1, unitCostMinor: 123, payableId: 45 }], batches: {} });
    const response = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: "1" }) });
    expect((await response.json()).movements[0]).toMatchObject({ unitCostMinor: 123, payableId: 45 });
  });
  it("rejects unauthenticated reads before touching storage", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await GET(new Request("http://localhost"), { params: Promise.resolve({ id: "1" }) })).status).toBe(401);
    expect(mocks.detail).not.toHaveBeenCalled();
  });
});
