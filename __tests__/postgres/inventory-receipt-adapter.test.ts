vi.mock("server-only", () => ({}));
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import type { DbClient } from "../../lib/db";
import { withTransaction } from "../../lib/transactions";
import type { InventoryActor } from "../../lib/inventory-domain/procurement-store";
import type { PurchaseOrder, ReceiptRevision, RequestRevision } from "../../lib/inventory-domain/procurement";

assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const store = await import("../../lib/inventory-domain/procurement-store");
const { INVENTORY_PROCUREMENT_SQL } = await import("../../lib/inventory-domain/schema-proposal");
const { valuationSnapshot } = await import("../../lib/inventory-domain/procurement");
const key = () => randomUUID();
let admin: InventoryActor;
let requester: InventoryActor;
let itemId: number;
let supplierId: number;
let locationId: string;

beforeAll(async () => {
  vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
  // Isolate global valuation from previous suites; target guard remains mandatory.
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  // Explicit opt-in fixture only. Never register/apply the proposal at runtime.
  await db.getPool().query(INVENTORY_PROCUREMENT_SQL);
  await db.getPool().query("CREATE TABLE IF NOT EXISTS synthetic_receipt_adapter_sentinels(id UUID PRIMARY KEY)");
  for (const role of ["admin", "doctor"]) {
    const username = `SYN-RECEIPT-${key()}`;
    const result = await db.getPool().query<{ id: number }>(
      "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$1,'synthetic-disabled-login',$2) RETURNING id", [username, role],
    );
    const actor = { userId: result.rows[0].id, username, role };
    if (role === "admin") admin = actor; else requester = actor;
  }
  itemId = (await db.createInventoryItem({ name: `SYN-RECEIPT-${key()}`, category: "anesthesia", unit: "piece", minLevel: 0, note: null, createdBy: admin.username })).id;
  supplierId = (await db.getPool().query<{ id: number }>("INSERT INTO parties(name,kind) VALUES('SYN-RECEIPT-SUPPLIER','supplier') RETURNING id")).rows[0].id;
  await db.getPool().query("INSERT INTO inventory_item_unit_versions(item_id,version,entered_unit,base_unit,factor,entered_precision,base_precision) VALUES($1,1,'box','piece',50,0,0)", [itemId]);
  locationId = `store-${key()}`;
  await db.getPool().query("INSERT INTO inventory_locations(id,branch_key,label,kind) VALUES($1,'clinic','Synthetic receipt store','store')", [locationId]);
  await db.getPool().query("INSERT INTO inventory_approval_policies(id,branch_key,version,currency,limit_minor,allow_self_approval,created_by) SELECT $1,'clinic',COALESCE(MAX(version),0)+1,'YER',900000,FALSE,$2 FROM inventory_approval_policies WHERE branch_key='clinic'", [key(), admin.userId]);
});
afterAll(async () => { vi.unstubAllEnvs(); await db.resetPoolForTesting(); });

