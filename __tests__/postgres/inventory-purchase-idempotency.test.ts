import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import type { SessionPayload } from "../../lib/auth";
import { readPurchaseAcknowledgment } from "../../lib/inventory-purchase-command";
import { canonicalPurchaseRequest } from "../../lib/inventory-purchase-protocol";
import { purchaseTestSession } from "./_inventory-purchase-session";
import { validatePostgresTestTarget } from "./_safe-target";
import { dropPublicSchema, stubPostgresEnv } from "./_setup";

// Validate the original environment before connecting or resetting anything.
// All rows, accounts and injected failures in this file are synthetic.
const target = validatePostgresTestTarget(process.env);
stubPostgresEnv();
const auth = vi.hoisted(() => ({ session: null as SessionPayload | null }));
vi.mock("@/lib/session", async importOriginal => ({
  ...await importOriginal<typeof import("../../lib/session")>(),
  requireSession: async () => auth.session,
}));
const db = await import("../../lib/db");
const { POST } = await import("../../app/api/inventory/[id]/movements/route");
let serial = 0;
beforeAll(async () => { await dropPublicSchema(target.testUrl.toString()); await db.ensureSchema(); });
beforeEach(async () => { auth.session = await purchaseTestSession(`synthetic-retry-${++serial}`, "admin"); });
afterAll(async () => { await db.resetPoolForTesting(); });

