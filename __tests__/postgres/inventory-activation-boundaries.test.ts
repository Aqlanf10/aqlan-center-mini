vi.mock("server-only", () => ({}));
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import type { InventoryActor } from "../../lib/inventory-domain/procurement-store";
import type { CustodyUsageInput } from "../../lib/inventory-domain/custody-store";

assertRealPostgresUrl(); stubPostgresEnv();
const db = await import("../../lib/db");
const procurement = await import("../../lib/inventory-domain/procurement-store");
const custody = await import("../../lib/inventory-domain/custody-store");
const { INVENTORY_PROCUREMENT_SQL } = await import("../../lib/inventory-domain/schema-proposal");
const { INVENTORY_CUSTODY_SQL } = await import("../../lib/inventory-domain/custody-schema-proposal");
const { valuationSnapshot } = await import("../../lib/inventory-domain/procurement");
const key = () => randomUUID();
let admin: InventoryActor, doctor: InventoryActor, doctorParty: number, supplier: number;

beforeAll(async () => {
  vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
  await db.ensureSchema();
  await db.getPool().query(INVENTORY_PROCUREMENT_SQL);
  await db.getPool().query(INVENTORY_CUSTODY_SQL);
  doctorParty = (await db.getPool().query("INSERT INTO parties(name,kind) VALUES('Synthetic activation doctor','doctor') RETURNING id")).rows[0].id;
  supplier = (await db.getPool().query("INSERT INTO parties(name,kind) VALUES('Synthetic activation supplier','supplier') RETURNING id")).rows[0].id;
  for (const role of ["admin", "doctor"]) {
    const username = `SYN-ACTIVATION-${role}-${key()}`;
    const { rows: [user] } = await db.getPool().query("INSERT INTO users(username,display_name,password_hash,role,party_id) VALUES($1,$1,'synthetic-disabled-login',$2,$3) RETURNING id", [username, role, role === "doctor" ? doctorParty : null]);
    const actor = { userId: user.id, username, role };
    if (role === "admin") admin = actor; else doctor = actor;
  }
  await db.getPool().query("INSERT INTO inventory_approval_policies(id,branch_key,version,currency,limit_minor,created_by) SELECT $1,'clinic',COALESCE(MAX(version),0)+1,'YER',150000,$2 FROM inventory_approval_policies WHERE branch_key='clinic'", [key(), admin.userId]);
});
afterAll(async () => { vi.unstubAllEnvs(); await db.resetPoolForTesting(); });

