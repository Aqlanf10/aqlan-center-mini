vi.mock("server-only", () => ({}));
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "../../lib/db";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import type { InventoryActor } from "../../lib/inventory-domain/procurement-store";

assertRealPostgresUrl(); stubPostgresEnv();
const isolatedUrl = await createIsolatedDatabase("aqlan_inventory_legacy_guard");
vi.stubEnv("DATABASE_URL", isolatedUrl);
vi.stubEnv("TEST_DATABASE_URL", isolatedUrl);
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
afterAll(async () => { await db.resetPoolForTesting(); vi.unstubAllEnvs(); });

async function fixture(disposition: "accepted" | "quarantined" = "quarantined", expiryDate = "2099-12-31") {
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
  await procurement.postInspectedReceipt(admin, key(), { id: key(), version: 1, orderId: order.id, orderVersion: 1, branchId: "clinic", supplierPartyId: supplier, actualArrivalDate: "2026-10-14", lines: [{ orderLineId: order.lines[0].id, arrivedQuantity: "100", portions: [{ id: portion, quantity: "100", disposition, lotCode: "SYN-HELD", expiryDate, locationId: location, damaged: false, reason: "Synthetic direct custody receipt" }] }] });
  const lot = (await db.getPool().query("SELECT id FROM stock_lots WHERE receipt_line_id=$1", [portion])).rows[0].id as string;
  return { itemId: item.id, location, store, transit, orderId: order.id, portion, lot };
}
async function effects() {
  return (await db.getPool().query("SELECT (SELECT COUNT(*) FROM inventory_movements)::int AS movements, (SELECT COUNT(*) FROM inventory_movement_allocations)::int AS allocations, (SELECT COUNT(*) FROM custody_usage_events)::int AS usage, (SELECT COUNT(*) FROM inventory_operations)::int AS operations, (SELECT COUNT(*) FROM audit_log)::int AS audits, (SELECT COUNT(*) FROM payables)::int AS payables, (SELECT COUNT(*) FROM expenses)::int AS expenses, (SELECT COUNT(*) FROM invoices)::int AS invoices, (SELECT COUNT(*) FROM invoice_items)::int AS invoice_items, (SELECT COUNT(*) FROM lab_orders)::int AS lab_orders, (SELECT COUNT(*) FROM visits WHERE signed_at IS NOT NULL)::int AS signed_visits")).rows[0];
}

async function clinicalFixture(itemIds: number[]) {
  const patientId = (await db.getPool().query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic guarded visit') RETURNING id", [key()])).rows[0].id;
  const serviceId = (await db.getPool().query("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('Synthetic guarded filling','filling',10000,TRUE,TRUE) RETURNING id")).rows[0].id;
  for (const itemId of itemIds) await db.getPool().query("INSERT INTO service_materials(service_id,item_id,qty_per_unit,created_by) VALUES($1,$2,1,$3)", [serviceId, itemId, admin.username]);
  const visit = await db.addVisit({ patientName: "Synthetic guarded visit", patientPhone: null, note: null, patientId });
  await db.getPool().query("UPDATE visits SET doctor_id=$2,diagnosis='Synthetic filling' WHERE id=$1", [visit.id, doctorParty]);
  await db.setVisitProcedures({ visitId: visit.id, procedures: [{ serviceId, toothCode: 11, doctorId: doctorParty, quantity: 1, unitPriceMinor: 10000, surfaces: null, priceReason: null, note: null, planItemId: null }] });
  return visit.id;
}
const sign = (visitId: number) => db.signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: doctor.username, signerDoctorPartyId: doctorParty, signerRole: "doctor" });