async function fixture() {
  const { rows: [item] } = await db.getPool().query<{ id: number }>(
    "INSERT INTO inventory_items(name,created_by) VALUES ($1,'synthetic') RETURNING id", [`Synthetic retry ${serial}`]);
  const { rows: [supplier] } = await db.getPool().query<{ id: number }>(
    "INSERT INTO parties(name,kind) VALUES ($1,'supplier') RETURNING id", [`Synthetic retry ${serial}`]);
  return { itemId: item.id, supplierId: supplier.id, actor: auth.session!, key: randomUUID(),
    purchase: { kind: "in", qty: 2, unitCost: "100", supplierPartyId: supplier.id } as Record<string, unknown> };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function state(f: Fixture) {
  const { rows: movements } = await db.getPool().query("SELECT * FROM inventory_movements WHERE item_id=$1 ORDER BY id", [f.itemId]);
  const { rows: payables } = await db.getPool().query("SELECT * FROM payables WHERE party_id=$1 ORDER BY id", [f.supplierId]);
  const { rows: audit } = await db.getPool().query("SELECT * FROM audit_log WHERE action='inventory.move' AND actor=$1 ORDER BY id", [f.actor.username]);
  const { rows: receipts } = await db.getPool().query("SELECT * FROM inventory_purchase_receipts WHERE actor_user_id=$1 ORDER BY request_key", [f.actor.userId]);
  const { rows: [stock] } = await db.getPool().query("SELECT COALESCE(SUM(CASE WHEN kind='out' THEN -qty ELSE qty END),0)::float AS balance FROM inventory_movements WHERE item_id=$1", [f.itemId]);
  return { movements, payables, audit, receipts, balance: stock.balance };
}
function request(f: Fixture, options: { purchase?: Record<string, unknown>; key?: string | null; actor?: string | null; actorId?: string | null; itemId?: number; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.key !== null) headers["Idempotency-Key"] = options.key ?? f.key;
  if (options.actor !== null) headers["X-Purchase-Actor"] = options.actor ?? auth.session?.username ?? f.actor.username;
  if (options.actorId !== null) headers["X-Purchase-Actor-Id"] = options.actorId ?? String(auth.session?.userId ?? f.actor.userId);
  const itemId = options.itemId ?? f.itemId;
  return POST(new Request(`http://test.invalid/api/inventory/${itemId}/movements`, {
    method: "POST", headers,
    body: JSON.stringify(options.body ?? { protocol: "inventory-purchase-v1", purchase: options.purchase ?? f.purchase }),
  }), { params: Promise.resolve({ id: String(itemId) }) });
}
async function acknowledged(f: Fixture, options: Parameters<typeof request>[1] = {}) {
  const response = await request(f, options);
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  const ack = await response.json();
  expect(ack).toMatchObject({ protocol: "inventory-purchase-v1", status: "committed", requestKey: options.key ?? f.key,
    itemId: options.itemId ?? f.itemId, actorUserId: auth.session!.userId, payableCreated: true, result: { ok: true } });
  expect(ack.requestDigest).toBe(createHash("sha256").update(canonicalPurchaseRequest(options.itemId ?? f.itemId, options.purchase ?? f.purchase)).digest("hex"));
  expect(ack.movementId).toBe(ack.result.movement.id);
  return ack;
}
async function failInsert(table: "audit_log" | "inventory_purchase_receipts", run: () => Promise<void>) {
  await db.getPool().query(`CREATE FUNCTION synthetic_reject_purchase_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic purchase insert failure'; END $$;
    CREATE TRIGGER synthetic_reject_purchase_insert BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION synthetic_reject_purchase_insert()`);
  try { await run(); }
  finally { await db.getPool().query(`DROP TRIGGER synthetic_reject_purchase_insert ON ${table}; DROP FUNCTION synthetic_reject_purchase_insert()`); }
}

describe("exactly-once keyed purchase effects", () => {
  it("replays sequential requests and a discarded committed response without creating financial effects again", async () => {
    const f = await fixture();
    const first = await acknowledged(f); const before = await state(f);
    // Treat first as a transport response the browser never received.
    const second = await acknowledged(f);
    expect(first.replayed).toBe(false); expect(second).toEqual({ ...first, replayed: true });
    expect(await state(f)).toEqual(before);
    expect(before.movements).toHaveLength(1); expect(before.payables).toHaveLength(1);
    expect(before.audit).toHaveLength(1); expect(before.receipts).toHaveLength(1); expect(before.balance).toBe(2);
    expect(before.payables[0]).toMatchObject({ amount_minor: "200", currency: "YER", base_currency: "YER" });
    expect(before.receipts[0]).toMatchObject({ outcome: "committed", request_key: f.key, actor_user_id: f.actor.userId, request_digest: first.requestDigest, movement_id: first.movementId });
    expect(before.receipts[0]).not.toHaveProperty("request_body");
  });
  it("serializes concurrent identical keys into one purchase and original-result replays", async () => {
    const f = await fixture();
    const acks = await Promise.all(Array.from({ length: 5 }, () => acknowledged(f)));
    expect(acks.filter(ack => !ack.replayed)).toHaveLength(1);
    const first = acks.find(ack => !ack.replayed)!;
    for (const ack of acks) expect({ ...ack, replayed: false }).toEqual(first);
    const saved = await state(f);
    expect(saved.movements).toHaveLength(1); expect(saved.payables).toHaveLength(1); expect(saved.audit).toHaveLength(1); expect(saved.receipts).toHaveLength(1); expect(saved.balance).toBe(2);
  });
  it("treats different keys as two legitimate purchases, including concurrent submissions", async () => {
    const f = await fixture();
    const acks = await Promise.all([acknowledged(f), acknowledged(f, { key: randomUUID() })]);
    expect(acks.every(ack => !ack.replayed)).toBe(true); expect(new Set(acks.map(a => a.movementId)).size).toBe(2);
    const saved = await state(f);
    expect(saved.movements).toHaveLength(2); expect(saved.payables).toHaveLength(2); expect(saved.audit).toHaveLength(2); expect(saved.receipts).toHaveLength(2); expect(saved.balance).toBe(4);
  });
  it("canonicalizes UUID spelling so differently cased keys cannot evade deduplication", async () => {
    const f = await fixture(); const first = await acknowledged(f);
    const response = await request(f, { key: f.key.toUpperCase() }); expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ...first, replayed: true });
    expect((await state(f)).movements).toHaveLength(1);
  });
  it("ignores JSON property ordering but preserves the exact original result", async () => {
    const f = await fixture(); const first = await acknowledged(f);
    const purchase = { supplierPartyId: f.supplierId, unitCost: "100", qty: 2, kind: "in" };
    expect(await acknowledged(f, { purchase })).toEqual({ ...first, replayed: true });
  });
  it.each([
    { qty: 3 }, { qty: "2" }, { unitCost: "100.0" }, { unitCost: "101" },
    { supplierPartyId: "same-as-string" }, { supplierDueDate: "2026-12-31" },
    { expiryDate: "2027-12-31" }, { reason: "Synthetic note" }, { reason: null },
    { reason: "" }, { expiryDate: null }, { isReturn: false },
  ])("conflicts on original field/type/presence change %j without rewriting", async change => {
    const f = await fixture(); await acknowledged(f); const before = await state(f);
    const patch = "supplierPartyId" in change && change.supplierPartyId === "same-as-string" ? { supplierPartyId: String(f.supplierId) } : change;
    const response = await request(f, { purchase: { ...f.purchase, ...patch } });
    expect(response.status).toBe(409); expect((await response.json()).status).not.toBe("committed");
    expect(await state(f)).toEqual(before);
  });
  it("conflicts on a different valid supplier rather than creating another liability", async () => {
    const f = await fixture(); await acknowledged(f); const before = await state(f);
    const other = await fixture();
    expect((await request(f, { purchase: { ...f.purchase, supplierPartyId: other.supplierId } })).status).toBe(409);
    expect(await state(f)).toEqual(before); expect((await state(other)).payables).toHaveLength(0);
  });
  it("binds keys to the route item and authenticated numeric actor without disclosure", async () => {
    const f = await fixture(); const original = await acknowledged(f); const before = await state(f);
    const another = await fixture();
    expect((await request(f, { itemId: another.itemId })).status).toBe(409);
    auth.session = await purchaseTestSession(`synthetic-other-${serial}`, "admin");
    const conflict = await request(f); expect(conflict.status).toBe(409);
    const payload = await conflict.json(); expect(payload).not.toHaveProperty("result"); expect(payload).not.toHaveProperty("movementId"); expect(payload).not.toHaveProperty("requestDigest", original.requestDigest);
    expect(await state(f)).toEqual(before); expect((await state(another)).movements).toHaveLength(0);
  });
  it("replays before mutable stock, supplier and item validation while retaining original balance", async () => {
    const f = await fixture(); const original = await acknowledged(f);
    expect((await db.createInventoryMovement({ itemId: f.itemId, kind: "out", qty: 1, createdBy: f.actor.username })).ok).toBe(true);
    await db.getPool().query("UPDATE parties SET is_active=false,name='Synthetic changed supplier' WHERE id=$1", [f.supplierId]);
    await db.getPool().query("UPDATE inventory_items SET is_active=false,name='Synthetic changed item' WHERE id=$1", [f.itemId]);
    const before = await state(f); expect(before.balance).toBe(1);
    expect(await acknowledged(f)).toEqual({ ...original, replayed: true }); expect(original.result.balance).toBe(2);
    expect(await state(f)).toEqual(before);
  });
  it.each(["audit_log", "inventory_purchase_receipts"] as const)("rolls back every effect if %s insertion fails, then safely retries the same key", async table => {
    const f = await fixture(); const before = await state(f);
    await failInsert(table, async () => {
      expect((await request(f)).status).toBe(500); expect(await state(f)).toEqual(before);
    });
    expect((await acknowledged(f)).replayed).toBe(false);
    const saved = await state(f); expect(saved.movements).toHaveLength(1); expect(saved.payables).toHaveLength(1); expect(saved.audit).toHaveLength(1); expect(saved.receipts).toHaveLength(1);
  });
  it("rolls back a terminated connection before commit and safely retries its unchanged key", async () => {
    const f = await fixture(); const before = await state(f);
    await db.getPool().query(`CREATE FUNCTION synthetic_interrupt_purchase_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_terminate_backend(pg_backend_pid()); RETURN NEW; END $$;
      CREATE TRIGGER synthetic_interrupt_purchase_commit BEFORE INSERT ON inventory_purchase_receipts FOR EACH ROW EXECUTE FUNCTION synthetic_interrupt_purchase_commit()`);
    // pg emits a client error in addition to rejecting the in-flight query when
    // this fixture kills its backend. Observe and assert only that induced event;
    // without a listener EventEmitter would turn the deliberate crash into an
    // unrelated uncaught test-process exception after our HTTP500 assertion.
    const pool = db.getPool() as unknown as Pool;
    const observedClients = new Set<PoolClient>();
    let resolveLoss!: (error: Error) => void;
    const connectionLoss = new Promise<Error>(resolve => { resolveLoss = resolve; });
    const onError = (error: Error) => { resolveLoss(error); };
    const onAcquire = (client: PoolClient) => {
      if (!observedClients.has(client)) { observedClients.add(client); client.once("error", onError); }
    };
    pool.on("acquire", onAcquire);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      expect((await request(f)).status).toBe(500);
      const error = await Promise.race([connectionLoss, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Expected synthetic connection-loss event was not emitted")), 5000);
      })]);
      expect(error.message).toBe("Connection terminated unexpectedly");
      pool.off("acquire", onAcquire);
      expect(await state(f)).toEqual(before);
    } finally {
      if (timeout) clearTimeout(timeout);
      pool.off("acquire", onAcquire);
      for (const client of observedClients) client.off("error", onError);
      await db.getPool().query("DROP TRIGGER synthetic_interrupt_purchase_commit ON inventory_purchase_receipts; DROP FUNCTION synthetic_interrupt_purchase_commit()");
    }
    expect((await acknowledged(f)).replayed).toBe(false);
    const saved = await state(f); expect(saved.movements).toHaveLength(1); expect(saved.payables).toHaveLength(1); expect(saved.audit).toHaveLength(1); expect(saved.receipts).toHaveLength(1);
  });
  it("fails closed if the durable receipt relation is unavailable", async () => {
    const f = await fixture(); const before = await state(f);
    await db.getPool().query("ALTER TABLE inventory_purchase_receipts RENAME TO synthetic_unavailable_purchase_receipts");
    try { expect((await request(f)).status).toBe(500); }
    finally { await db.getPool().query("ALTER TABLE synthetic_unavailable_purchase_receipts RENAME TO inventory_purchase_receipts"); }
    expect(await state(f)).toEqual(before);
    expect((await acknowledged(f)).replayed).toBe(false);
  });
  it("protects a stock-only keyed purchase without inventing a supplier liability", async () => {
    const f = await fixture(); f.purchase = { kind: "in", qty: 2 };
    const firstResponse = await request(f); expect(firstResponse.status).toBe(201); const first = await firstResponse.json();
    const replay = await (await request(f)).json();
    expect(first).toMatchObject({ status: "committed", payableCreated: false, replayed: false });
    expect(replay).toEqual({ ...first, replayed: true });
    const saved = await state(f); expect(saved.movements).toHaveLength(1); expect(saved.payables).toHaveLength(0); expect(saved.audit).toHaveLength(1); expect(saved.receipts).toHaveLength(1);
  });
  it("preserves calendar expiry and normalized long Unicode reason in a browser-valid acknowledgment, including Asia/Aden", async () => {
    const f = await fixture(); f.purchase = { ...f.purchase, expiryDate: "2027-12-31", reason: ` ${"a".repeat(299)}😀 trailing ` };
    const first = await acknowledged(f); const replay = await acknowledged(f);
    expect(first.result.movement.expiryDate).toBe("2027-12-31");
    expect(replay).toEqual({ ...first, replayed: true });
    const command = { actor: f.actor.username, actorUserId: f.actor.userId, itemId: f.itemId, key: f.key,
      body: JSON.stringify({ protocol: "inventory-purchase-v1", purchase: f.purchase }), digest: first.requestDigest };
    expect(readPurchaseAcknowledgment(first, command)).toMatchObject({ status: "committed", balance: 2 });
    expect(readPurchaseAcknowledgment(replay, command)).toMatchObject({ status: "committed", replayed: true });
    const { rows: [stored] } = await db.getPool().query("SELECT expiry_date::text AS expiry FROM inventory_movements WHERE id=$1", [first.movementId]);
    expect(stored.expiry).toBe("2027-12-31");
  });
  it("projects reception acknowledgments and replays without admin-only money/supplier fields", async () => {
    auth.session = await purchaseTestSession(`synthetic-reception-${serial}`, "reception");
    const f = await fixture(); const first = await acknowledged(f); const second = await acknowledged(f);
    expect(second).toEqual({ ...first, replayed: true });
    for (const result of [first, second]) {
      expect(result.payableCreated).toBe(true);
      for (const field of ["unitCostMinor", "partyId", "payableId", "cost", "supplierPartyId"]) expect(result.result.movement).not.toHaveProperty(field);
    }
    const saved = await state(f); expect(saved.receipts[0].result_snapshot.movement.payableId).toBe(saved.payables[0].id);
  });
});

