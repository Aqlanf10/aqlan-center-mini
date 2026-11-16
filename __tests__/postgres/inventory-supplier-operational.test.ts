/** Supplier invoice/payable transport on the CANONICAL runtime (M3a).
 *
 * Migrated from the obsolete parallel-authority suite (STAFF_AUTHORITY_SQL + signed
 * `authority` session + legacy admin role). Every positive supplier effect is kept:
 * post, cancel, revise, official-number completion, replay, durable rejection,
 * retirement, audit atomicity and concurrency. Authority now comes only from the
 * canonical identity: exact capabilities (`inventory.supplier-invoices.record`,
 * `.cancel`, `finance.suppliers.view`) proved in the same transaction, and the
 * intent triple {realm, subject, identity generation}. No cast, no test signer granting
 * the old authority, no role fallback. Runs on its own owned database. */
vi.mock("server-only", () => ({}));
import { INVENTORY_SUPPLIER_NUMBER_SQL } from "../../lib/inventory-domain/supplier-number-schema-proposal";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { syntheticClaims } from "./_canonical-ready-fixture";
import { supplierInvoiceDigest, createSupplierInvoiceFinanceService, supplierFinanceCommandScope } from "../../lib/inventory-domain/supplier-finance";
import { valuationSnapshot, supplierInvoiceDuplicateKey, payloadIdentity, type SupplierInvoiceRevision, type RequestRevision, type PurchaseOrder } from "../../lib/inventory-domain/procurement";
import type { InventoryActor } from "../../lib/inventory-domain/procurement-store";
import type { DbClient } from "../../lib/db";
import type { Currency } from "../../lib/money";
import type { InventoryRuntimeAction } from "../../lib/staff-operation-runtime";
import type { InventoryPrincipal } from "../../lib/inventory-domain/principal";
import { SUPPLIER_PROTOCOL, type SupplierIntent, type SupplierAction, type SupplierAdmission } from "../../lib/inventory-supplier-protocol";
import type { SessionPayload } from "../../lib/auth";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-inventory-operational-test-secret-2026");
const db = await import("../../lib/db");
const transport = await import("../../lib/inventory-domain/supplier-transport");
const { runCanonicalProcurementCommand } = await import("../../lib/inventory-domain/canonical-procurement-transport");
const canonical = await import("../../lib/inventory-domain/canonical-operation");

const MANAGER_GRANTS = {
  "inventory.requests.view": true, "inventory.requests.approve": true,
  "inventory.orders.view": true, "inventory.orders.manage": true, "inventory.receipts.post": true,
  "finance.suppliers.view": true, "inventory.supplier-invoices.record": true, "inventory.supplier-invoices.cancel": true,
};
const ACCOUNTS = {
  owner: { username: "SYN-SFIN-OWNER", role: "admin" },
  manager: { username: "SYN-SFIN-MANAGER", role: "reception", grants: MANAGER_GRANTS },
  other: { username: "SYN-SFIN-OTHER", role: "reception", grants: MANAGER_GRANTS },
  recorder: { username: "SYN-SFIN-RECORDER", role: "reception", grants: { "inventory.orders.view": true, "finance.suppliers.view": true, "inventory.supplier-invoices.record": true } },
  requester: { username: "SYN-SFIN-REQUESTER", role: "doctor", doctor: true, grants: { "inventory.references.view": true, "inventory.requests.view": true, "inventory.requests.create": true } },
} as const;
type Who = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Who>;
let itemId: number, location: string;
const key = () => randomUUID();
const pool = () => db.getPool();
const expectation = (invoice: SupplierInvoiceRevision) => ({ invoiceId: invoice.id, expectedVersion: invoice.version, expectedDigest: supplierInvoiceDigest(invoice), reason: "Synthetic reviewed supplier source" });
const command = async (who: Who, input: Parameters<typeof runCanonicalProcurementCommand>[2]) => runCanonicalProcurementCommand(await fx.session(who), key(), input);
/** The canonical authority triple carried by an intent: current realm, subject and identity generation. */
async function authorityOf(who: Who) {
  const claims = await syntheticClaims(fx.pool, "public", fx.ids[who]);
  return { realmId: claims.durableIdentity.realmId, subjectId: claims.durableIdentity.subjectId, executionEpochId: claims.durableIdentity.generationId };
}
async function attempt(who: Who, intent: SupplierIntent) { return transport.admitSupplierIntentCanonical(await fx.session(who), intent); }
async function admit(who: Who, intent: SupplierIntent) {
  const result = await attempt(who, intent);
  if ("status" in result) throw new Error(`Unexpected admission rejection: ${result.code}`);
  return result;
}
async function execute(who: Who, admission: SupplierAdmission, reason?: string) { return transport.executeSupplierIntentCanonical(await fx.session(who), admission, reason); }
async function read(who: Who, orderId: string) { return transport.readSupplierFinanceCanonical(await fx.session(who), orderId); }
async function intentFor(invoice: SupplierInvoiceRevision, action: SupplierAction = "post", who: Who = "manager"): Promise<SupplierIntent> {
  return { protocol: SUPPLIER_PROTOCOL, authority: await authorityOf(who), nonce: key(), action, input: expectation(invoice) };
}
/** Domain service inside ONE admitted canonical operation (never a role policy). */
async function asOperation<T>(who: Who, action: InventoryRuntimeAction, work: (c: DbClient, actor: InventoryActor, principal: InventoryPrincipal) => Promise<T>) {
  return canonical.withCanonicalInventoryOperation(pool(), await fx.session(who), action, authority =>
    work(canonical.canonicalInventoryClient(authority), { ...canonical.canonicalInventoryActor(authority) }, canonical.canonicalInventoryPrincipal(authority)));
}

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  itemId = (await db.createInventoryItem({ name: `SYN-SFIN-${key()}`, category: "other", unit: "piece", minLevel: 0, note: null, createdBy: ACCOUNTS.owner.username })).id;
  await pool().query("INSERT INTO inventory_item_unit_versions(item_id,version,entered_unit,base_unit,factor,entered_precision,base_precision) VALUES($1,1,'piece','piece',1,0,0)", [itemId]);
  location = `SYN-${key()}`;
  await pool().query("INSERT INTO inventory_locations(id,branch_key,label,kind) VALUES($1,'clinic','Synthetic store','store')", [location]);
  await pool().query("INSERT INTO inventory_approval_policies(id,branch_key,version,currency,limit_minor,allow_self_approval,created_by) VALUES($1,'clinic',1,'YER',1000000000,FALSE,$2)", [key(), fx.ids.owner]);
  await db.openShift({ openedBy: ACCOUNTS.manager.username, opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await fx?.close(); });

