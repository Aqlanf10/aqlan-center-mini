import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const { inventoryDetailWithLinks, readInventoryValuation } = await import("../../lib/inventory-domain/read");
beforeAll(async () => {
  // The global valuation must see only this guarded disposable fixture, not prior overflow evidence.
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
});
afterAll(async () => { await db.resetPoolForTesting(); });
async function item(name: string) {
  return db.createInventoryItem({ name: `synthetic-foundation-${name}-${Date.now()}`, unit: "piece", category: "other", minLevel: 5, note: null, createdBy: "inventory-test" });
}
describe("inventory foundation reads on real PostgreSQL", () => {
  it("reads stored supplier/payable links without creating any new debt", async () => {
    const i = await item("links");
    const { rows: [supplier] } = await db.getPool().query("INSERT INTO parties(name,kind) VALUES ('synthetic inventory supplier','supplier') RETURNING id");
    const purchase = await db.createInventoryMovement({ itemId: i.id, kind: "in", qty: 10, unitCostMinor: 50, supplierPartyId: supplier.id, createdBy: "inventory-test" });
    expect(purchase.ok).toBe(true); if (!purchase.ok) throw new Error(purchase.message);
    const before = await db.getPool().query("SELECT id,amount_minor,currency FROM payables WHERE party_id=$1", [supplier.id]);
    const detail = await inventoryDetailWithLinks(i.id);
    expect(detail?.movements[0]).toMatchObject({ partyId: supplier.id, payableId: purchase.movement.payableId, unitCostMinor: 50 });
    expect((await db.getPool().query("SELECT id,amount_minor,currency FROM payables WHERE party_id=$1", [supplier.id])).rows).toEqual(before.rows);
  });
  it("unknown incoming price makes total incomplete while free stock stays known", async () => {
    const unknown = await item("unknown"); const free = await item("free");
    await db.createInventoryMovement({ itemId: unknown.id, kind: "in", qty: 10, createdBy: "inventory-test" });
    await db.createInventoryMovement({ itemId: free.id, kind: "in", qty: 10, unitCostMinor: 0, createdBy: "inventory-test" });
    const valuation = await readInventoryValuation();
    expect(valuation.items.find(i => i.id === unknown.id)).toMatchObject({ costStatus: "missing", unitCostMinor: null, valueMinor: null });
    expect(valuation.items.find(i => i.id === free.id)).toMatchObject({ costStatus: "known", unitCostMinor: 0, valueMinor: 0 });
    expect(valuation.totalMinor).toBeNull(); expect(valuation.withoutCost).toBeGreaterThan(0);
  });
  it("reaching min level produces the same low state in item and alerts", async () => {
    const i = await item("boundary");
    await db.createInventoryMovement({ itemId: i.id, kind: "in", qty: 5, createdBy: "inventory-test" });
    expect((await db.getInventoryItemDetail(i.id))?.item.status).toBe("low");
    expect((await db.inventoryAlerts("2026-10-12")).lowItems.some(row => row.id === i.id)).toBe(true);
  });
});