describe("trusted authorization on every new attempt and replay", () => {
  it.each(["inactive", "role-changed", "credential-changed", "expired", "numeric-identity-changed"] as const)("refuses %s after an earlier commit without returning its result", async mode => {
    const f = await fixture(); await acknowledged(f); const before = await state(f);
    if (mode === "inactive") await db.getPool().query("UPDATE users SET is_active=false WHERE id=$1", [f.actor.userId]);
    if (mode === "role-changed") await db.getPool().query("UPDATE users SET role='doctor' WHERE id=$1", [f.actor.userId]);
    if (mode === "credential-changed") await db.getPool().query("UPDATE users SET password_hash='synthetic-revoked' WHERE id=$1", [f.actor.userId]);
    if (mode === "expired") auth.session = { ...f.actor, expiresAt: Date.now() - 1 };
    if (mode === "numeric-identity-changed") auth.session = { ...f.actor, userId: f.actor.userId + 10000 };
    const response = await request(f); expect([401, 403]).toContain(response.status);
    const payload = await response.json(); expect(payload).not.toHaveProperty("result"); expect(payload.status).not.toBe("rejected");
    expect(await state(f)).toEqual(before);
  });
  it("a valid renewed session after losing inventory permission cannot replay", async () => {
    const f = await fixture(); await acknowledged(f); const before = await state(f);
    auth.session = await purchaseTestSession(f.actor.username, "doctor");
    expect((await request(f)).status).toBe(403); expect(await state(f)).toEqual(before);
  });
  it.each([null, "99999999"])("requires matching numeric actor expectation %s before write", async actorId => {
    const f = await fixture(); const before = await state(f);
    const response = await request(f, { actorId }); expect(response.status).toBe(409);
    expect((await response.json()).status).not.toBe("rejected"); expect(await state(f)).toEqual(before);
  });
  it.each([null, "another-principal"])("requires matching actor expectation header %s before write", async actor => {
    const f = await fixture(); const before = await state(f);
    const response = await request(f, { actor }); expect([400, 401, 403, 409]).toContain(response.status);
    const payload = await response.json(); expect(payload.status).not.toBe("rejected"); expect(await state(f)).toEqual(before);
  });
});