async function fixture(currency: Currency = "SAR", missingValuation = false, options: { missingNumber?: boolean; supplierId?: number; number?: string; skipMatch?: boolean } = {}) {
  const supplierId = options.supplierId ?? (await pool().query("INSERT INTO parties(name,kind) VALUES($1,'supplier') RETURNING id", [`SYN-SFIN-${key()}`])).rows[0].id;
  const rate = currency === "YER" ? "1" : "123.456789",
    conversion = { itemId, version: 1, baseUnit: "piece", enteredUnit: "piece", baseUnitsPerEnteredUnit: "1", enteredPrecision: 0, basePrecision: 0 };
  const r: RequestRevision = { id: key(), version: 1, branchId: "clinic", requestedBy: fx.ids.requester, reason: "Synthetic needed supplies", proposedSupplierPartyId: supplierId,
    value: { currency, amountMinor: 20000 }, lines: [{ id: key(), itemId, quantity: "2", conversion }] };
  await command("requester", { command: "request.submit", document: r });
  await command("manager", { command: "request.approve", approval: { requestId: r.id, version: 1, decisions: [{ lineId: r.lines[0].id, quantity: "2", reason: "Synthetic approval" }],
    valuation: valuationSnapshot({ purpose: "approval_estimate", currency, amountMinor: 20000, rateToBase: rate, capturedAt: "2026-10-26T01:00:00Z", sourceRef: "synthetic frozen quote" }) } });
  const o: PurchaseOrder = { id: key(), version: 1, branchId: "clinic", supplierPartyId: supplierId, currency, shippingMinor: 0, discountMinor: 0,
    lines: [{ id: key(), itemId, kind: "stock", quantity: "2", conversion, price: { state: "known", currency, unitPriceMinor: 10000, reason: "Synthetic quote" },
      trackLot: true, requiresExpiry: false, minimumShelfLifeDays: 0, sources: [{ id: key(), requestId: r.id, requestLineId: r.lines[0].id, baseQuantity: "2" }] }] };
  await command("manager", { command: "order.issue", document: o });
  const receiptLine = key();
  await command("manager", { command: "receipt.post", document: { id: key(), version: 1, orderId: o.id, orderVersion: 1, branchId: "clinic", supplierPartyId: supplierId, actualArrivalDate: "2026-10-26",
    lines: [{ orderLineId: o.lines[0].id, arrivedQuantity: "2", portions: [{ id: receiptLine, quantity: "2", disposition: "accepted", lotCode: "SYN-SFIN", expiryDate: null, locationId: location, damaged: false, reason: "Synthetic inspection" }] }] } });
  const lineId = key();
  const invoice: SupplierInvoiceRevision = { id: key(), version: 1, orderId: o.id, orderVersion: 1, branchId: "clinic", supplierPartyId: supplierId, currency,
    invoiceNumber: options.missingNumber ? null : (options.number ?? `SYN-${key()}`), invoiceDate: "2026-10-26",
    missingNumberReason: options.missingNumber ? "Synthetic official number unavailable" : null, shippingMinor: 0, discountMinor: 0,
    valuation: missingValuation ? null : valuationSnapshot({ purpose: "invoice_valuation", currency, amountMinor: 20000, rateToBase: rate, capturedAt: "2026-10-26T01:00:00Z", sourceRef: "Synthetic invoice FX" }),
    lines: [{ id: lineId, orderLineId: o.lines[0].id, quantity: "2", price: o.lines[0].price, receiptAllocations: [{ id: key(), invoiceLineId: lineId, receiptLineId: receiptLine, baseQuantity: "2" }] }] };
  if (!options.skipMatch) await command("manager", { command: "invoice.match", document: invoice });
  return invoice;
}
async function counts() {
  return (await pool().query("SELECT (SELECT count(*)::int FROM payables) AS debt,(SELECT count(*)::int FROM payable_adjustments) AS adjustments,(SELECT count(*)::int FROM expenses) AS cash,(SELECT count(*)::int FROM inventory_movements) AS stock")).rows[0];
}
async function reviseNumber(original: SupplierInvoiceRevision, next: SupplierInvoiceRevision, who: Who = "manager") {
  return asOperation(who, "inventory.supplier-invoices.record", (c, actor, principal) =>
    createSupplierInvoiceFinanceService({ resolvePrincipal: async () => principal }).revise(c, actor, key(), { ...expectation(original), document: next }));
}