async function issued(currency: "YER" | "SAR" | "USD" = "SAR", unitPriceMinor = 1): Promise<PurchaseOrder> {
  const conversion = { itemId, version: 1, enteredUnit: "box", baseUnit: "piece", baseUnitsPerEnteredUnit: "50", enteredPrecision: 0, basePrecision: 0 };
  const request: RequestRevision = { id: key(), version: 1, branchId: "clinic", requestedBy: requester.userId, reason: "Synthetic receipt adapter demand", proposedSupplierPartyId: supplierId, value: { currency, amountMinor: 300 }, lines: [{ id: key(), itemId, quantity: "3", conversion }] };
  await store.submitPurchaseRequest(requester, key(), request);
  await store.approvePurchaseRequest(admin, key(), { requestId: request.id, version: 1, decisions: [{ lineId: request.lines[0].id, quantity: "3", reason: "Synthetic explicit approval" }], valuation: valuationSnapshot({ purpose: "approval_estimate", currency, amountMinor: 300, rateToBase: currency === "YER" ? "1" : "500", capturedAt: "2026-10-25T00:00:00Z", sourceRef: "synthetic approval quote" }) });
  const order: PurchaseOrder = { id: key(), version: 1, branchId: "clinic", supplierPartyId: supplierId, currency, shippingMinor: 0, discountMinor: 0, lines: [{ id: key(), itemId, kind: "stock", quantity: "3", conversion, price: { state: "known", currency, unitPriceMinor, reason: "Synthetic quote, not final valuation" }, trackLot: true, requiresExpiry: true, minimumShelfLifeDays: 30, sources: [{ id: key(), requestId: request.id, requestLineId: request.lines[0].id, baseQuantity: "150" }] }] };
  await store.issuePurchaseOrder(admin, key(), order);
  return order;
}
function receipt(order: PurchaseOrder, destination = locationId, quantity = "1"): ReceiptRevision {
  return { id: key(), version: 1, orderId: order.id, orderVersion: 1, supplierPartyId: supplierId, branchId: "clinic", actualArrivalDate: "2026-10-24", lines: [{ orderLineId: order.lines[0].id, arrivedQuantity: quantity, portions: [{ id: key(), quantity, disposition: "accepted", lotCode: "SYN-LOT", expiryDate: "2030-01-01", locationId: destination, damaged: false, reason: "Synthetic inspected receipt" }] }] };
}
async function effects() {
  return (await db.getPool().query(`SELECT
    (SELECT COUNT(*) FROM goods_receipts)::int AS receipts,
    (SELECT COUNT(*) FROM goods_receipt_lines)::int AS lines,
    (SELECT COUNT(*) FROM stock_lots)::int AS lots,
    (SELECT COUNT(*) FROM inventory_movements)::int AS movements,
    (SELECT COUNT(*) FROM inventory_movement_allocations)::int AS allocations,
    (SELECT COUNT(*) FROM inventory_operations)::int AS operations,
    (SELECT COUNT(*) FROM audit_log)::int AS audits,
    (SELECT COUNT(*) FROM payables)::int AS payables,
    (SELECT COUNT(*) FROM expenses)::int AS expenses`)).rows[0];
}

const core = (actor: InventoryActor, operationKey: string, input: ReceiptRevision) =>
  withTransaction(db.getPool(), client => store.postInspectedReceiptInTransaction(client, actor, operationKey, input));
