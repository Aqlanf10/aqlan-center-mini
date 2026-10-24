vi.mock("server-only", () => ({}));
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import type { QueryResult } from "../../lib/db";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import type { InventoryActor } from "../../lib/inventory-domain/procurement-store";
import type { CustodyUsageInput } from "../../lib/inventory-domain/custody-store";

assertRealPostgresUrl(); stubPostgresEnv();
const isolatedUrl = await createIsolatedDatabase("aqlan_inventory_activation");
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
  it("keeps expired released stock visible for approved waste but unavailable for clinical use or return", async () => {
    // Fake only Date: PostgreSQL sockets and timers remain real.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));
      const f = await fixture("accepted", "2027-12-31");
      vi.setSystemTime(new Date("2028-01-01T12:00:00Z"));
      const view = await custody.readDoctorCustody(doctor);
      expect(view.locations.find(row => row.id === f.location)?.lots.find(row => row.lotId === f.lot)).toMatchObject({ quantity: "100", availableQuantity: "0", wasteQuantity: "100", heldQuantity: "0", availability: "unavailable" });
      const approval = await custody.approveCustodyWaste(admin, key(), { id: key(), locationId: f.location, lotId: f.lot, maxQuantity: "100", reason: "Synthetic expired released stock approval" });
      const before = await effects();
      for (const kind of ["consumed", "returned_to_store"] as const) {
        await expect(custody.recordCustodyUsage(doctor, key(), usage(f, kind, "1"))).rejects.toMatchObject({ code: "lot_unavailable" });
      }
      expect(await effects()).toEqual(before);
      await expect(custody.recordCustodyUsage(doctor, key(), { ...usage(f, "approved_waste", "100"), wasteApprovalId: approval.id })).resolves.toMatchObject({ baseQuantity: "100" });
      expect(await globalQuantity(f)).toBe("0.000");
    } finally { vi.useRealTimers(); }
  });
  it("serializes released consumption with held disposal without a negative ledger", async () => {
    const f = await fixture();
    await resolve(f, "release", "10");
    await Promise.all([custody.recordCustodyUsage(doctor, key(), usage(f, "consumed")), resolve(f, "dispose", "90")]);
    expect(await globalQuantity(f)).toBe("0.000");
    await expect(custody.readDoctorCustody(admin)).resolves.toBeDefined();
  });
  it("does not let an independent waste approval spend a fully held lot", async () => {
    const f = await fixture();
    const approval = await custody.approveCustodyWaste(admin, key(), { id: key(), locationId: f.location, lotId: f.lot, maxQuantity: "100", reason: "Synthetic approval does not release quarantine" });
    const before = await effects();
    await expect(custody.recordCustodyUsage(doctor, key(), { ...usage(f, "approved_waste", "1"), wasteApprovalId: approval.id })).rejects.toMatchObject({ code: "insufficient_location_stock" });
    expect(await effects()).toEqual(before);
    await resolve(f, "dispose", "100");
    expect(await globalQuantity(f)).toBe("0.000");
  });
  it.each(["consumed", "approved_waste"] as const)("disposal waits behind paused %s without taking a conflicting lot or actor lock", async kind => {
    const f = await fixture();
    await resolve(f, "release", "10");
    const document = usage(f, kind);
    if (kind === "approved_waste") {
      const approval = await custody.approveCustodyWaste(admin, key(), { id: key(), locationId: f.location, lotId: f.lot, maxQuantity: "10", reason: "Synthetic independently approved race" });
      document.wasteApprovalId = approval.id;
    }
    const observer = new Client({ connectionString: isolatedUrl, ssl: false });
    await observer.connect();
    let release!: () => void, paused!: () => void, writerPid = 0;
    const pause = new Promise<void>(done => { paused = done; });
    const gate = new Promise<void>(done => { release = done; });
    const pool = db.getPool(), originalConnect = pool.connect.bind(pool);
    let hooked = false;
    const spy = vi.spyOn(pool, "connect").mockImplementation((...args: unknown[]) => {
      // pg.Pool.query uses callback-form connect for readiness reads. Preserve
      // those calls; pause only the explicit transaction-owned connection.
      if (args.length || hooked) return Reflect.apply(originalConnect, pool, args);
      hooked = true;
      return (async () => {
      const client = await originalConnect(), query = client.query.bind(client);
      writerPid = (await query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      return {
        async query<T>(sql: string, values?: unknown[]): Promise<QueryResult<T>> {
          const result = await query<T>(sql, values);
          if (sql === "SELECT id,is_active FROM inventory_items WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE") { paused(); await gate; }
          return result;
        },
        release: () => client.release(),
      };
      })();
    });
    const consume = custody.recordCustodyUsage(doctor, key(), document);
    let dispose: ReturnType<typeof resolve> | undefined;
    // Observe both outcomes immediately, even if a regression makes one reject.
    const consumeResult = consume.then(value => ({ value }), error => ({ error }));
    let disposeResult: Promise<unknown> | undefined;
    try {
      await Promise.race([pause, consume.then(() => { throw new Error("Writer finished before item-lock barrier"); })]);
      dispose = resolve(f, "dispose", "90");
      disposeResult = dispose.then(value => ({ value }), error => ({ error }));
      await expect.poll(async () => (await observer.query<{ blocked: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE '%inventory_items%FOR UPDATE%') AS blocked", [writerPid])).rows[0].blocked, { timeout: 5000, interval: 20 }).toBe(true);
      release();
      await expect(consume).resolves.toMatchObject({ baseQuantity: "10" });
      await expect(dispose).resolves.toMatchObject({ baseQuantity: "90" });
      expect(await globalQuantity(f)).toBe("0.000");
    } finally {
      release();
      await consumeResult; await disposeResult;
      spy.mockRestore(); await observer.end();
    }
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
  it("refuses balanced allocations pointing to another inventory item's lot", async () => {
    const left = await fixture("accepted"), right = await fixture("accepted");
    for (const [source, target] of [[left, right], [right, left]]) {
      const movement = (await db.getPool().query("INSERT INTO inventory_movements(item_id,kind,qty,reason,created_by) VALUES($1,'in',10,'Synthetic wrong-item allocation',$2) RETURNING id", [source.itemId, admin.username])).rows[0].id;
      await db.getPool().query("INSERT INTO inventory_movement_allocations(id,movement_id,lot_id,location_id,qty) VALUES($1,$2,$3,$4,10)", [key(), movement, target.lot, target.location]);
    }
    const before = await effects();
    await expect(custody.recordCustodyUsage(doctor, key(), usage(left, "consumed"))).rejects.toMatchObject({ code: "legacy_allocation_incomplete" });
    expect(await effects()).toEqual(before);
    const view = await custody.readDoctorCustody(admin);
    for (const f of [left, right]) expect(view.reconciliationRequired).toContainEqual(expect.objectContaining({ itemId: f.itemId }));
  });
  it("blocks the destination of a one-way foreign-item allocation", async () => {
    const destination = await fixture("accepted"), foreign = await fixture("accepted");
    const movement = (await db.getPool().query("INSERT INTO inventory_movements(item_id,kind,qty,reason,created_by) VALUES($1,'in',10,'Synthetic one-way wrong-item allocation',$2) RETURNING id", [foreign.itemId, admin.username])).rows[0].id;
    await db.getPool().query("INSERT INTO inventory_movement_allocations(id,movement_id,lot_id,location_id,qty) VALUES($1,$2,$3,$4,10)", [key(), movement, destination.lot, destination.location]);
    const before = await effects();
    await expect(custody.recordCustodyUsage(doctor, key(), usage(destination, "consumed"))).rejects.toMatchObject({ code: "legacy_allocation_incomplete" });
    expect(await effects()).toEqual(before);
    const view = await custody.readDoctorCustody(admin);
    expect(view.reconciliationRequired).toContainEqual(expect.objectContaining({ itemId: destination.itemId }));
    expect(view.locations.find(row => row.id === destination.location)?.lots.find(row => row.lotId === destination.lot)).toMatchObject({ quantity: "110", availableQuantity: "0", trackingState: "incomplete" });
  });
  it("refuses to advertise or dispatch previously escaped held stock from another location", async () => {
    const f = await fixture();
    await resolve(f, "release", "10");
    // Synthetic malformed history shaped like the pre-fix over-return. Do not
    // alter immutable evidence or automatically repair its resulting balance.
    await db.getPool().query("INSERT INTO custody_usage_events(id,usage_key,location_id,store_location_id,lot_id,kind,qty,quantity_state,reason,cost_snapshot,document,created_by) VALUES($1,$2,$3,$4,$5,'returned_to_store',100,'confirmed','Synthetic pre-fix escaped reserve','{}','{}',$6)", [key(), key(), f.location, f.store, f.lot, doctor.userId]);
    const before = await effects();
    await expect(custody.readDoctorCustody(admin)).rejects.toMatchObject({ code: "allocation_reconciliation_required" });
    await expect(custody.dispatchCustodyTransfer(admin, key(), { id: key(), fromLocationId: f.store, toLocationId: f.location, transitLocationId: f.transit, reason: "Synthetic escaped-stock refusal", lines: [{ id: key(), lotId: f.lot, quantity: "10" }] })).rejects.toMatchObject({ code: "allocation_reconciliation_required" });
    expect(await effects()).toEqual(before);
    expect(await globalQuantity(f)).toBe("100.000");
  });
});
