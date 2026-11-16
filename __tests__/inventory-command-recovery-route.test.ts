vi.mock("../lib/inventory-domain/supplier-transport", () => ({ admitSupplierIntent: vi.fn(), executeSupplierIntent: vi.fn(), readSupplierFinance: vi.fn() }));
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInventoryRecoveryCommand, INVENTORY_RECOVERY_PROTOCOL } from "../lib/inventory-command-recovery";
import { InventoryDomainError } from "../lib/inventory-domain/quantities";
const mock = vi.hoisted(() => ({ session: vi.fn(), enabled: vi.fn(), write: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: mock.session }));
vi.mock("../lib/inventory-domain/rollout", () => ({ inventoryIntegrationEnabled: mock.enabled, INVENTORY_DISABLED_MESSAGE: "disabled" }));
vi.mock("../lib/inventory-domain/procurement-store", () => ({ submitPurchaseRequest: mock.write, revisePurchaseRequest: mock.write, approvePurchaseRequest: mock.write, issuePurchaseOrder: mock.write, amendPurchaseOrder: mock.write, postInspectedReceipt: mock.write, resolveQuarantineReceipt: mock.write, recordSupplierInvoiceMatch: mock.write, readProcurementRequests: vi.fn(), readProcurementCatalog: vi.fn(), readProcurementWorkbench: vi.fn() }));
vi.mock("../lib/inventory-domain/custody-store", () => ({ dispatchCustodyTransfer: mock.write, acknowledgeCustodyTransfer: mock.write, reconcileHistoricalMovements: mock.write, recordCustodyUsage: mock.write, recordCustodyStocktake: mock.write, closeCustodyPackage: mock.write, proposeAnnualCustodySettlement: mock.write, objectCustodySettlement: mock.write, approveCustodyWaste: mock.write, readDoctorCustody: vi.fn() }));
import { POST } from "../app/api/inventory/procurement/route";
const scope = { actor: "synthetic-owner", actorUserId: 7, workspace: "custody" as const };
async function request(patch: Record<string, string> = {}) {
  const command = await createInventoryRecoveryCommand(scope, "custody.consume", { usage: { id: "synthetic", quantity: "1" } });
  return { command, request: new Request("http://localhost/api/inventory/procurement", { method: "POST", headers: { "Content-Type": "application/json", "X-Inventory-Recovery": INVENTORY_RECOVERY_PROTOCOL, "X-Inventory-Actor": encodeURIComponent(command.actor), "X-Inventory-Actor-Id": String(command.actorUserId), "X-Inventory-Digest": command.digest, ...patch }, body: command.body }) };
}
beforeEach(() => { vi.clearAllMocks(); mock.session.mockResolvedValue({ userId: 7, username: "synthetic-owner", role: "doctor" }); mock.enabled.mockReturnValue(true); mock.write.mockResolvedValue({ id: "synthetic", replayed: false }); });
afterEach(() => vi.restoreAllMocks());
it("binds successful acknowledgements to authenticated actor and exact request without changing stock result", async () => {
  const { command, request: input } = await request();
  const response = await POST(input);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ id: "synthetic", replayed: false, recovery: { protocol: INVENTORY_RECOVERY_PROTOCOL, status: "committed", actorUserId: 7, key: command.key, digest: command.digest } });
  expect(mock.write).toHaveBeenCalledWith({ userId: 7, username: "synthetic-owner", role: "doctor" }, command.key, { id: "synthetic", quantity: "1", kind: "consumed" });
});
it.each([{ "X-Inventory-Actor": "different" }, { "X-Inventory-Actor": "%malformed" }, { "X-Inventory-Actor-Id": "8" }, { "X-Inventory-Recovery": "legacy" }] as Record<string,string>[])("refuses changed principal or protocol before command execution %j", async patch => {
  expect((await POST((await request(patch)).request)).status).toBe(403); expect(mock.write).not.toHaveBeenCalled();
});
it("refuses tampered quantity/currency/payload instead of acknowledging a different command", async () => {
  const { request: input } = await request({ "X-Inventory-Digest": "0".repeat(64) });
  expect((await POST(input)).status).toBe(409); expect(mock.write).not.toHaveBeenCalled();
});
it("gate and authentication remain ahead of recovery parsing and store access", async () => {
  mock.enabled.mockReturnValue(false);
  expect((await POST((await request()).request)).status).toBe(503); expect(mock.write).not.toHaveBeenCalled();
  mock.session.mockResolvedValue(null);
  expect((await POST((await request()).request)).status).toBe(401); expect(mock.write).not.toHaveBeenCalled();
});
it("never issues committed proof for rollback, denied replay or uncertain commit", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const error of [new InventoryDomainError("stale_version", "stale"), new InventoryDomainError("actor_forbidden", "denied"), new Error("lost commit response")]) {
    mock.write.mockRejectedValueOnce(error);
    const response = await POST((await request()).request);
    expect(response.ok).toBe(false); expect(await response.json()).not.toHaveProperty("recovery");
  }
});
it("keeps existing unversioned clients compatible", async () => {
  const response = await POST(new Request("http://localhost/api/inventory/procurement", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "custody.consume", operationKey: "synthetic-key", usage: { id: "synthetic" } }) }));
  expect(await response.json()).toEqual({ id: "synthetic", replayed: false });
});