async function fixture(disposition: "accepted" | "quarantined" = "quarantined") {
  const item = await db.createInventoryItem({ name: `SYN-ACTIVATION-${key()}`, unit: "unit", category: "other", minLevel: 0, note: null, createdBy: admin.username });
  const conversion = { itemId: item.id, version: 1, enteredUnit: "unit", baseUnit: "unit", baseUnitsPerEnteredUnit: "1", enteredPrecision: 3, basePrecision: 3 };
  await db.getPool().query("INSERT INTO inventory_item_unit_versions(item_id,version,entered_unit,base_unit,factor,entered_precision,base_precision) VALUES($1,1,'unit','unit',1,3,3)", [item.id]);
  const location = `custody-${key()}`, store = `store-${key()}`, transit = `transit-${key()}`;
  for (const [id, kind, owner] of [[location, "custody", doctorParty], [store, "store", null], [transit, "transit", null]]) {
    await db.getPool().query("INSERT INTO inventory_locations(id,branch_key,label,kind,doctor_party_id) VALUES($1,'clinic',$1,$2,$3)", [id, kind, owner]);
  }
  const request = { id: key(), version: 1, branchId: "clinic", requestedBy: doctor.userId, reason: "Synthetic activation boundary", proposedSupplierPartyId: supplier, value: { currency: "YER" as const, amountMinor: 10000 }, lines: [{ id: key(), itemId: item.id, quantity: "100", conversion }] };
  await procurement.submitPurchaseRequest(doctor, key(), request);
  await procurement.approvePurchaseRequest(admin, key(), { requestId: request.id, version: 1, decisions: [{ lineId: request.lines[0].id, quantity: "100", reason: "Synthetic approval" }], valuation: valuationSnapshot({ purpose: "approval_estimate", currency: "YER", amountMinor: 10000, rateToBase: "1", capturedAt: "2026-10-14T00:00:00Z", sourceRef: "synthetic" }) });
  const order = { id: key(), version: 1, branchId: "clinic", supplierPartyId: supplier, currency: "YER" as const, shippingMinor: 0, discountMinor: 0, lines: [{ id: key(), itemId: item.id, kind: "stock" as const, quantity: "100", conversion, price: { state: "known" as const, currency: "YER" as const, unitPriceMinor: 100, reason: "Synthetic quote" }, trackLot: true, requiresExpiry: true, minimumShelfLifeDays: 30, sources: [{ id: key(), requestId: request.id, requestLineId: request.lines[0].id, baseQuantity: "100" }] }] };
  await procurement.issuePurchaseOrder(admin, key(), order);
  const portion = key();
  await procurement.postInspectedReceipt(admin, key(), { id: key(), version: 1, orderId: order.id, orderVersion: 1, branchId: "clinic", supplierPartyId: supplier, actualArrivalDate: "2026-10-14", lines: [{ orderLineId: order.lines[0].id, arrivedQuantity: "100", portions: [{ id: portion, quantity: "100", disposition, lotCode: "SYN-HELD", expiryDate: "2099-12-31", locationId: location, damaged: false, reason: "Synthetic direct custody receipt" }] }] });
  const lot = (await db.getPool().query("SELECT id FROM stock_lots WHERE receipt_line_id=$1", [portion])).rows[0].id as string;
  return { itemId: item.id, location, store, transit, orderId: order.id, portion, lot };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const resolve = (f: Fixture, action: "release" | "dispose", quantity: string) => procurement.resolveQuarantineReceipt(admin, key(), { id: key(), orderId: f.orderId, receiptLineId: f.portion, action, quantity, reason: "Synthetic inspected disposition", resolutionDate: "2026-10-15" });
const usage = (f: Fixture, kind: CustodyUsageInput["kind"], quantity = "10"): CustodyUsageInput => ({ id: key(), usageKey: key(), locationId: f.location, storeLocationId: kind === "returned_to_store" ? f.store : null, lotId: f.lot, kind, quantity, reason: "Synthetic custody operation" });
async function effects() {
  return (await db.getPool().query("SELECT (SELECT COUNT(*) FROM inventory_movements)::int AS movements, (SELECT COUNT(*) FROM inventory_movement_allocations)::int AS allocations, (SELECT COUNT(*) FROM custody_usage_events)::int AS usage, (SELECT COUNT(*) FROM inventory_operations)::int AS operations, (SELECT COUNT(*) FROM audit_log)::int AS audits, (SELECT COUNT(*) FROM payables)::int AS payables, (SELECT COUNT(*) FROM expenses)::int AS expenses")).rows[0];
}
async function globalQuantity(f: Fixture) {
  return (await db.getPool().query("SELECT SUM(CASE WHEN kind='out' THEN -qty ELSE qty END)::text AS qty FROM inventory_movements WHERE item_id=$1", [f.itemId])).rows[0].qty;
}

describe("activation safety: held stock cannot escape quarantine through custody", () => {
  it.each(["consumed", "returned_to_store", "approved_waste"] as const)("limits %s to the released tranche and conserves the remaining quarantine", async kind => {
    const f = await fixture();
    await resolve(f, "release", "10");
    const document = usage(f, kind);
    if (kind === "approved_waste") {
      const approval = await custody.approveCustodyWaste(admin, key(), { id: key(), locationId: f.location, lotId: f.lot, maxQuantity: "100", reason: "Synthetic independent waste approval" });
      document.wasteApprovalId = approval.id;
    }
    const before = await effects();
    await expect(custody.recordCustodyUsage(doctor, key(), { ...document, quantity: "10.001" })).rejects.toMatchObject({ code: "insufficient_location_stock" });
    expect(await effects()).toEqual(before);
    const operationKey = key();
    const committed = await custody.recordCustodyUsage(doctor, operationKey, document);
    expect(committed.replayed).toBe(false);
    expect(await custody.recordCustodyUsage(doctor, operationKey, document)).toMatchObject({ id: committed.id, movementId: committed.movementId, replayed: true });
    const view = await custody.readDoctorCustody(doctor);
    expect(view.locations.find(row => row.id === f.location)?.lots.find(row => row.lotId === f.lot)).toMatchObject({ quantity: "90", availableQuantity: "0", heldQuantity: "90", availability: "unavailable" });
    await resolve(f, "dispose", "90");
    expect(await globalQuantity(f)).toBe(kind === "returned_to_store" ? "10.000" : "0.000");
    const final = await effects();
    expect(final.payables).toBe(before.payables);
    expect(final.expenses).toBe(before.expenses);
    await expect(custody.readDoctorCustody(admin)).resolves.toBeDefined();
  });
  it("shows the held portion separately before using the released balance", async () => {
    const f = await fixture();
    await resolve(f, "release", "10");
    const view = await custody.readDoctorCustody(doctor);
    expect(view.locations.find(row => row.id === f.location)?.lots.find(row => row.lotId === f.lot)).toMatchObject({ quantity: "100", availableQuantity: "10", heldQuantity: "90", availability: "available" });
  });
  it("serializes released consumption with held disposal without a negative ledger", async () => {
    const f = await fixture();
    await resolve(f, "release", "10");
    await Promise.all([custody.recordCustodyUsage(doctor, key(), usage(f, "consumed")), resolve(f, "dispose", "90")]);
    expect(await globalQuantity(f)).toBe("0.000");
    await expect(custody.readDoctorCustody(admin)).resolves.toBeDefined();
  });
});

describe("activation safety: net equality does not prove source allocation", () => {
  it.each(["missing", "short"] as const)("refuses offsetting %s allocation evidence", async mode => {
    const f = await fixture("accepted");
    for (const kind of ["in", "out"]) {
      const movement = (await db.getPool().query("INSERT INTO inventory_movements(item_id,kind,qty,reason,created_by) VALUES($1,$2,10,'Synthetic incomplete legacy source',$3) RETURNING id", [f.itemId, kind, admin.username])).rows[0].id;
      if (mode === "short") await db.getPool().query("INSERT INTO inventory_movement_allocations(id,movement_id,lot_id,location_id,qty) VALUES($1,$2,$3,$4,8)", [key(), movement, f.lot, f.location]);
    }
    expect(await globalQuantity(f)).toBe("100.000");
    const before = await effects();
    await expect(custody.recordCustodyUsage(doctor, key(), usage(f, "consumed"))).rejects.toMatchObject({ code: "legacy_allocation_incomplete" });
    expect(await effects()).toEqual(before);
    const view = await custody.readDoctorCustody(admin);
    expect(view.reconciliationRequired).toContainEqual(expect.objectContaining({ itemId: f.itemId }));
    expect(view.locations.find(row => row.id === f.location)?.lots.find(row => row.lotId === f.lot)).toMatchObject({ availability: "unavailable", trackingState: "incomplete" });
  });
});