describe("canonical operational supplier transport", () => {
  it("current grant holder reads source status and posts/cancels canonical debt without duplicate stock", async () => {
    const i = await fixture(), before = await counts(), intent = await intentFor(i);
    const a = await admit("manager", intent);
    expect(await counts()).toEqual(before);
    const result = await execute("manager", a);
    expect(result).toMatchObject({ status: "committed", result: { status: "posted", replayed: false } });
    expect(await execute("manager", a)).toMatchObject({ status: "committed", result: { replayed: true } });
    const view = await read("manager", i.orderId);
    expect(view.invoices[0]).toMatchObject({ status: "posted", canPost: false, canCancel: true, settledMinor: 0 });
    expect(view.invoices[0].payableId).toBe(result.result?.payableId);
    await execute("manager", await admit("manager", await intentFor(i, "cancel")));
    expect((await read("manager", i.orderId)).invoices[0]).toMatchObject({ status: "cancelled", effectiveMinor: 0, canCancel: false });
    const after = await counts();
    expect(after.stock).toBe(before.stock);
    expect(after.cash).toBe(before.cash);
    expect(after.debt).toBe(before.debt + 1);
    expect(after.adjustments).toBe(before.adjustments + 1);
  });
  it("lost admission reply returns the exact server key; concurrent nonce replay creates one admission", async () => {
    const i = await fixture(), intent = await intentFor(i);
    const [a, b] = await Promise.all([admit("manager", intent), admit("manager", intent)]);
    expect(b).toEqual(a);
    expect(a.envelope.operationKey).not.toBe(intent.nonce);
    await expect(attempt("manager", { ...intent, input: { ...intent.input, reason: "Different payload" } })).rejects.toMatchObject({ code: "idempotency_conflict" });
    const before = await counts();
    await Promise.all([execute("manager", a), execute("manager", b)]);
    expect((await counts()).debt).toBe(before.debt + 1);
  });
  it("revocation is rechecked before committed replay as well as mutation", async () => {
    const i = await fixture(), a = await admit("manager", await intentFor(i));
    await execute("manager", a);
    const live = await fx.session("manager");
    await pool().query("UPDATE users SET is_active=FALSE WHERE id=$1", [fx.ids.manager]);
    try {
      await expect(transport.executeSupplierIntentCanonical(live, a)).rejects.toThrow(/^STAFF_OPERATION_/);
    } finally { await pool().query("UPDATE users SET is_active=TRUE WHERE id=$1", [fx.ids.manager]); }
    // The reactivation is a new account epoch: only a fresh session proves again.
    await expect(transport.executeSupplierIntentCanonical(live, a)).rejects.toThrow(/^STAFF_OPERATION_/);
    expect(await execute("manager", a)).toMatchObject({ status: "committed", result: { replayed: true } });
  });
  it("legacy sessions are refused outright; missing grants and malformed documents never gain supplier management", async () => {
    const i = await fixture();
    const legacy: SessionPayload = { userId: fx.ids.manager, username: ACCOUNTS.manager.username, role: "admin", expiresAt: Date.now() + 60_000, credentialVersion: "x" };
    await expect(transport.admitSupplierIntent(legacy, await intentFor(i))).rejects.toMatchObject({ code: "supplier_canonical_identity_required" });
    await expect(transport.readSupplierFinance(legacy, i.orderId)).rejects.toMatchObject({ code: "supplier_canonical_identity_required" });
    await expect(attempt("requester", await intentFor(i, "post", "requester"))).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    await expect(read("requester", i.orderId)).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    // Recording does not imply cancellation: cancel is separately governed.
    await execute("recorder", await admit("recorder", await intentFor(i, "post", "recorder")));
    await expect(attempt("recorder", await intentFor(i, "cancel", "recorder"))).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    const stale = await fx.session("manager");
    await pool().query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify({ schemaVersion: 1 }), fx.ids.manager]);
    try {
      await expect(transport.admitSupplierIntentCanonical(stale, await intentFor(i))).rejects.toThrow(/^STAFF_OPERATION_/);
    } finally { await fx.setGrants("manager", MANAGER_GRANTS); }
  });
  it("an intent naming another realm, subject or generation is never admitted or executed", async () => {
    const i = await fixture(), intent = await intentFor(i), a = await admit("manager", intent);
    for (const authority of [{ ...intent.authority, realmId: key() }, { ...intent.authority, subjectId: key() }]) {
      await expect(attempt("manager", { ...intent, nonce: key(), authority })).rejects.toMatchObject({ code: "supplier_saved_authority_mismatch" });
    }
    // A different generation for an absent nonce is a held earlier-generation intent, never a new key.
    await expect(attempt("manager", { ...intent, nonce: key(), authority: { ...intent.authority, executionEpochId: key() } })).rejects.toMatchObject({ code: "supplier_saved_authority_mismatch" });
    // A forged envelope generation fails the envelope digest, before any domain work...
    const forged = { ...a.envelope, authority: { ...a.envelope.authority, executionEpochId: key() } };
    await expect(execute("manager", { ...a, envelope: forged })).rejects.toMatchObject({ code: "idempotency_conflict" });
    // ...and a self-consistent forgery has no saved server admission.
    const { createHash } = await import("node:crypto");
    const { inventoryRecoveryIdentity } = await import("../../lib/inventory-command-recovery");
    await expect(execute("manager", { envelope: forged, digest: createHash("sha256").update(inventoryRecoveryIdentity(forged)).digest("hex") })).rejects.toMatchObject({ code: "command_provenance_required" });
    expect(await admit("manager", intent)).toEqual(a);
    expect((await read("manager", i.orderId)).invoices[0].status).toBe("unposted");
  });
  it("audit failure rolls back financial effects while durable admission survives", async () => {
    const i = await fixture(), a = await admit("manager", await intentFor(i)), before = await counts();
    await pool().query("CREATE FUNCTION synthetic_supplier_audit_refusal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity='supplier_invoice' THEN RAISE EXCEPTION 'synthetic audit refusal'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_supplier_audit_refusal BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_supplier_audit_refusal()");
    try {
      await expect(execute("manager", a)).rejects.toThrow();
      expect(await counts()).toEqual(before);
    } finally { await pool().query("DROP TRIGGER synthetic_supplier_audit_refusal ON audit_log; DROP FUNCTION synthetic_supplier_audit_refusal()"); }
    expect(await attempt("manager", await intentFor(i))).toMatchObject({ status: "rejected" });
    await execute("manager", a);
    expect((await counts()).debt).toBe(before.debt + 1);
  });
  it("retirement cannot cancel committed success; unexecuted retired commands are fenced", async () => {
    const i = await fixture(), a = await admit("manager", await intentFor(i));
    const stopped = await execute("manager", a, "Synthetic explicit stop before execution");
    expect(stopped.status).toBe("retired");
    expect(await execute("manager", a)).toMatchObject({ status: "retired", digest: a.digest });
    const b = await admit("manager", await intentFor(i));
    await execute("manager", b);
    expect(await execute("manager", b, "Synthetic lost reply stop request")).toMatchObject({ status: "committed", result: { replayed: true } });
  });
  it("preposting revision is visible and its exact digest is required for posting", async () => {
    const i = await fixture(), revision = { ...i, version: 2 };
    const intent = await intentFor(i, "revise");
    intent.input.document = revision;
    await execute("manager", await admit("manager", intent));
    expect((await read("manager", i.orderId)).invoices[0].version).toBe(2);
    const stale = await admit("manager", await intentFor(i));
    await expect(execute("manager", stale)).rejects.toMatchObject({ code: "stale_version" });
    await execute("manager", stale, "Explicitly retire stale preview before revised intent");
    await execute("manager", await admit("manager", await intentFor(revision)));
  });
  it("admission envelope edits and cross-actor use cannot replay or mutate", async () => {
    const i = await fixture(), a = await admit("manager", await intentFor(i)), before = await counts();
    await expect(execute("manager", { ...a, envelope: { ...a.envelope, input: { ...a.envelope.input, reason: "Tampered reason" } } })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(execute("other", a)).rejects.toMatchObject({ code: "supplier_saved_authority_mismatch" });
    expect(await counts()).toEqual(before);
  });
  it("a fresh session after re-login recovers committed and retired acknowledgements exactly", async () => {
    const committed = await admit("manager", await intentFor(await fixture()));
    const result = await execute("manager", committed);
    const retired = await admit("manager", await intentFor(await fixture()));
    await execute("manager", retired, "Explicit synthetic stop");
    // A permission revision invalidates every earlier token; the same subject signs in again.
    await fx.setGrants("manager", MANAGER_GRANTS);
    const { operationKey: _key, actorUserId: _actor, username: _name, ...original } = committed.envelope;
    const recovered = await admit("manager", original);
    expect(recovered).toEqual(committed);
    const replay = await execute("manager", recovered);
    expect(replay.status).toBe("committed");
    expect(replay.result).toMatchObject({ ...result.result!, replayed: true });
    expect(await execute("manager", retired)).toMatchObject({ status: "retired", reason: "Explicit synthetic stop", digest: retired.digest });
  });
  it("deactivation committed by an exclusive authority writer ahead of execution refuses pending work", async () => {
    const f = await fixture(), a = await admit("manager", await intentFor(f)), live = await fx.session("manager");
    const c = await fx.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
      await c.query("UPDATE users SET is_active=FALSE WHERE id=$1", [fx.ids.manager]);
      const result = transport.executeSupplierIntentCanonical(live, a).then(() => ({ message: "unexpected_success" }), (e: Error) => e);
      await new Promise(resolve => setTimeout(resolve, 50));
      await c.query("COMMIT");
      expect((await result).message).toMatch(/^STAFF_OPERATION_/);
      expect((await pool().query("SELECT 1 FROM supplier_invoice_payable_links WHERE invoice_id=$1", [f.id])).rowCount).toBe(0);
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
      await pool().query("UPDATE users SET is_active=TRUE WHERE id=$1", [fx.ids.manager]);
    }
  });
  it("canonical subject, realm and generation identity cannot mutate", async () => {
    await expect(pool().query("UPDATE staff_identity_current SET subject_id=gen_random_uuid() WHERE user_id=$1", [fx.ids.manager])).rejects.toThrow();
    await expect(pool().query("UPDATE staff_identity_state SET realm_id=gen_random_uuid() WHERE singleton")).rejects.toThrow();
    await expect(pool().query("DELETE FROM staff_identity_generations")).rejects.toThrow();
    await expect(pool().query("UPDATE staff_identity_subjects SET realm_id=gen_random_uuid()")).rejects.toThrow();
  });
  it("durably rejects another nonce for a pending invoice and recovers a lost refusal unchanged", async () => {
    const f = await fixture(), a = await admit("manager", await intentFor(f)), other = await intentFor(f), before = await counts();
    const refused = await attempt("manager", other);
    expect(refused).toMatchObject({ status: "rejected", intent: other, code: "supplier_invoice_intent_pending" });
    expect(await attempt("manager", other)).toEqual(refused);
    expect(await counts()).toEqual(before);
    await expect(attempt("manager", { ...other, input: { ...other.input, reason: "Changed rejected reason" } })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await execute("manager", a);
    expect(await attempt("manager", other)).toEqual(refused);
    expect((await pool().query("SELECT 1 FROM inventory_supplier_intents WHERE intent_nonce=$1", [other.nonce])).rowCount).toBe(0);
    await expect(pool().query("UPDATE inventory_supplier_intent_rejections SET reason='changed' WHERE intent_nonce=$1", [other.nonce])).rejects.toMatchObject({ code: "P0001" });
  });
  it("simultaneous different actors receive only one pending admission for the same invoice", async () => {
    const f = await fixture();
    const intents = [await intentFor(f), await intentFor(f, "post", "other")];
    const outcomes = await Promise.all([attempt("manager", intents[0]), attempt("other", intents[1])]);
    expect(outcomes.filter(x => "status" in x)).toHaveLength(1);
    expect(outcomes.filter(x => !("status" in x))).toHaveLength(1);
  });
  it("another actor's pending invoice blocks a new nonce but permits an independent invoice", async () => {
    const f = await fixture(), held = await admit("other", await intentFor(f, "post", "other"));
    expect(await attempt("manager", await intentFor(f))).toMatchObject({ status: "rejected", code: "supplier_invoice_intent_pending" });
    await expect(execute("manager", held)).rejects.toMatchObject({ code: "supplier_saved_authority_mismatch" });
    expect(await admit("manager", await intentFor(await fixture()))).toHaveProperty("envelope.operationKey");
  });
  it("admission waits for exact in-flight original lock before deciding absence", async () => {
    const f = await fixture(), a = await admit("manager", await intentFor(f)), second = await intentFor(f);
    let pending: Promise<unknown> | undefined;
    await asOperation("manager", "inventory.supplier-invoices.record", async (c, actor, principal) => {
      const scope = supplierFinanceCommandScope(principal, "post");
      await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('inventory-purchase-reset-v1',0))");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([scope, actor.userId, a.envelope.operationKey])]);
      let finished = false;
      pending = attempt("manager", second).finally(() => { finished = true; });
      let waiting = false;
      for (let n = 0; n < 200; n++) {
        waiting = (await fx.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock%' AND pid<>pg_backend_pid()) AS waiting")).rows[0].waiting;
        if (waiting) break;
        await new Promise(r => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
      expect(finished).toBe(false);
      await createSupplierInvoiceFinanceService({ resolvePrincipal: async () => principal, admitted: true }).post(c, actor, a.envelope.operationKey, a.envelope.input);
    });
    expect(await pending).toHaveProperty("envelope.operationKey");
  });
  it("failed rejection audit leaves no terminal proof and retries safely", async () => {
    const f = await fixture();
    await admit("manager", await intentFor(f));
    const other = await intentFor(f);
    await pool().query("CREATE FUNCTION synthetic_supplier_rejection_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity='supplier_intent' THEN RAISE EXCEPTION 'synthetic rejection audit refusal'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_supplier_rejection_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_supplier_rejection_audit()");
    try {
      await expect(attempt("manager", other)).rejects.toThrow("synthetic rejection audit refusal");
      expect((await pool().query("SELECT 1 FROM inventory_supplier_intent_rejections WHERE intent_nonce=$1", [other.nonce])).rowCount).toBe(0);
    } finally { await pool().query("DROP TRIGGER synthetic_supplier_rejection_audit ON audit_log; DROP FUNCTION synthetic_supplier_rejection_audit()"); }
    expect(await attempt("manager", other)).toMatchObject({ status: "rejected" });
  });
  it("rejects uppercase UUID lock aliases without rewriting original nonce or invoice identity", async () => {
    const f = await fixture(), intent = await intentFor(f);
    await expect(attempt("manager", { ...intent, nonce: intent.nonce.toUpperCase() })).rejects.toMatchObject({ code: "invalid_document" });
    await expect(attempt("manager", { ...intent, input: { ...intent.input, invoiceId: f.id.toUpperCase() } })).rejects.toMatchObject({ code: "invalid_document" });
    const admitted = await admit("manager", intent);
    expect(admitted.envelope.nonce).toBe(intent.nonce);
    expect(await admit("manager", intent)).toEqual(admitted);
  });
  it("completes an originally missing official number with immutable lineage and exact replay", async () => {
    const original = await fixture("SAR", false, { missingNumber: true }), before = await counts();
    const next = { ...original, version: 2, invoiceNumber: "  ａｂＣ　12  ", missingNumberReason: null };
    const intent = await intentFor(original, "revise");
    intent.input.document = next;
    const a = await admit("manager", intent);
    const result = await execute("manager", a);
    expect(result.result).toMatchObject({ version: 2, status: "matched", payableEffects: 0 });
    expect(await execute("manager", a)).toMatchObject({ status: "committed", result: { replayed: true, version: 2 } });
    expect((await pool().query("SELECT document FROM supplier_invoices WHERE id=$1", [original.id])).rows[0].document).toEqual(original);
    const claim = (await pool().query("SELECT c.*,c.created_at=r.created_at AS exact_time,c.document=r.document AS exact_document FROM supplier_invoice_number_claims c JOIN supplier_invoice_revisions r ON r.invoice_id=c.invoice_id AND r.version=c.first_version WHERE c.invoice_id=$1", [original.id])).rows[0];
    expect(claim).toMatchObject({ first_version: 2, exact_time: true, exact_document: true });
    expect(claim.duplicate_key).toContain("ABC 12");
    expect(await counts()).toEqual(before);
    const dated = { ...next, version: 3, invoiceDate: "2026-11-02", invoiceNumber: "ABC 12" };
    const revision = await intentFor(next, "revise");
    revision.input.document = dated;
    await execute("manager", await admit("manager", revision));
    await execute("manager", await admit("manager", await intentFor(dated)));
    expect((await counts()).debt).toBe(before.debt + 1);
    expect((await pool().query("SELECT first_version,document FROM supplier_invoice_number_claims WHERE invoice_id=$1", [original.id])).rows[0]).toMatchObject({ first_version: 2, document: next });
  });
  it("known numbers cannot be removed, renamed or moved to another supplier year/currency", async () => {
    const original = await fixture();
    for (const patch of [{ invoiceNumber: null, missingNumberReason: "Cannot erase official number" }, { invoiceNumber: "DIFFERENT" }, { invoiceDate: "2027-10-26" }, { currency: "USD" as const }, { supplierPartyId: original.supplierPartyId + 1 }]) {
      await expect(reviseNumber(original, { ...original, version: 2, ...patch })).rejects.toMatchObject({ code: "invoice_identity_mismatch" });
    }
    expect((await pool().query("SELECT COUNT(*)::int AS n FROM supplier_invoice_number_claims WHERE invoice_id=$1", [original.id])).rows[0].n).toBe(1);
  });
  it("invoice match and official-number revision race on the same Unicode-normalized source claim", async () => {
    const f = await fixture("SAR", false, { missingNumber: true }), number = `ＲＡＣＥ　 ${key()}`;
    const g = await fixture("SAR", false, { supplierId: f.supplierPartyId, number: number.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase(), skipMatch: true });
    const next = { ...f, version: 2, invoiceNumber: number, missingNumberReason: null }, before = await counts();
    const matcher = await fx.session("other");
    const outcomes = await Promise.allSettled([reviseNumber(f, next), runCanonicalProcurementCommand(matcher, key(), { command: "invoice.match", document: g })]);
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(r => r.status === "rejected")).toHaveLength(1);
    expect((await pool().query("SELECT invoice_id FROM supplier_invoice_number_claims WHERE invoice_id=ANY($1::uuid[])", [[f.id, g.id]])).rows).toHaveLength(1);
    expect(await counts()).toEqual(before);
  });
  it("two actors completing the same supplier number on different orders produce one claim", async () => {
    const f = await fixture("SAR", false, { missingNumber: true }), g = await fixture("SAR", false, { missingNumber: true, supplierId: f.supplierPartyId });
    const number = `SOURCE-${key()}`;
    const results = await Promise.allSettled([
      reviseNumber(f, { ...f, version: 2, invoiceNumber: number, missingNumberReason: null }),
      reviseNumber(g, { ...g, version: 2, invoiceNumber: number.toLowerCase(), missingNumberReason: null }, "other"),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect((await pool().query("SELECT COUNT(*)::int AS n FROM supplier_invoice_number_claims WHERE invoice_id=ANY($1::uuid[])", [[f.id, g.id]])).rows[0].n).toBe(1);
  });
  it("number-completion audit failure rolls back its claim and permits exact retry", async () => {
    const f = await fixture("SAR", false, { missingNumber: true }), next = { ...f, version: 2, invoiceNumber: `AUDIT-${key()}`, missingNumberReason: null }, intent = await intentFor(f, "revise");
    intent.input.document = next;
    const a = await admit("manager", intent);
    await pool().query("CREATE FUNCTION synthetic_number_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity='supplier_invoice' THEN RAISE EXCEPTION 'synthetic number audit refusal'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_number_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_number_audit()");
    try {
      await expect(execute("manager", a)).rejects.toThrow("synthetic number audit refusal");
      expect((await pool().query("SELECT 1 FROM supplier_invoice_number_claims WHERE invoice_id=$1", [f.id])).rowCount).toBe(0);
    } finally { await pool().query("DROP TRIGGER synthetic_number_audit ON audit_log; DROP FUNCTION synthetic_number_audit()"); }
    expect(await execute("manager", a)).toMatchObject({ status: "committed", result: { version: 2 } });
  });
  it("completion remains closed without the explicit number-claim proposal", async () => {
    const f = await fixture("SAR", false, { missingNumber: true });
    await asOperation("manager", "inventory.supplier-invoices.record", async (c, actor, principal) => {
      await c.query("SAVEPOINT synthetic_uninstalled");
      try {
        await c.query("DROP TABLE supplier_invoice_number_claims CASCADE");
        await expect(createSupplierInvoiceFinanceService({ resolvePrincipal: async () => principal }).revise(c, actor, key(), {
          ...expectation(f), document: { ...f, version: 2, invoiceNumber: "UNINSTALLED", missingNumberReason: null } })).rejects.toMatchObject({ code: "schema_not_ready" });
      } finally { await c.query("ROLLBACK TO SAVEPOINT synthetic_uninstalled"); }
    });
    expect((await pool().query("SELECT to_regclass('supplier_invoice_number_claims') IS NOT NULL AS present")).rows[0].present).toBe(true);
  });
  it("conflicting historical number backfill aborts without a partial registry or altered source", async () => {
    const f = await fixture("SAR", false, { missingNumber: true }), g = await fixture("SAR", false, { missingNumber: true, supplierId: f.supplierPartyId });
    const realmId = (await authorityOf("manager")).realmId;
    const before = (await pool().query("SELECT count(*)::int AS n FROM supplier_invoice_number_claims")).rows[0].n;
    const c = await fx.pool.connect(), number = `BACKFILL-${key()}`;
    try {
      await c.query("BEGIN");
      await c.query("DROP TRIGGER inventory_supplier_number_claim ON supplier_invoice_revisions; DROP TABLE supplier_invoice_number_claims CASCADE");
      for (const original of [f, g]) {
        const plan = (await c.query("SELECT match_plan FROM supplier_invoices WHERE id=$1", [original.id])).rows[0].match_plan;
        await c.query("INSERT INTO supplier_invoice_finance_roots(invoice_id,realm_id) VALUES($1,$2)", [original.id, realmId]);
        await c.query("INSERT INTO supplier_invoice_revisions(invoice_id,version,document,match_plan,reason,created_by) VALUES($1,1,$2::jsonb,$3::jsonb,'Synthetic original',$4)", [original.id, JSON.stringify(original), JSON.stringify(plan), fx.ids.manager]);
        const next = { ...original, version: 2, invoiceNumber: number, missingNumberReason: null };
        const matched = { ...plan, invoiceVersion: 2, identity: payloadIdentity(next), duplicateKey: supplierInvoiceDuplicateKey(original.supplierPartyId, number, original.invoiceDate, null), status: "matched", issues: [] };
        await c.query("INSERT INTO supplier_invoice_revisions(invoice_id,version,document,match_plan,reason,created_by) VALUES($1,2,$2::jsonb,$3::jsonb,'Synthetic historical conflict',$4)", [original.id, JSON.stringify(next), JSON.stringify(matched), fx.ids.manager]);
      }
      await expect(c.query(INVENTORY_SUPPLIER_NUMBER_SQL)).rejects.toMatchObject({ code: "23505" });
    } finally { await c.query("ROLLBACK"); c.release(); }
    expect((await pool().query("SELECT count(*)::int AS n FROM supplier_invoice_number_claims")).rows[0].n).toBe(before);
    expect((await pool().query("SELECT 1 FROM supplier_invoice_revisions WHERE invoice_id=ANY($1::uuid[])", [[f.id, g.id]])).rowCount).toBe(0);
  });
  it("preserves a positive initial version in deterministic number-source reconstruction", async () => {
    const f = await fixture("SAR", false, { skipMatch: true }), initial = { ...f, version: 2 };
    await command("manager", { command: "invoice.match", document: initial });
    const claim = (await pool().query("SELECT * FROM supplier_invoice_number_claims WHERE invoice_id=$1", [initial.id])).rows[0];
    expect(claim.first_version).toBe(2);
    await pool().query(INVENTORY_SUPPLIER_NUMBER_SQL);
    expect((await pool().query("SELECT * FROM supplier_invoice_number_claims WHERE invoice_id=$1", [initial.id])).rows[0]).toEqual(claim);
    expect((await pool().query("SELECT * FROM inventory_supplier_number_sources WHERE invoice_id=$1", [initial.id])).rows[0]).toEqual(claim);
  });
});