describe("durable terminal refusal versus unknown transport outcome", () => {
  it.each([{ qty: 0 }, { qty: 1.2345 }, { unitCost: "not-money" }, { supplierPartyId: true }])("records and replays invalid original document %j without writes", async change => {
    const f = await fixture(); f.purchase = { ...f.purchase, ...change };
    const response = await request(f); expect([400, 409]).toContain(response.status); const rejection = await response.json();
    expect(rejection).toMatchObject({ protocol: "inventory-purchase-v1", status: "rejected", requestKey: f.key, itemId: f.itemId, replayed: false });
    expect(rejection.requestDigest).toBe(createHash("sha256").update(canonicalPurchaseRequest(f.itemId, f.purchase)).digest("hex"));
    const retries = await Promise.all([request(f), request(f)]);
    for (const retry of retries) { expect(retry.status).toBe(response.status); expect(await retry.json()).toEqual({ ...rejection, replayed: true }); }
    const saved = await state(f); expect(saved.movements).toHaveLength(0); expect(saved.payables).toHaveLength(0); expect(saved.audit).toHaveLength(0); expect(saved.receipts).toHaveLength(1); expect(saved.receipts[0]).toMatchObject({ outcome: "rejected", movement_id: null });
    expect((await request(f, { purchase: { kind: "in", qty: 2, unitCost: "100", supplierPartyId: f.supplierId } })).status).toBe(409);
    expect(await state(f)).toEqual(saved);
  });
  it.each([
    { qty: true }, { qty: [2] }, { qty: { value: 2 } },
    { unitCost: 100 }, { unitCost: true }, { unitCost: [100] }, { unitCost: { value: 100 } },
  ])("terminally rejects malformed keyed quantity/price types %j instead of coercing them", async change => {
    const f = await fixture(); f.purchase = { kind: "in", qty: 2, ...change };
    const response = await request(f); expect(response.status).toBe(400);
    const rejection = await response.json(); expect(rejection).toMatchObject({ status: "rejected", replayed: false });
    const replay = await request(f); expect(replay.status).toBe(400); expect(await replay.json()).toEqual({ ...rejection, replayed: true });
    const saved = await state(f); expect(saved.movements).toHaveLength(0); expect(saved.payables).toHaveLength(0); expect(saved.audit).toHaveLength(0); expect(saved.receipts).toHaveLength(1);
  });
  it("terminally rejects a normalized NUL reason instead of preserving an impossible retry", async () => {
    const f = await fixture(); f.purchase = { ...f.purchase, reason: "Synthetic\u0000note" };
    const response = await request(f); expect(response.status).toBe(400);
    const rejection = await response.json(); expect(rejection).toMatchObject({ status: "rejected", replayed: false });
    const replay = await request(f); expect(replay.status).toBe(400); expect(await replay.json()).toEqual({ ...rejection, replayed: true });
    const saved = await state(f); expect(saved.movements).toHaveLength(0); expect(saved.payables).toHaveLength(0); expect(saved.audit).toHaveLength(0); expect(saved.receipts).toHaveLength(1);
  });
  it("concurrent business refusal stays rejected permanently after its condition becomes valid", async () => {
    const f = await fixture(); await db.getPool().query("UPDATE parties SET is_active=false WHERE id=$1", [f.supplierId]);
    const rejected = await Promise.all([request(f), request(f), request(f)]);
    const acks = await Promise.all(rejected.map(response => response.json()));
    expect(rejected.every(response => response.status === 409)).toBe(true);
    expect(acks.filter(ack => !ack.replayed)).toHaveLength(1); expect(acks.every(ack => ack.status === "rejected")).toBe(true);
    await db.getPool().query("UPDATE parties SET is_active=true WHERE id=$1", [f.supplierId]);
    const delayed = await request(f); expect(delayed.status).toBe(409);
    expect(await delayed.json()).toEqual({ ...acks[0], replayed: true });
    const saved = await state(f); expect(saved.movements).toHaveLength(0); expect(saved.payables).toHaveLength(0); expect(saved.audit).toHaveLength(0); expect(saved.receipts).toHaveLength(1);
    // Correction is a new authorized purchase, never a replacement of the old key.
    expect((await acknowledged(f, { key: randomUUID() })).replayed).toBe(false);
  });
  it("authentication refusal never reserves or terminally rejects a purchase key", async () => {
    const f = await fixture(); auth.session = { ...f.actor, credentialVersion: "invalid" }; const before = await state(f);
    expect([401, 403]).toContain((await request(f)).status); expect(await state(f)).toEqual(before);
    auth.session = f.actor; expect((await acknowledged(f)).replayed).toBe(false);
  });
});

