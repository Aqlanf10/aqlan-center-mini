import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openInventoryPurchaseFixture } from "./_inventory-purchase-fixture";
import { purchaseTestSession } from "./_inventory-purchase-session";
import { createInventoryPurchase } from "../../lib/inventory-purchase-db";
import { ProtectedPurchaseHistoryError, RESET_KEEP_TABLES, RESET_WIPE_TABLES } from "../../lib/clinic-reset";

let fixture: Awaited<ReturnType<typeof openInventoryPurchaseFixture>>;
let serial = 0;
beforeEach(async () => { fixture = await openInventoryPurchaseFixture(); });
afterEach(async () => { await fixture?.close(); });
const q = (sql: string, values: unknown[] = []) => fixture.pool.query(sql, values);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function command() {
  const session = await purchaseTestSession(`synthetic-purchase-reset-${++serial}`, "admin");
  const { rows: [item] } = await q("INSERT INTO inventory_items(name,created_by) VALUES('Synthetic kept inventory',$1) RETURNING id", [session.username]);
  const { rows: [supplier] } = await q("INSERT INTO parties(name,kind) VALUES('Synthetic kept supplier','supplier') RETURNING id");
  return { session, requestKey: randomUUID(), itemId: item.id as number,
    purchase: { kind: "in", qty: 2, unitCost: "100", supplierPartyId: supplier.id },
    input: { itemId: item.id, kind: "in" as const, qty: 2, unitCostMinor: 100, supplierPartyId: supplier.id, createdBy: session.username } };
}
const resetInput = { actor: "synthetic-reset-owner", actorRole: "admin" };
async function preservedState() {
  const rows: Record<string, unknown> = {};
  for (const table of ["users", "parties", "inventory_items", "inventory_movements", "payables", "inventory_purchase_receipts", "audit_log"]) {
    const order = table === "inventory_purchase_receipts" ? "request_key" : "id";
    rows[table] = (await q(`SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY ${order}`)).rows;
  }
  return rows;
}
async function keptIdentities() {
  const rows: Record<string, unknown> = {};
  for (const table of ["users", "parties", "inventory_items"]) {
    rows[table] = (await q(`SELECT * FROM ${table} ORDER BY id`)).rows;
    rows[`${table}_sequence`] = (await q(`SELECT last_value,is_called FROM ${table}_id_seq`)).rows;
  }
  return rows;
}
async function waitForLock(mode: "ShareLock" | "ExclusiveLock", granted: boolean) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { rows: [row] } = await q(`SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND mode=$1 AND granted=$2`, [mode, granted]);
    if (row.n > 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Expected synthetic advisory ${mode} granted=${granted}`);
}

describe("permanent purchase receipts contain synthetic clinic reset", () => {
  it("classifies receipts as retained history, never a wipe target", () => {
    expect(RESET_KEEP_TABLES).toContain("inventory_purchase_receipts");
    expect(RESET_WIPE_TABLES).not.toContain("inventory_purchase_receipts");
  });

  it.each(["committed", "rejected"] as const)("refuses a %s key before backup or destructive work", async outcome => {
    const c = await command();
    if (outcome === "committed") expect((await createInventoryPurchase(c)).body).toMatchObject({ status: "committed" });
    else expect((await createInventoryPurchase({ session: c.session, requestKey: c.requestKey, itemId: c.itemId,
      purchase: c.purchase, rejection: { message: "Synthetic terminal refusal", httpStatus: 409 } })).body).toMatchObject({ status: "rejected" });
    const before = await preservedState();
    const backup = vi.fn(async () => ({ ok: true as const, backupId: "must-not-run" }));
    await expect(fixture.db.resetClinicData(resetInput, backup)).rejects.toBeInstanceOf(ProtectedPurchaseHistoryError);
    expect(backup).not.toHaveBeenCalled(); expect(await preservedState()).toEqual(before);
    await expect(q("TRUNCATE inventory_purchase_receipts")).rejects.toThrow("immutable");
    expect(await preservedState()).toEqual(before);
  });

  it("permits only empty-receipt reset and reads the real SQL snapshot through its separate connection without deadlock", async () => {
    await command();
    await q("INSERT INTO booking_requests(full_name,phone) VALUES('Synthetic reset booking','777000111')");
    const identities = await keptIdentities();
    let sql = ""; let backupPid = 0; let freezePid = 0;
    const result = await fixture.db.resetClinicData(resetInput, async backupClient => {
      backupPid = (await backupClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      freezePid = (await backupClient.query<{ pid: number }>(`SELECT pid FROM pg_locks
        WHERE relation='inventory_purchase_receipts'::regclass AND mode='ExclusiveLock' AND granted`)).rows[0].pid;
      expect(backupPid).not.toBe(freezePid);
      await backupClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await backupClient.query("SET LOCAL statement_timeout='5s'");
      try { for await (const line of fixture.db.backupSnapshotSqlLines(backupClient)) sql += line; }
      finally { await backupClient.query("ROLLBACK"); }
      return { ok: true, backupId: "synthetic-local-snapshot" };
    });
    expect(result.ok).toBe(true);
    expect(sql).toContain("inventory_purchase_receipts (0)");
    expect(sql).toContain("Synthetic reset booking");
    expect((await q("SELECT count(*)::int AS n FROM booking_requests")).rows[0].n).toBe(0);
    expect((await q("SELECT count(*)::int AS n FROM patients")).rows[0].n).toBe(0);
    expect(await keptIdentities()).toEqual(identities);
    expect((await q("SELECT count(*)::int AS n FROM inventory_purchase_receipts")).rows[0].n).toBe(0);
    await expect(q("TRUNCATE inventory_purchase_receipts")).resolves.toBeDefined();
  });

  it("purchase-first holds the shared fence until commit; reset then refuses without invoking backup", async () => {
    const c = await command();
    const blocker = new Client({ connectionString: fixture.url, ssl: false }); await blocker.connect();
    const backup = vi.fn(async () => ({ ok: true as const, backupId: "must-not-run" }));
    let purchase: ReturnType<typeof createInventoryPurchase> | undefined;
    let reset: Promise<{ error?: unknown; value?: unknown }> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM inventory_items WHERE id=$1 FOR UPDATE", [c.itemId]);
      purchase = createInventoryPurchase(c);
      await waitForLock("ShareLock", true);
      reset = fixture.db.resetClinicData(resetInput, backup).then(value => ({ value }), error => ({ error }));
      await waitForLock("ExclusiveLock", false);
      expect(backup).not.toHaveBeenCalled();
      await blocker.query("COMMIT");
      expect((await purchase).body).toMatchObject({ status: "committed" });
      expect((await reset).error).toBeInstanceOf(ProtectedPurchaseHistoryError);
      expect(backup).not.toHaveBeenCalled();
      expect((await q("SELECT count(*)::int AS n FROM inventory_purchase_receipts")).rows[0].n).toBe(1);
      expect((await q("SELECT count(*)::int AS n FROM inventory_movements")).rows[0].n).toBe(1);
      expect((await q("SELECT count(*)::int AS n FROM payables")).rows[0].n).toBe(1);
      expect((await q("SELECT count(*)::int AS n FROM audit_log WHERE action='system.reset'")).rows[0].n).toBe(0);
    } finally {
      await blocker.query("ROLLBACK").catch(() => {}); await blocker.end();
      await purchase?.catch(() => {}); await reset;
    }
  });

  it("reset-first blocks keyed purchase before user locks, retains identities, then admits exactly one purchase after reset", async () => {
    const c = await command(); const identities = await keptIdentities();
    const entered = deferred(), release = deferred();
    const observer = new Client({ connectionString: fixture.url, ssl: false }); await observer.connect();
    const reset = fixture.db.resetClinicData(resetInput, async () => {
      entered.resolve(); await release.promise; return { ok: true, backupId: "synthetic-reset-first" };
    });
    let purchase: ReturnType<typeof createInventoryPurchase> | undefined;
    try {
      await Promise.race([entered.promise, reset.then(() => { throw new Error("Reset ended before its backup callback"); })]);
      purchase = createInventoryPurchase(c);
      await waitForLock("ShareLock", false);
      // A writer waiting on the fence must not already hold the user SHARE lock.
      await observer.query("BEGIN"); await observer.query("SET LOCAL lock_timeout='500ms'");
      await observer.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [c.session.userId]);
      await observer.query("ROLLBACK");
      expect((await q("SELECT count(*)::int AS n FROM inventory_purchase_receipts")).rows[0].n).toBe(0);
      release.resolve(); expect((await reset).ok).toBe(true);
      expect((await purchase).body).toMatchObject({ status: "committed" });
      expect(await keptIdentities()).toEqual(identities);
      expect((await createInventoryPurchase(c)).body).toMatchObject({ status: "committed", replayed: true });
      expect((await q("SELECT count(*)::int AS n FROM inventory_purchase_receipts")).rows[0].n).toBe(1);
      expect((await q("SELECT count(*)::int AS n FROM inventory_movements")).rows[0].n).toBe(1);
      expect((await q("SELECT count(*)::int AS n FROM payables")).rows[0].n).toBe(1);
      expect((await q("SELECT count(*)::int AS n FROM audit_log WHERE action='system.reset'")).rows[0].n).toBe(1);
    } finally {
      release.resolve(); await observer.query("ROLLBACK").catch(() => {}); await observer.end();
      await reset.catch(() => {}); await purchase?.catch(() => {});
    }
  });
});