describe("legacy writers cannot bypass tracked inventory when integration is enabled", () => {
  it.each([
    { kind: "out" as const, qty: 1 },
    { kind: "in" as const, qty: 1, unitCostMinor: 100 },
    { kind: "in" as const, qty: 1, isReturn: true },
    { kind: "adjust" as const, qty: 1 },
    { kind: "adjust" as const, qty: -1 },
  ])("refuses tracked legacy mutation $kind/$qty/$isReturn before effects", async mutation => {
    const f = await fixture();
    const before = await effects();
    const result = await db.createInventoryMovement({ itemId: f.itemId, ...mutation, reason: "Synthetic legacy bypass", createdBy: admin.username });
    expect(result).toMatchObject({ ok: false });
    expect(await effects()).toEqual(before);
  });
  it("refuses tracked supplier purchase without creating a second supplier payable", async () => {
    const f = await fixture();
    const before = await effects();
    expect(await db.createInventoryMovement({ itemId: f.itemId, kind: "in", qty: 1, unitCostMinor: 100, supplierPartyId: supplier, reason: "Synthetic tracked purchase", createdBy: admin.username })).toMatchObject({ ok: false });
    expect(await effects()).toEqual(before);
  });
  it("refuses signing a mixed untracked/tracked material visit and rolls back all effects", async () => {
    const free = await db.createInventoryItem({ name: `SYN-UNTRACKED-${key()}`, unit: "unit", category: "other", minLevel: 0, note: null, createdBy: admin.username });
    expect(await db.createInventoryMovement({ itemId: free.id, kind: "in", qty: 10, createdBy: admin.username })).toMatchObject({ ok: true });
    const f = await fixture();
    const visitId = await clinicalFixture([free.id, f.itemId]);
    const before = await effects();
    await expect(sign(visitId)).rejects.toMatchObject({ code: "inventory_tracking_required" });
    expect(await effects()).toEqual(before);
    expect((await db.getClinicalVisit(visitId))?.status).not.toBe("signed");
  });
  it("retains legacy issue and signing while the private gate is off", async () => {
    const f = await fixture();
    const visitId = await clinicalFixture([f.itemId]);
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "false");
    try {
      expect(await db.createInventoryMovement({ itemId: f.itemId, kind: "out", qty: 1, createdBy: admin.username })).toMatchObject({ ok: true });
      expect(await sign(visitId)).toMatchObject({ reason: null, materialsDeducted: 1 });
    } finally { vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true"); }
  });
  it("does not block untracked legacy items when the private gate is on", async () => {
    const item = await db.createInventoryItem({ name: `SYN-UNTRACKED-${key()}`, unit: "unit", category: "other", minLevel: 0, note: null, createdBy: admin.username });
    expect(await db.createInventoryMovement({ itemId: item.id, kind: "in", qty: 10, createdBy: admin.username })).toMatchObject({ ok: true });
    const visitId = await clinicalFixture([item.id]);
    expect(await sign(visitId)).toMatchObject({ reason: null, materialsDeducted: 1 });
    expect(await db.createInventoryMovement({ itemId: item.id, kind: "out", qty: 1, createdBy: admin.username })).toMatchObject({ ok: true });
  });
  it("fails signing busy instead of deadlocking against attributed custody consumption", async () => {
    const f = await fixture("accepted"), visitId = await clinicalFixture([f.itemId]);
    const observer = new Client({ connectionString: isolatedUrl, ssl: false });
    await observer.connect();
    let custodyPid = 0, signPid = 0, custodyPaused!: () => void, signPaused!: () => void;
    let releaseCustody!: () => void, releaseSign!: () => void;
    const custodyPause = new Promise<void>(done => { custodyPaused = done; });
    const signPause = new Promise<void>(done => { signPaused = done; });
    const custodyGate = new Promise<void>(done => { releaseCustody = done; });
    const signGate = new Promise<void>(done => { releaseSign = done; });
    const pool = db.getPool(), originalConnect = pool.connect.bind(pool);
    const spy = vi.spyOn(pool, "connect").mockImplementation((...args: unknown[]) => {
      if (args.length) return Reflect.apply(originalConnect, pool, args);
      return (async () => {
        const client = await originalConnect(), query = client.query.bind(client);
        const pid = (await query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        return {
          async query<T>(sql: string, values?: unknown[]): Promise<QueryResult<T>> {
            const custodyLock = sql === "SELECT id,is_active FROM inventory_items WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE";
            const signingLock = !custodyLock && /FROM inventory_items.*FOR UPDATE/s.test(sql);
            if (signingLock) { signPid = pid; signPaused(); await signGate; }
            const result = await query<T>(sql, values);
            if (custodyLock) { custodyPid = pid; custodyPaused(); await custodyGate; }
            return result;
          },
          release: () => client.release(),
        };
      })();
    });
    const consumed = custody.recordCustodyUsage(doctor, key(), { id: key(), usageKey: key(), locationId: f.location, lotId: f.lot, kind: "consumed", quantity: "1", visitId: String(visitId), reason: "Synthetic attributed race" });
    const consumeResult = consumed.then(value => ({ value }), error => ({ error }));
    let signed: ReturnType<typeof sign> | undefined, signResult: Promise<unknown> | undefined;
    try {
      await Promise.race([custodyPause, consumed.then(() => { throw new Error("Custody finished before barrier"); })]);
      signed = sign(visitId); signResult = signed.then(value => ({ value }), error => ({ error }));
      await Promise.race([signPause, signed.then(() => { throw new Error("Sign finished before barrier"); })]);
      releaseCustody();
      await expect.poll(async () => (await observer.query<{ blocked: boolean }>("SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked", [custodyPid, signPid])).rows[0].blocked, { timeout: 5000, interval: 20 }).toBe(true);
      releaseSign();
      const [signCode, consumeCode] = await Promise.all([signed.then(() => null, error => error.code), consumed.then(() => null, error => error.code)]);
      expect({ signCode, consumeCode }).toEqual({ signCode: "inventory_busy", consumeCode: null });
      await expect(consumed).resolves.toMatchObject({ baseQuantity: "1", clinicalAttributionStatus: "verified" });
      expect((await db.getClinicalVisit(visitId))?.status).not.toBe("signed");
      expect((await db.getPool().query("SELECT COUNT(*)::int AS n FROM invoices WHERE visit_id=$1", [visitId])).rows[0].n).toBe(0);
    } finally {
      releaseCustody(); releaseSign(); await consumeResult; await signResult;
      spy.mockRestore(); await observer.end();
    }
  });
});