function observedClient(client: DbClient, statements: string[], after?: (sql: string) => Promise<void> | void): DbClient {
  return {
    async query<T>(sql: string, values?: Parameters<DbClient["query"]>[1]) {
      statements.push(sql);
      const result = await client.query<T>(sql, values);
      await after?.(sql);
      return result;
    },
    release: () => { throw new Error("Adapter must not release caller connection"); },
  };
}
async function activeCustody() {
  const partyId = (await db.getPool().query<{ id: number }>("INSERT INTO parties(name,kind) VALUES('SYN-ACTIVE-OWNER','doctor') RETURNING id")).rows[0].id;
  const destination = `custody-${key()}`;
  await db.getPool().query("INSERT INTO inventory_locations(id,branch_key,label,kind,doctor_party_id) VALUES($1,'clinic','Synthetic explicit custody','custody',$2)", [destination, partyId]);
  return { partyId, destination };
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

describe("caller-owned inspected receipt adapter", () => {
  it("fails closed before writes when the caller forgot BEGIN", async () => {
    const order = await issued(); const before = await effects();
    const client = await db.getPool().connect();
    try {
      await expect(store.postInspectedReceiptInTransaction(client, admin, key(), receipt(order))).rejects.toMatchObject({ code: "transaction_required" });
    } finally { client.release(); }
    expect(await effects()).toEqual(before);
  });
  it("rejects transit as a final receipt destination without any effects", async () => {
    const destination = `transit-${key()}`;
    await db.getPool().query("INSERT INTO inventory_locations(id,branch_key,label,kind) VALUES($1,'clinic','Synthetic transit','transit')", [destination]);
    const order = await issued(); const before = await effects();
    await expect(store.postInspectedReceipt(admin, key(), receipt(order, destination))).rejects.toMatchObject({ code: "location_forbidden" });
    expect(await effects()).toEqual(before);
  });
  it.each(["missing", "supplier", "inactive"])("rejects custody with %s doctor ownership", async owner => {
    let partyId: number | null = null;
    if (owner !== "missing") {
      partyId = (await db.getPool().query<{ id: number }>("INSERT INTO parties(name,kind,is_active) VALUES('SYN-CUSTODY-OWNER',$1,$2) RETURNING id", [owner === "supplier" ? "supplier" : "doctor", owner !== "inactive"])).rows[0].id;
    }
    const destination = `custody-${key()}`;
    await db.getPool().query("INSERT INTO inventory_locations(id,branch_key,label,kind,doctor_party_id) VALUES($1,'clinic','Synthetic custody','custody',$2)", [destination, partyId]);
    const order = await issued(); const before = await effects();
    await expect(store.postInspectedReceipt(admin, key(), receipt(order, destination))).rejects.toMatchObject({ code: "doctor_unavailable" });
    expect(await effects()).toEqual(before);
  });
  it("keeps a caller's existing same-name savepoint and all transaction ownership intact", async () => {
    const order = await issued(); const input = receipt(order); const before = await effects();
    const sentinel = key(); const statements: string[] = [];
    const pool = db.getPool(); const connect = vi.spyOn(pool, "connect");
    try {
      await withTransaction(pool, async client => {
        await client.query("SAVEPOINT inventory_adapter_transaction_check");
        await client.query("INSERT INTO synthetic_receipt_adapter_sentinels(id) VALUES($1)", [sentinel]);
        const result = await store.postInspectedReceiptInTransaction(observedClient(client, statements), admin, key(), input);
        expect(result).toMatchObject({ id: input.id, status: "posted", replayed: false, financialEffects: { payables: 0, expenses: 0 } });
        expect((await client.query("SELECT id FROM goods_receipts WHERE id=$1", [input.id])).rows).toHaveLength(1);
        await client.query("ROLLBACK TO SAVEPOINT inventory_adapter_transaction_check");
        expect((await client.query("SELECT id FROM synthetic_receipt_adapter_sentinels WHERE id=$1", [sentinel])).rows).toHaveLength(0);
      });
      expect(connect).toHaveBeenCalledTimes(1);
    } finally { connect.mockRestore(); }
    expect(statements.filter(sql => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql))).toEqual([]);
    expect(await effects()).toEqual(before);
  });

  it.each(["goods_receipts", "goods_receipt_lines", "inventory_movements", "stock_lots", "inventory_movement_allocations", "audit_log", "inventory_operations"])("rolls back caller sentinel and every receipt effect after %s insert failure", async table => {
    const order = await issued(); const input = receipt(order); const before = await effects(); const sentinel = key();
    let injected = false;
    await expect(withTransaction(db.getPool(), async client => {
      await client.query("INSERT INTO synthetic_receipt_adapter_sentinels(id) VALUES($1)", [sentinel]);
      const checked = observedClient(client, [], sql => {
        if (new RegExp(`^INSERT INTO ${table}\\b`, "i").test(sql.trim())) { injected = true; throw new Error(`synthetic after ${table}`); }
      });
      return store.postInspectedReceiptInTransaction(checked, admin, key(), input);
    })).rejects.toThrow(`synthetic after ${table}`);
    expect(injected).toBe(true);
    expect(await effects()).toEqual(before);
    expect((await db.getPool().query("SELECT id FROM synthetic_receipt_adapter_sentinels WHERE id=$1", [sentinel])).rows).toHaveLength(0);
  });

  it("rolls back the caller sentinel when proposal schema is unavailable", async () => {
    const order = await issued(); const before = await effects(); const sentinel = key();
    await expect(withTransaction(db.getPool(), async client => {
      await client.query("INSERT INTO synthetic_receipt_adapter_sentinels(id) VALUES($1)", [sentinel]);
      await client.query("SET LOCAL search_path=pg_catalog");
      return store.postInspectedReceiptInTransaction(client, admin, key(), receipt(order));
    })).rejects.toMatchObject({ code: "42P01" });
    expect(await effects()).toEqual(before);
    expect((await db.getPool().query("SELECT id FROM synthetic_receipt_adapter_sentinels WHERE id=$1", [sentinel])).rows).toHaveLength(0);
  });

  it("shares the exact durable outcome across wrapper/core and refuses a changed command", async () => {
    const order = await issued(); const input = receipt(order); const operationKey = key();
    const written = await core(admin, operationKey, input); const after = await effects();
    expect(await store.postInspectedReceipt(admin, operationKey, input)).toEqual({ ...written, replayed: true });
    expect(await core(admin, operationKey, input)).toEqual({ ...written, replayed: true });
    await expect(core(admin, operationKey, { ...input, actualArrivalDate: "2026-10-23" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(core(admin, key(), input)).rejects.toMatchObject({ code: "23505" });
    expect(await effects()).toEqual(after);
  });

  it("revalidates current admin authority before replay without substituting an actor", async () => {
    const order = await issued(); const input = receipt(order); const operationKey = key();
    await core(admin, operationKey, input); const before = await effects();
    await expect(core(requester, operationKey, input)).rejects.toMatchObject({ code: "operation_forbidden" });
    await expect(core({ ...admin, username: "forged" }, operationKey, input)).rejects.toMatchObject({ code: "actor_forbidden" });
    await db.getPool().query("UPDATE users SET is_active=FALSE WHERE id=$1", [admin.userId]);
    try { await expect(core(admin, operationKey, input)).rejects.toMatchObject({ code: "actor_forbidden" }); }
    finally { await db.getPool().query("UPDATE users SET is_active=TRUE WHERE id=$1", [admin.userId]); }
    expect(await effects()).toEqual(before);
  });

  it("serializes concurrent wrapper/core replay and completes only the remaining partial receipt", async () => {
    const order = await issued(); const input = receipt(order); const operationKey = key();
    const before = await effects();
    const results = await Promise.all([core(admin, operationKey, input), store.postInspectedReceipt(admin, operationKey, input)]);
    expect(results.map(row => row.replayed).sort()).toEqual([false, true]);
    expect(results[0].remaining[0].remainingFulfillmentBaseQuantity).toBe("100");
    const final = await core(admin, key(), receipt(order, locationId, "2"));
    expect(final.remaining[0].remainingFulfillmentBaseQuantity).toBe("0");
    const after = await effects();
    expect(after.movements - before.movements).toBe(2);
    expect(after.payables).toBe(before.payables); expect(after.expenses).toBe(before.expenses);
    await expect(core(admin, key(), receipt(order))).rejects.toMatchObject({ code: "overdelivery" });
    expect(await effects()).toEqual(after);
  });

  it.each(["YER", "SAR", "USD"] as const)("keeps %s native quotes, fractional piece costs and proven quote zero separate from unknown final valuation", async currency => {
    for (const quote of [1, 0]) {
      const order = await issued(currency, quote); const input = receipt(order); const before = await effects();
      await core(admin, key(), input);
      const result = await db.getPool().query("SELECT m.qty::text,m.unit_cost_minor,m.party_id,m.payable_id,l.cost_status,l.cost_snapshot,a.qty::text AS allocated FROM goods_receipt_lines g JOIN stock_lots l ON l.receipt_line_id=g.id JOIN inventory_movements m ON m.id=l.movement_id JOIN inventory_movement_allocations a ON a.movement_id=m.id WHERE g.receipt_id=$1", [input.id]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ qty: "50.000", unit_cost_minor: null, party_id: null, payable_id: null, cost_status: "estimated", allocated: "50.000", cost_snapshot: { currency, price: { state: "known", currency, unitPriceMinor: quote }, conversion: { baseUnitsPerEnteredUnit: "50" }, financialValuation: "pending_invoice_adapter" } });
      const { readInventoryValuation } = await import("../../lib/inventory-domain/read");
      const valuation = await readInventoryValuation();
      expect(valuation.items.find(item => item.id === itemId)).toMatchObject({ costStatus: "missing", valueMinor: null, unitCostMinor: null });
      const after = await effects(); expect(after.payables).toBe(before.payables); expect(after.expenses).toBe(before.expenses);
    }
  });

  it("keeps expiry refusal, quarantine, supplier return and replacement quantities source-linked without financial posting", async () => {
    const order = await issued(); const input = receipt(order); const before = await effects();
    const portion = input.lines[0].portions[0];
    const expired = { ...input, lines: [{ ...input.lines[0], portions: [{ ...portion, expiryDate: "2020-01-01" }] }] };
    await expect(core(admin, key(), expired)).rejects.toMatchObject({ code: "expired_receipt" });
    expect(await effects()).toEqual(before);
    const held: ReceiptRevision = { ...input, lines: [{ ...input.lines[0], portions: [{ ...portion, disposition: "quarantined", reason: "Synthetic inspection pending" }] }] };
    const result = await core(admin, key(), held);
    expect(result.stockEntries[0].availability).toBe("quarantined");
    await store.resolveQuarantineReceipt(admin, key(), { id: key(), orderId: order.id, receiptLineId: portion.id, action: "reject_return", quantity: "1", reason: "Synthetic rejected material returned" });
    const replacement = await core(admin, key(), receipt(order, locationId, "3"));
    expect(replacement.remaining[0]).toMatchObject({ acceptedBaseQuantity: "150", quarantinedBaseQuantity: "0", rejectedBaseQuantity: "50", remainingFulfillmentBaseQuantity: "0" });
    const rows = await db.getPool().query("SELECT m.kind,m.is_return,a.lot_id,a.location_id,a.qty::text FROM quarantine_dispositions q JOIN inventory_movements m ON m.id=q.movement_id JOIN inventory_movement_allocations a ON a.movement_id=m.id WHERE q.receipt_line_id=$1", [portion.id]);
    expect(rows.rows).toHaveLength(1); expect(rows.rows[0]).toMatchObject({ kind: "out", is_return: true, location_id: locationId, qty: "50.000" });
    const after = await effects(); expect(after.payables).toBe(before.payables); expect(after.expenses).toBe(before.expenses);
  });

  it("waits for an already-running owner deactivation, then refuses before item locks or effects", async () => {
    const { partyId, destination } = await activeCustody(); const order = await issued(); const input = receipt(order, destination); const before = await effects();
    const updater = await db.getPool().connect(); const receiver = await db.getPool().connect();
    const statements: string[] = []; const atOwner = deferred();
    try {
      await updater.query("BEGIN"); await updater.query("UPDATE parties SET is_active=FALSE WHERE id=$1", [partyId]);
      await receiver.query("BEGIN");
      const pid = (await receiver.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const traced: DbClient = { ...observedClient(receiver, statements), query: async <T>(sql: string, values?: Parameters<DbClient["query"]>[1]) => {
        if (sql.startsWith("SELECT id,kind,is_active FROM parties")) atOwner.resolve();
        statements.push(sql); return receiver.query<T>(sql, values);
      } };
      const attempt = store.postInspectedReceiptInTransaction(traced, admin, key(), input).then(result => ({ result, error: null }), error => ({ result: null, error }));
      await atOwner.promise;
      await vi.waitFor(async () => expect((await db.getPool().query<{ waiting: boolean }>("SELECT cardinality(pg_blocking_pids($1))>0 AS waiting", [pid])).rows[0].waiting).toBe(true));
      expect(statements.some(sql => sql.startsWith("SELECT id,is_active,unit FROM inventory_items"))).toBe(false);
      await updater.query("COMMIT");
      expect((await attempt).error).toMatchObject({ code: "doctor_unavailable" });
      await receiver.query("ROLLBACK"); expect(await effects()).toEqual(before);
    } finally {
      await updater.query("ROLLBACK"); await receiver.query("ROLLBACK"); updater.release(); receiver.release();
    }
  });

  it("holds the verified owner through receipt commit; later deactivation does not alter committed replay", async () => {
    const { partyId, destination } = await activeCustody(); const order = await issued(); const input = receipt(order, destination); const operationKey = key();
    const receiver = await db.getPool().connect(); const updater = await db.getPool().connect(); const ownerLocked = deferred(); const continueReceipt = deferred();
    try {
      await receiver.query("BEGIN"); await updater.query("BEGIN");
      const pid = (await updater.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const attempt = store.postInspectedReceiptInTransaction(observedClient(receiver, [], async sql => {
        if (sql.startsWith("SELECT id,kind,is_active FROM parties")) { ownerLocked.resolve(); await continueReceipt.promise; }
      }), admin, operationKey, input).then(result => ({ result, error: null }), error => ({ result: null, error }));
      await ownerLocked.promise;
      const mutation = updater.query("UPDATE parties SET is_active=FALSE WHERE id=$1", [partyId]);
      await vi.waitFor(async () => expect((await db.getPool().query<{ waiting: boolean }>("SELECT cardinality(pg_blocking_pids($1))>0 AS waiting", [pid])).rows[0].waiting).toBe(true));
      continueReceipt.resolve(); const posted = await attempt; expect(posted.error).toBeNull();
      await receiver.query("COMMIT"); await mutation; await updater.query("COMMIT");
      expect(await core(admin, operationKey, input)).toEqual({ ...posted.result, replayed: true });
      expect(await store.postInspectedReceipt(admin, operationKey, input)).toEqual({ ...posted.result, replayed: true });
      await expect(core(admin, key(), receipt(order, destination))).rejects.toMatchObject({ code: "doctor_unavailable" });
      expect((await db.getPool().query("SELECT doctor_party_id FROM inventory_locations WHERE id=$1", [destination])).rows[0].doctor_party_id).toBe(partyId);
    } finally {
      continueReceipt.resolve(); await receiver.query("ROLLBACK"); await updater.query("ROLLBACK"); receiver.release(); updater.release();
    }
  });

});
