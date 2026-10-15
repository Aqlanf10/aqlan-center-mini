import { beforeEach, describe, expect, it, vi } from "vitest";
import { stockStatus } from "../lib/inventory";
import { inventoryValuation } from "../lib/inventory-domain/valuation";
import { sanitizeInventoryAuditDetails, safeInventoryErrorMessage } from "../lib/inventory-domain/presentation";
const mocks = vi.hoisted(() => ({ session: vi.fn(), detail: vi.fn(), items: vi.fn(), visitPatientOf: vi.fn(), canAccessPatient: vi.fn(), recordMovement: vi.fn() }));
vi.mock("@/lib/inventory-domain/read", () => ({ inventoryDetailWithLinks: mocks.detail }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.canAccessPatient }));
vi.mock("@/lib/db", () => ({
  getInventoryItemDetail: mocks.detail,
  updateInventoryItem: vi.fn(),
  listInventoryItems: mocks.items,
  visitPatientOf: mocks.visitPatientOf,
  recordInventoryMovement: mocks.recordMovement,
}));
import { GET } from "../app/api/inventory/[id]/route";
import { POST as postMovement } from "../app/api/inventory/[id]/movements/route";
import { getInventorySummary } from "../lib/ai-tools/inventory-tools";
import type { AiToolContext } from "../lib/ai-tools/types";

beforeEach(() => { vi.clearAllMocks(); mocks.session.mockResolvedValue({ role: "doctor", username: "synthetic", userId: 7 }); });
describe("Inventory foundation desired invariants", () => {
  it("INV-09: an unknown opening price is not a known zero", () => {
    expect(inventoryValuation([{ kind: "in", qty: 10 }]).unitCostMinor).toBeNull();
  });
  it("INV-11: reaching the reorder boundary is low", () => { expect(stockStatus(5, 5)).toBe("low"); });
  it("INV-08: non-admin detail has no structured purchase price", async () => {
    mocks.detail.mockResolvedValue({ item: { id: 1 }, movements: [{ id: 1, kind: "in", qty: 10, unitCostMinor: 938475, payableId: 17 }], batches: { batches: [], adjustTotal: 0 } });
    const res = await GET(new Request("http://localhost/api/inventory/1"), { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(await res.json());
    expect(serialized).not.toContain("938475");
    expect(serialized).not.toContain("unitCostMinor");
  });
  it("INV-12: existing summary reports unavailable without internal error disclosure", async () => {
    mocks.items.mockRejectedValue(new Error("private database detail"));
    const result = await getInventorySummary({}, { isDbConnected: true } as AiToolContext);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private database detail");
  });
  it("INV-12b: disconnected database never reports zero stock or healthy status in AI summary", async () => {
    const result = await getInventorySummary({}, { isDbConnected: false } as AiToolContext);
    expect(result.success).toBe(false);
    expect(result.warnings).toContain("inventory_unavailable");
    expect(mocks.items).not.toHaveBeenCalled();
  });
  it("INV-12c: database failure during visit lookup returns 500 instead of false 404 visit-not-found", async () => {
    mocks.visitPatientOf.mockRejectedValue(new Error("postgres://admin:secret@db.internal:5432/clinic connection reset"));
    const req = new Request("http://localhost/api/inventory/1/movements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "out", qty: 1, visitId: 42 }),
    });
    const res = await postMovement(req, { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.message).not.toContain("الزيارة غير موجودة");
    expect(JSON.stringify(body)).not.toContain("secret");
  });
  it("INV-08b & INV-12d: sanitizes audit details and error messages against credential, SQL, and unauthorized cost leaks", () => {
    const rawAudit = {
      status: "submitted",
      databaseUrl: "postgresql://user:supersecret@localhost:5432/aqlan",
      unitCostMinor: 45000,
      supplierInvoiceNumber: "INV-99",
      nested: { note: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig", safeCount: 3 },
    };
    const scrubbedNonAdmin = sanitizeInventoryAuditDetails(rawAudit, { includeFinancials: false });
    expect(JSON.stringify(scrubbedNonAdmin)).not.toContain("supersecret");
    expect(JSON.stringify(scrubbedNonAdmin)).not.toContain("45000");
    expect(JSON.stringify(scrubbedNonAdmin)).not.toContain("INV-99");
    expect(JSON.stringify(scrubbedNonAdmin)).not.toContain("eyJhbGci");
    expect(scrubbedNonAdmin).toMatchObject({ status: "submitted", nested: { safeCount: 3 } });

    const scrubbedAdmin = sanitizeInventoryAuditDetails(rawAudit, { includeFinancials: true });
    expect(JSON.stringify(scrubbedAdmin)).not.toContain("supersecret");
    expect(scrubbedAdmin.unitCostMinor).toBe(45000);

    expect(safeInventoryErrorMessage(new Error("SELECT * FROM inventory_items WHERE id = 1"), "خطأ آمن")).toBe("خطأ آمن");
    expect(safeInventoryErrorMessage(new Error("postgres://root:pw@host:5432/db"), "خطأ آمن")).toBe("خطأ آمن");
    expect(safeInventoryErrorMessage(new Error("كمية الصرف أكبر من المتاح"), "خطأ آمن")).toBe("كمية الصرف أكبر من المتاح");
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
