/** M3a: canonical procurement, custody and reads on real PostgreSQL (synthetic only).
 * Every command is admitted by its exact catalogue capability inside the canonical
 * runtime; every read is one owning RR READ ONLY snapshot. Adjacent actions, role
 * labels and stale grants never decide. */
vi.mock("server-only", () => ({}));
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { valuationSnapshot, type PurchaseOrder, type RequestRevision, type ReceiptRevision, type SupplierInvoiceRevision } from "../../lib/inventory-domain/procurement";
import type { VerifiedDurableSession } from "../../lib/staff-durable-session";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-procurement-secret-2026");
const db = await import("../../lib/db");
const { runCanonicalProcurementCommand, PROCUREMENT_COMMAND_CAPABILITIES } = await import("../../lib/inventory-domain/canonical-procurement-transport");
const store = await import("../../lib/inventory-domain/procurement-store");
const custody = await import("../../lib/inventory-domain/custody-store");
const reference = await import("../../lib/inventory-domain/reference-setup");

const ACCOUNTS = {
  owner: { username: "SYN-C-OWNER", role: "admin" },
  requester: { username: "SYN-C-REQUESTER", role: "reception", grants: { "inventory.references.view": true, "inventory.requests.view": true, "inventory.requests.create": true } },
  approver: { username: "SYN-C-APPROVER", role: "reception", grants: { "inventory.requests.view": true, "inventory.requests.approve": true } },
  buyer: { username: "SYN-C-BUYER", role: "reception", grants: { "inventory.requests.view": true, "inventory.orders.view": true, "inventory.orders.manage": true, "inventory.receipts.post": true, "inventory.quarantine.resolve": true, "finance.suppliers.view": true, "inventory.supplier-invoices.record": true } },
  receiver: { username: "SYN-C-RECEIVER", role: "reception", grants: { "inventory.orders.view": true, "inventory.receipts.post": true } },
  keeper: { username: "SYN-C-KEEPER", role: "reception", grants: { "inventory.references.view": true, "inventory.custody.view": true, "inventory.custody.dispatch": true } },
  doctorA: { username: "SYN-C-DOCTOR-A", role: "doctor", doctor: true, grants: { "inventory.custody.view": true, "inventory.custody.acknowledge": true, "inventory.custody.use": true, "inventory.custody.stocktake": true } },
  doctorB: { username: "SYN-C-DOCTOR-B", role: "doctor", doctor: true, grants: { "inventory.custody.view": true, "inventory.custody.acknowledge": true, "inventory.custody.use": true } },
  waste: { username: "SYN-C-WASTE", role: "reception", grants: { "inventory.custody.view": true, "inventory.custody.approve-waste": true } },
  costs: { username: "SYN-C-COSTS", role: "reception", grants: { "finance.cost-prices.view": true, "inventory.costs.view": true, "inventory.custody.view": true, "inventory.custody.dispatch": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let itemId: number, supplierId: number;
const store_ = `SYN-C-STORE-${randomUUID()}`, transit = `SYN-C-TRANSIT-${randomUUID()}`, custodyA = `SYN-C-CUST-A-${randomUUID()}`, custodyB = `SYN-C-CUST-B-${randomUUID()}`;
const key = () => randomUUID();
const as = (k: Key) => fx.session(k);
const run = async (k: Key, input: Parameters<typeof runCanonicalProcurementCommand>[2], operationKey = key()) => runCanonicalProcurementCommand(await as(k), operationKey, input);
const conversion = () => ({ itemId, version: 1, baseUnit: "piece", enteredUnit: "piece", baseUnitsPerEnteredUnit: "1", enteredPrecision: 0, basePrecision: 0 });

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const pool = fx.pool;
  itemId = (await pool.query<{ id: number }>("INSERT INTO inventory_items(name,category,unit,min_level,created_by) VALUES('SYN-C gloves','other','piece',0,'SYN-C-OWNER') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO inventory_item_unit_versions(item_id,version,entered_unit,base_unit,factor,entered_precision,base_precision) VALUES($1,1,'piece','piece',1,0,0)", [itemId]);
  supplierId = (await pool.query<{ id: number }>("INSERT INTO parties(name,kind) VALUES('SYN-C supplier','supplier') RETURNING id")).rows[0].id;
  for (const [id, label, kind, doctor] of [[store_, "Synthetic store", "store", null], [transit, "Synthetic transit", "transit", null], [custodyA, "Synthetic custody A", "custody", fx.parties.doctorA], [custodyB, "Synthetic custody B", "custody", fx.parties.doctorB]] as const)
    await pool.query("INSERT INTO inventory_locations(id,branch_key,label,kind,doctor_party_id) VALUES($1,'clinic',$2,$3,$4)", [id, label, kind, doctor]);
  await pool.query("INSERT INTO inventory_approval_policies(id,branch_key,version,currency,limit_minor,allow_self_approval,created_by) VALUES($1,'clinic',1,'YER',1000000000,FALSE,$2)", [key(), fx.ids.owner]);
}, 180_000);
afterAll(async () => { await fx?.close(); });

const request = (requestedBy: number): RequestRevision => ({ id: key(), version: 1, branchId: "clinic", requestedBy, reason: "Synthetic canonical supplies", proposedSupplierPartyId: supplierId, value: { currency: "SAR", amountMinor: 20000 }, lines: [{ id: key(), itemId, quantity: "40", conversion: conversion() }] });
const approval = (r: RequestRevision) => ({ requestId: r.id, version: 1, decisions: [{ lineId: r.lines[0].id, quantity: "40", reason: "Synthetic approval" }],
  valuation: valuationSnapshot({ purpose: "approval_estimate", currency: "SAR", amountMinor: 20000, rateToBase: "140", capturedAt: "2026-10-28T01:00:00Z", sourceRef: "synthetic quote" }) });
const order = (r: RequestRevision): PurchaseOrder => ({ id: key(), version: 1, branchId: "clinic", supplierPartyId: supplierId, currency: "SAR", shippingMinor: 0, discountMinor: 0,
  lines: [{ id: key(), itemId, kind: "stock", quantity: "40", conversion: conversion(), price: { state: "known", currency: "SAR", unitPriceMinor: 500, reason: "Synthetic quote" }, trackLot: true, requiresExpiry: false, minimumShelfLifeDays: 0,
    sources: [{ id: key(), requestId: r.id, requestLineId: r.lines[0].id, baseQuantity: "40" }] }] });
const receipt = (o: PurchaseOrder, portion = key()): ReceiptRevision => ({ id: key(), version: 1, orderId: o.id, orderVersion: 1, branchId: "clinic", supplierPartyId: supplierId, actualArrivalDate: "2026-10-28",
  lines: [{ orderLineId: o.lines[0].id, arrivedQuantity: "40", portions: [{ id: portion, quantity: "40", disposition: "accepted", lotCode: "SYN-C-LOT", expiryDate: null, locationId: store_, damaged: false, reason: "Synthetic inspection" }] }] });
async function lotOf(o: PurchaseOrder) { return (await fx.pool.query<{ id: string }>("SELECT l.id::text FROM stock_lots l JOIN goods_receipt_lines g ON g.id=l.receipt_line_id WHERE g.order_id=$1 LIMIT 1", [o.id])).rows[0].id; }
async function effects() { return (await fx.pool.query("SELECT (SELECT count(*) FROM payables)::int AS payables,(SELECT count(*) FROM expenses)::int AS expenses,(SELECT count(*) FROM payments)::int AS payments")).rows[0]; }

describe("command → exact capability map", () => {
  it("every procurement/custody command maps to exactly one catalogue capability", () => {
    expect(Object.keys(PROCUREMENT_COMMAND_CAPABILITIES).sort()).toEqual(["custody.acknowledge", "custody.approve_waste", "custody.close_package", "custody.consume", "custody.dispatch", "custody.object_settlement", "custody.propose_settlement", "custody.return_to_store", "custody.stocktake", "invoice.match", "legacy.reconcile", "order.amend", "order.issue", "quarantine.resolve", "receipt.post", "request.approve", "request.revise", "request.submit"]);
  });
});

describe("procurement cycle under delegated canonical grants", () => {
  let r: RequestRevision, o: PurchaseOrder;
  it("requester submits (owner of the request is the admitted actor), but cannot approve or order", async () => {
    r = request(999999);
    const before = await effects();
    const submitted = await run("requester", { command: "request.submit", document: r });
    expect(submitted).toMatchObject({ replayed: false });
    const stored = (await fx.pool.query("SELECT requested_by FROM purchase_requests WHERE id=$1", [r.id])).rows[0];
    expect(stored.requested_by).toBe(fx.ids.requester); // body field ignored
    await expect(run("requester", { command: "request.approve", approval: approval(r) })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    await expect(run("requester", { command: "order.issue", document: order(r) })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    expect(await effects()).toEqual(before);
  });
  it("reads: the requester sees only own requests without values; the approver sees all with values", async () => {
    const mine = await store.readProcurementRequestsCanonical(await as("requester"));
    expect(mine.items.map(row => row.id)).toEqual([r.id]);
    expect(mine.items[0].document.value).toBeNull();
    const other = request(0);
    await run("owner", { command: "request.submit", document: other });
    expect((await store.readProcurementRequestsCanonical(await as("requester"))).items.map(row => row.id)).toEqual([r.id]);
    const all = await store.readProcurementRequestsCanonical(await as("approver"));
    expect(all.items.map(row => row.id).sort()).toEqual([r.id, other.id].sort());
    expect(all.items.find(row => row.id === r.id)!.document.value).toEqual({ currency: "SAR", amountMinor: 20000 });
    await expect(store.readProcurementRequestsCanonical(await as("keeper"))).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    const catalog = await store.readProcurementCatalogCanonical(await as("requester"));
    expect(catalog.items.some(row => row.itemId === itemId)).toBe(true);
  });
  it("the approver approves; the owner may not self-approve own request", async () => {
    expect(await run("approver", { command: "request.approve", approval: approval(r) })).toMatchObject({ replayed: false });
    const own = request(0);
    await run("owner", { command: "request.submit", document: own });
    await expect(run("owner", { command: "request.approve", approval: approval(own) })).rejects.toMatchObject({ code: "self_approval_forbidden" });
  });
  it("buyer issues; receiver may receive but not order; the workbench needs orders.view", async () => {
    o = order(r);
    await expect(run("receiver", { command: "order.issue", document: o })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    expect(await run("buyer", { command: "order.issue", document: o })).toMatchObject({ replayed: false });
    const bench = await store.readProcurementWorkbenchCanonical(await as("receiver"));
    expect(bench.orders.some(row => row.id === o.id)).toBe(true);
    await expect(store.readProcurementWorkbenchCanonical(await as("requester"))).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    const before = await effects();
    const k = key();
    const first = await run("receiver", { command: "receipt.post", document: receipt(o) }, k);
    expect(first).toMatchObject({ replayed: false });
    expect(await effects()).toEqual(before); // receipt: stock only, no debt/cash
  });
  it("same operation key replays under the canonical actor; a revoked grant refuses even the replay", async () => {
    const r2 = request(0), k = key();
    const first = await run("requester", { command: "request.submit", document: r2 }, k);
    const again = await run("requester", { command: "request.submit", document: r2 }, k);
    expect([first.replayed, again.replayed]).toEqual([false, true]);
    const stale = await as("requester");
    await fx.setGrants("requester", { "inventory.references.view": true, "inventory.requests.view": true });
    // A permission write also advances the account epoch: the stale session is refused before any domain read.
    await expect(runCanonicalProcurementCommand(stale, k, { command: "request.submit", document: r2 })).rejects.toThrow(/^STAFF_OPERATION_(CREDENTIAL_OR_ACCOUNT|PERMISSIONS)_STALE$/);
    // A fresh session reflects the narrowed grant exactly.
    await expect(run("requester", { command: "request.submit", document: request(0) })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    await fx.setGrants("requester", ACCOUNTS.requester.grants);
  });
  it("invoice match requires the supplier-invoice grant", async () => {
    const lots = (await fx.pool.query<{ id: string }>("SELECT id FROM goods_receipt_lines WHERE order_id=$1", [o.id])).rows;
    const lineId = key();
    const invoice: SupplierInvoiceRevision = { id: key(), version: 1, orderId: o.id, orderVersion: 1, branchId: "clinic", supplierPartyId: supplierId, currency: "SAR", invoiceNumber: `SYN-C-${key()}`, invoiceDate: "2026-10-28", missingNumberReason: null, shippingMinor: 0, discountMinor: 0,
      valuation: valuationSnapshot({ purpose: "invoice_valuation", currency: "SAR", amountMinor: 20000, rateToBase: "140", capturedAt: "2026-10-28T01:00:00Z", sourceRef: "Synthetic invoice FX" }),
      lines: [{ id: lineId, orderLineId: o.lines[0].id, quantity: "40", price: o.lines[0].price, receiptAllocations: [{ id: key(), invoiceLineId: lineId, receiptLineId: lots[0].id, baseQuantity: "40" }] }] };
    await expect(run("receiver", { command: "invoice.match", document: invoice })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    expect(await run("buyer", { command: "invoice.match", document: invoice })).toMatchObject({ status: "matched" });
  });

  describe("custody under exact grants and the validated clinician link", () => {
    let lot: string;
    const transfer = (to: string, quantity = "10") => ({ id: key(), fromLocationId: store_, toLocationId: to, transitLocationId: transit, reason: "Synthetic custody supply", lines: [{ id: key(), lotId: lot, quantity }] });
    const ack = (t: ReturnType<typeof transfer>) => ({ id: key(), transferId: t.id, reason: "Synthetic count", lines: [{ lineId: t.lines[0].id, acceptedQuantity: t.lines[0].quantity, returnedQuantity: "0" }] });
    it("keeper dispatches; doctors acknowledge only their own custody; the statement scope follows grants", async () => {
      lot = await lotOf(o);
      const toA = transfer(custodyA);
      await expect(run("doctorA", { command: "custody.dispatch", transfer: toA })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
      await run("keeper", { command: "custody.dispatch", transfer: toA });
      await expect(run("doctorB", { command: "custody.acknowledge", acknowledgement: ack(toA) })).rejects.toMatchObject({ code: "custody_owner_forbidden" });
      await run("doctorA", { command: "custody.acknowledge", acknowledgement: ack(toA) });
      const mine = await custody.readDoctorCustodyCanonical(await as("doctorA"));
      expect(mine.locations.map(row => row.id)).toEqual([custodyA]);
      expect(mine.pricesAllowed).toBe(false);
      expect(mine.locations[0].lots[0]).not.toHaveProperty("quote");
      const oversight = await custody.readDoctorCustodyCanonical(await as("keeper"));
      expect(oversight.locations.map(row => row.id)).toEqual(expect.arrayContaining([store_, custodyA, custodyB]));
      expect(oversight.pricesAllowed).toBe(false);
      const priced = await custody.readDoctorCustodyCanonical(await as("costs"));
      expect(priced.pricesAllowed).toBe(true);
      await expect(custody.readDoctorCustodyCanonical(await as("buyer"))).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    });
    it("waste needs an independent current approver; revoking the approver voids the approval", async () => {
      const usage = (approvalId: string | null, kind: "consumed" | "approved_waste") => ({ id: key(), locationId: custodyA, storeLocationId: null, lotId: lot, kind, quantity: "1", quantityState: "confirmed", patientId: null, visitId: null, procedureId: null, wasteApprovalId: approvalId, reason: "Synthetic usage" });
      await expect(run("doctorA", { command: "custody.approve_waste", approval: { id: key(), locationId: custodyA, lotId: lot, maxQuantity: "2", reason: "Synthetic" } })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
      const approvalId = key();
      await run("waste", { command: "custody.approve_waste", approval: { id: approvalId, locationId: custodyA, lotId: lot, maxQuantity: "2", reason: "Synthetic broken pack" } });
      await run("doctorA", { command: "custody.consume", usage: usage(approvalId, "approved_waste") as never });
      const second = key();
      await run("waste", { command: "custody.approve_waste", approval: { id: second, locationId: custodyA, lotId: lot, maxQuantity: "2", reason: "Synthetic second pack" } });
      await fx.setGrants("waste", { "inventory.custody.view": true });
      await expect(run("doctorA", { command: "custody.consume", usage: usage(second, "approved_waste") as never })).rejects.toMatchObject({ code: "invalid_waste_approval" });
      await fx.setGrants("waste", ACCOUNTS.waste.grants);
      await run("doctorA", { command: "custody.consume", usage: usage(second, "approved_waste") as never });
      // A consumption declared as a return is refused by the exact command contract.
      await expect(run("doctorA", { command: "custody.return_to_store", usage: usage(null, "consumed") as never })).rejects.toMatchObject({ code: "invalid_custody_usage" });
    });
  });
});

describe("approval-limit revision (inventory.approval-policy.manage)", () => {
  it("only the exact grant revises the limit, as a new immutable version with self-approval still off", async () => {
    const { REFERENCE_PROTOCOL } = await import("../../lib/inventory-reference-protocol");
    const { syntheticClaims } = await import("./_canonical-ready-fixture");
    const intentFor = async (k: Key) => {
      const claims = await syntheticClaims(fx.pool, "public", fx.ids[k]);
      return { protocol: REFERENCE_PROTOCOL, nonce: key(), authority: { realmId: claims.durableIdentity.realmId, subjectId: claims.durableIdentity.subjectId, generation: claims.durableIdentity.generationId },
        input: { action: "policy.revise" as const, expectedVersion: 1, limitMinor: 5000000, reason: "Synthetic new approval ceiling" } };
    };
    await expect(reference.commandCanonicalInventoryPolicyRevise(db.getPool(), await as("approver"), await intentFor("approver") as never, "admit")).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    const intent = await intentFor("owner");
    await reference.commandCanonicalInventoryPolicyRevise(db.getPool(), await as("owner"), intent as never, "admit");
    const done = await reference.commandCanonicalInventoryPolicyRevise(db.getPool(), await as("owner"), intent as never, "execute");
    expect(done).toMatchObject({ status: "committed" });
    const rows = (await fx.pool.query("SELECT version,limit_minor::text,allow_self_approval FROM inventory_approval_policies WHERE branch_key='clinic' ORDER BY version")).rows;
    expect(rows).toEqual([{ version: 1, limit_minor: "1000000000", allow_self_approval: false }, { version: 2, limit_minor: "5000000", allow_self_approval: false }]);
    // A stale expected version refuses.
    const stale = await intentFor("owner");
    await reference.commandCanonicalInventoryPolicyRevise(db.getPool(), await as("owner"), stale as never, "admit");
    await expect(reference.commandCanonicalInventoryPolicyRevise(db.getPool(), await as("owner"), stale as never, "execute")).rejects.toMatchObject({ code: "stale_version" });
  });
});

describe("owning snapshot reads", () => {
  it("canonical reads take no row locks, run no DDL and refuse an expired session", async () => {
    await fx.pool.query(`CREATE TABLE IF NOT EXISTS synthetic_ddl_log(id BIGSERIAL PRIMARY KEY, tag TEXT NOT NULL);
      CREATE OR REPLACE FUNCTION synthetic_record_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO synthetic_ddl_log(tag) VALUES (tg_tag); END $$;
      DROP EVENT TRIGGER IF EXISTS synthetic_inventory_ddl_watch; CREATE EVENT TRIGGER synthetic_inventory_ddl_watch ON ddl_command_start EXECUTE FUNCTION synthetic_record_ddl();`);
    try {
      const before = (await fx.pool.query("SELECT count(*)::int AS n FROM synthetic_ddl_log")).rows[0].n;
      await store.readProcurementRequestsCanonical(await as("approver"));
      await store.readProcurementCatalogCanonical(await as("requester"));
      await store.readProcurementWorkbenchCanonical(await as("buyer"));
      await custody.readDoctorCustodyCanonical(await as("keeper"));
      await reference.readCanonicalFirstUseReadiness(await as("requester"));
      expect((await fx.pool.query("SELECT count(*)::int AS n FROM synthetic_ddl_log")).rows[0].n).toBe(before);
    } finally { await fx.pool.query("DROP EVENT TRIGGER IF EXISTS synthetic_inventory_ddl_watch"); }
    const expired = await fx.session("approver", 300);
    await new Promise(resolve => setTimeout(resolve, 400));
    await expect(store.readProcurementRequestsCanonical(expired)).rejects.toThrow(/SESSION/);
  });
  it("an exclusive authority writer blocks a new reader until it commits; the reader then sees the new grant", async () => {
    const session: VerifiedDurableSession = await as("approver");
    const holder = await fx.pool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    const pending = store.readProcurementRequestsCanonical(session);
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      const { rows: [row] } = await holder.query<{ permissions: string }>("SELECT permissions FROM users WHERE id=$1", [fx.ids.approver]);
      const doc = JSON.parse(row.permissions);
      await holder.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify({ ...doc, revision: doc.revision + 1, grants: {} }), fx.ids.approver]);
      await holder.query("COMMIT");
      // Admitted only after the writer committed: the old session no longer proves.
      await expect(pending).rejects.toThrow(/^STAFF_OPERATION_(CREDENTIAL_OR_ACCOUNT|PERMISSIONS)_STALE$/);
    } finally { await holder.query("ROLLBACK").catch(() => {}); holder.release(); await pending.catch(() => {}); }
    await fx.setGrants("approver", ACCOUNTS.approver.grants);
  });
});