describe("rolling-deployment guard and unchanged excluded HTTP shapes", () => {
  it("rejects non-finite JSON numeric overflow as malformed without an unverifiable receipt", async () => {
    const f = await fixture(); const before = await state(f);
    const response = await POST(new Request(`http://test.invalid/api/inventory/${f.itemId}/movements`, {
      method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": f.key, "X-Purchase-Actor": f.actor.username, "X-Purchase-Actor-Id": String(f.actor.userId) },
      body: '{"protocol":"inventory-purchase-v1","purchase":{"kind":"in","qty":2,"unitCost":"100","supplierPartyId":1e309}}',
    }), { params: Promise.resolve({ id: String(f.itemId) }) });
    expect(response.status).toBe(400); expect((await response.json()).status).not.toBe("rejected"); expect(await state(f)).toEqual(before);
  });
  it.each([null, "", "not-a-uuid"])("refuses absent or malformed request key %s before financial writes", async key => {
    const f = await fixture(); const before = await state(f);
    expect((await request(f, { key })).status).toBe(400); expect(await state(f)).toEqual(before);
  });
  it.each([
    { protocol: "inventory-purchase-v2", purchase: { kind: "in", qty: 2 } },
    { protocol: "inventory-purchase-v1", kind: "in", purchase: { kind: "in", qty: 2 } },
    { protocol: "inventory-purchase-v1", purchase: { kind: "out", qty: 2 } },
    { protocol: "inventory-purchase-v1", purchase: { kind: "in", qty: 2, isReturn: true } },
    { protocol: "inventory-purchase-v1", purchase: { kind: "in", qty: 2, actorUserId: 1 } },
    { kind: "out", qty: 2 }, { kind: "adjust", qty: 2, reason: "Synthetic" }, { kind: "in", qty: 2 },
  ])("never silently ignores a key on unsupported body %j", async body => {
    const f = await fixture(); const before = await state(f);
    expect((await request(f, { body })).status).toBe(400); expect(await state(f)).toEqual(before);
  });
  it.each([{ unitCost: "100" }, { supplierPartyId: 1 }, { unitCost: 100 }, { supplierPartyId: true }])("rejects old unwrapped financial purchase %j without effects", async extra => {
    const f = await fixture(); const before = await state(f);
    const response = await request(f, { key: null, body: { kind: "in", qty: 2, ...extra } });
    expect([400, 409, 426]).toContain(response.status); expect(await state(f)).toEqual(before);
  });
  it("preserves unpriced opening stock, clinical outflow, adjustments and returns without receipts", async () => {
    const f = await fixture();
    for (const body of [{ kind: "in", qty: 3 }, { kind: "out", qty: 1 }, { kind: "adjust", qty: 1, reason: "Synthetic count" }, { kind: "in", qty: 1, isReturn: true }]) {
      const response = await request(f, { key: null, body }); expect(response.status).toBe(201);
      const result = await response.json(); expect(result.ok).toBe(true); expect(result).not.toHaveProperty("protocol");
    }
    const saved = await state(f); expect(saved.movements).toHaveLength(4); expect(saved.audit).toHaveLength(4); expect(saved.payables).toHaveLength(0); expect(saved.receipts).toHaveLength(0); expect(saved.balance).toBe(4);
  });
});
