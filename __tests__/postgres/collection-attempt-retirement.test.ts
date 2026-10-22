import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";

/**
 * 0068 on real PostgreSQL 18: a collection key is retired only when nothing committed under it,
 * and nothing can commit under it afterwards. Both orders of a concurrent send/retire are held
 * open deterministically on separate connections. Synthetic patients, users and shift only.
 */
assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_collection_retire_test");
process.env.DB_POOL_MAX = "10";
const auth = vi.hoisted(() => ({ session: null as SessionPayload | null }));
vi.mock("@/lib/session", async (original) => ({ ...await original<typeof import("../../lib/session")>(), requireSession: async () => auth.session }));
const db = await import("../../lib/db");
const authLib = await import("../../lib/auth");
const attempts = await import("../../lib/collection-attempts");
const payments = await import("../../app/api/payments/route");
const retireRoute = await import("../../app/api/payments/attempts/retire/route");
let session: SessionPayload, serial = 0, shiftId = 0;
const q = async <R = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as R[];
const key = (purpose: string) => `retire-${purpose}-${++serial}-000`;

beforeAll(async () => {
  await db.ensureSchema();
  const hash = await authLib.hashPassword("synthetic-retire-password");
  const [user] = await q<{ id: number }>("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('retire-reception','Synthetic retire',$1,'reception',TRUE) RETURNING id", [hash]);
  session = { userId: user.id, username: "retire-reception", role: "reception", credentialVersion: authLib.sessionCredentialVersion(hash), expiresAt: Date.now() + 3_600_000 };
  auth.session = session;
  await db.openShift({ openedBy: session.username, opening: { YER: 0, SAR: 0, USD: 0 } });
  shiftId = (await q<{ id: number }>("SELECT id FROM cashier_shifts WHERE status='open'"))[0].id;
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

async function patient() {
  return (await q<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic retire patient') RETURNING id", [key("patient")]))[0].id;
}
async function invoice(patientId: number, totalMinor = 50_000) {
  const [row] = await q<{ id: number }>("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency) VALUES($1,$2,$3,0,'YER') RETURNING id", [key("inv"), patientId, totalMinor]);
  await q("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor) VALUES($1,'Synthetic service',1,$2,$2)", [row.id, totalMinor]);
  return row.id;
}
const pay = async (body: Record<string, unknown>, k: string) => {
  const response = await payments.POST(new Request("http://localhost/api/payments", { method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": k, "x-collection-similarity-review": "none" },
    body: JSON.stringify({ kind: "payment", method: "cash", ...body }) }));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
/** The attempt exactly as the client saved it: patient, operation, body and the user who sent it. */
const identity = (k: unknown, patientId: unknown, extra: Record<string, unknown> = {}) => ({ idempotencyKey: k, patientId,
  operation: "payment", requestBody: JSON.stringify({ patientId, amount: "1000", currency: "YER" }), originalActor: session.username, ...extra });
const retire = async (k: unknown, patientId: unknown, extra: Record<string, unknown> = {}) => {
  const response = await retireRoute.POST(new Request("http://localhost/api/payments/attempts/retire", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(identity(k, patientId, extra)) }));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
const retireDirect = (k: string, patientId: number) => attempts.retireCollectionAttempt(identity(k, patientId), session);
const HASH = "a".repeat(64);
const rawPayment = (c: Client, patientId: number, invoiceId: number, k: string) => c.query(
  `INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by,idempotency_key)
   VALUES($1,$2,$3,$4,'payment',1000,'YER',1,1000,'YER','cash','synthetic',$5)`, [key("raw"), patientId, invoiceId, shiftId, k]);
async function connection() { const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); return c; }
async function waitForLock(monitor: Client, holderPid: number) {
  for (let i = 0; i < 400; i++) {
    const { rows: [{ n }] } = await monitor.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid NOT IN ($1,pg_backend_pid()) AND wait_event_type='Lock' AND wait_event='advisory'", [holderPid]);
    if (n >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("expected a session waiting on the per-key lock");
}

describe("collection attempt retirement (0068)", () => {
  it("a key that a writer refused before committing is retired, then can never record a receipt", async () => {
    const p = await patient(), k = key("refused");
    // A refusal the old client could not prove on its own: the invoice belongs to another patient.
    const refused = await pay({ patientId: p, invoiceId: await invoice(await patient()), amount: "1000", currency: "YER" }, k);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await retire(k, p)).toEqual({ status: 200, body: { state: "retired" } });
    // The same request arriving late (a delayed original send) is refused, not recorded.
    const late = await pay({ patientId: p, invoiceId: await invoice(p), amount: "1000", currency: "YER" }, k);
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ reason: "collection_attempt_retired", message: attempts.RETIRED_COLLECTION_MESSAGE });
    expect(await q("SELECT id FROM payments WHERE idempotency_key=$1", [k])).toEqual([]);
    expect(await retire(k, p)).toEqual({ status: 200, body: { state: "retired" } });
    // A lost reply after the retirement: asking again gives the same proven answer, for this attempt only.
    expect((await retire(k, await patient())).status).toBe(409);
    expect(await q("SELECT action FROM audit_log WHERE action='payment.attempt_retire' AND details->>'idempotencyKey'=$1", [k])).toHaveLength(1);
  });
  it("a committed key is reported committed and never retired; the client then replays the same request", async () => {
    const p = await patient(), k = key("committed");
    const body = { patientId: p, invoiceId: await invoice(p), amount: "1000", currency: "YER" };
    expect((await pay(body, k)).status).toBe(201);
    expect(await retire(k, p)).toEqual({ status: 200, body: { state: "committed" } });
    expect(await q("SELECT idempotency_key FROM collection_attempt_retirements WHERE idempotency_key=$1", [k])).toEqual([]);
    expect((await pay(body, k)).status).toBe(200);
  });
  it("retire waits for a send of the same key still in flight and then reports it committed", async () => {
    const p = await patient(), invoiceId = await invoice(p), k = key("inflight");
    const writer = await connection(), monitor = await connection();
    try {
      await writer.query("BEGIN");
      await rawPayment(writer, p, invoiceId, k); // holds the per-key lock, uncommitted
      const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const pending = retireDirect(k, p);
      await waitForLock(monitor, pid);
      await writer.query("COMMIT");
      expect(await pending).toBe("committed");
    } finally { await writer.end(); await monitor.end(); }
    expect(await q("SELECT idempotency_key FROM collection_attempt_retirements WHERE idempotency_key=$1", [k])).toEqual([]);
  });
  it("a send that arrives while a retirement is in flight waits and is refused once it commits", async () => {
    const p = await patient(), invoiceId = await invoice(p), k = key("retiring");
    const retirer = await connection(), writer = await connection(), monitor = await connection();
    try {
      await retirer.query("BEGIN");
      await retirer.query("INSERT INTO collection_attempt_retirements(idempotency_key,patient_id,operation,request_hash,retired_by) VALUES($1,$2,'payment',$3,'synthetic')", [k, p, HASH]);
      const pid = (await retirer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const pending = rawPayment(writer, p, invoiceId, k).then(() => "inserted", (error: Error) => error.message);
      await waitForLock(monitor, pid);
      await retirer.query("COMMIT");
      expect(await pending).toBe(attempts.COLLECTION_KEY_RETIRED);
    } finally { await retirer.end(); await writer.end(); await monitor.end(); }
    expect(await q("SELECT id FROM payments WHERE idempotency_key=$1", [k])).toEqual([]);
  });
  it("a retirement that rolls back (crash before commit) leaves the key usable; nothing is fenced", async () => {
    const p = await patient(), invoiceId = await invoice(p), k = key("rollback");
    const retirer = await connection();
    try {
      await retirer.query("BEGIN");
      await retirer.query("INSERT INTO collection_attempt_retirements(idempotency_key,patient_id,operation,request_hash,retired_by) VALUES($1,$2,'payment',$3,'synthetic')", [k, p, HASH]);
    } finally { await retirer.query("ROLLBACK"); await retirer.end(); }
    expect(await q("SELECT idempotency_key FROM collection_attempt_retirements WHERE idempotency_key=$1", [k])).toEqual([]);
    expect((await pay({ patientId: p, invoiceId, amount: "1000", currency: "YER" }, k)).status).toBe(201);
    expect(await retire(k, p)).toEqual({ status: 200, body: { state: "committed" } });
  });
  it("a retired key is permanent patient history: no cascade, no deletion, no merge moves it", async () => {
    const p = await patient(), k = key("delete");
    expect(await retireDirect(k, p)).toBe("retired");
    await expect(q("DELETE FROM patients WHERE id=$1", [p])).rejects.toThrow(/foreign key/);
    expect(await db.deletePatientCascade(p, { actor: "synthetic-admin", actorRole: "admin" })).toMatchObject({ ok: false, reason: "has_financial_history" });
    expect(await db.mergeDuplicatePatient(p, await patient(), { actor: "synthetic-admin", actorRole: "admin" }))
      .toMatchObject({ ok: false, reason: "source_has_financial_history", counts: { collectionAttempts: 1 } });
    expect(await q("SELECT patient_id FROM collection_attempt_retirements WHERE idempotency_key=$1", [k])).toEqual([{ patient_id: p }]);
  });
  it("a replaced session never retires another user's attempt; the proof is bound to the saved request", async () => {
    const p = await patient(), k = key("principal");
    const hash = await authLib.hashPassword("synthetic-second-cashier");
    const [other] = await q<{ id: number }>("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES($1,'Synthetic second',$2,'reception',TRUE) RETURNING id", [key("second"), hash]);
    const [{ username }] = await q<{ username: string }>("SELECT username FROM users WHERE id=$1", [other.id]);
    auth.session = { userId: other.id, username, role: "reception", credentialVersion: authLib.sessionCredentialVersion(hash), expiresAt: Date.now() + 3_600_000 };
    try {
      // Same saved attempt (sent by the first user) presented from the replacing session.
      expect(await retire(k, p)).toEqual({ status: 409, body: { message: attempts.ATTEMPT_OWNER_CHANGED } });
    } finally { auth.session = session; }
    expect(await q("SELECT idempotency_key FROM collection_attempt_retirements WHERE idempotency_key=$1", [k])).toEqual([]);
    expect(await retire(k, p)).toEqual({ status: 200, body: { state: "retired" } });
    expect(await q("SELECT operation, retired_by, length(request_hash) AS n FROM collection_attempt_retirements WHERE idempotency_key=$1", [k]))
      .toEqual([{ operation: "payment", retired_by: session.username, n: 64 }]);
    // A lost reply asks again with the identical attempt: same answer. Any other request under the key is refused.
    expect(await retire(k, p)).toEqual({ status: 200, body: { state: "retired" } });
    expect((await retire(k, p, { requestBody: JSON.stringify({ patientId: p, amount: "2000", currency: "YER" }) })).status).toBe(409);
    expect((await retire(k, p, { operation: "installment" })).status).toBe(409);
    expect((await retire(key("foreign-body"), p, { requestBody: JSON.stringify({ patientId: p + 1 }) })).status).toBe(400);
    expect((await retire(key("no-actor"), p, { originalActor: "" })).status).toBe(400);
    expect((await retire(key("correction"), p, { operation: "void" })).status).toBe(400);
  });
  it("refuses an invalid key, an unauthorized role and any change to a retired key", async () => {
    const p = await patient();
    expect((await retire("x", p)).status).toBe(400);
    expect((await retire(key("no-patient"), 999999)).status).toBe(400);
    const doctor = { ...session, role: "doctor" as const };
    auth.session = doctor;
    try { expect((await retire(key("doctor"), p)).status).toBe(403); } finally { auth.session = session; }
    const k = key("immutable");
    expect(await retireDirect(k, p)).toBe("retired");
    await expect(q("UPDATE collection_attempt_retirements SET retired_by='x' WHERE idempotency_key=$1", [k])).rejects.toThrow("immutable");
    await expect(q("DELETE FROM collection_attempt_retirements WHERE idempotency_key=$1", [k])).rejects.toThrow("immutable");
  });
});

describe("0068 operational compatibility", () => {
  it("a retired key and a committed receipt restore identically through the real backup path, keeping the fence", async () => {
    const { openBackupTimestampFixture } = await import("./_backup-timestamp-fixture");
    const { prepareBackupSql } = await import("../../lib/restore/sql.mjs");
    const { loadMigrationFiles, migrate } = await import("../../lib/migrations");
    const p = await patient(), done = key("restore-done"), gone = key("restore-gone");
    expect((await pay({ patientId: p, invoiceId: await invoice(p), amount: "1000", currency: "YER" }, done)).status).toBe(201);
    expect(await retireDirect(gone, p)).toBe("retired");
    const evidence = async (run: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>) => (await run(`SELECT
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY idempotency_key) FROM collection_attempt_retirements r WHERE idempotency_key = ANY($1)) AS retired,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p WHERE idempotency_key = ANY($1)) AS receipts`, [[done, gone]])).rows[0];
    const expected = await evidence((sql, values) => db.getPool().query(sql, values));
    const client = await db.getPool().connect(); const parts: string[] = [];
    try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); for await (const line of db.backupSnapshotSqlLines(client)) parts.push(line); await client.query("COMMIT"); }
    finally { client.release(); }
    const isolated = await openBackupTimestampFixture({ ...process.env });
    try {
      await migrate(isolated.sqlTarget, { apply: true, files: await loadMigrationFiles() });
      await isolated.sqlTarget.query(prepareBackupSql(parts.join("")).sql);
      expect(await evidence((sql, values) => isolated.sqlTarget.query(sql, values))).toEqual(expected);
      await expect(isolated.sqlTarget.query("INSERT INTO collection_attempt_retirements(idempotency_key,patient_id,operation,request_hash,retired_by) VALUES($1,$2,'payment',$3,'synthetic')", [done, p, HASH])).rejects.toThrow(attempts.COLLECTION_KEY_COMMITTED);
    } finally { await isolated.close(); }
  });
  it("a factory reset refuses before backup or deletion while any retired key exists; a late send stays refused", async () => {
    const { RESET_WIPE_TABLES, RESET_KEEP_TABLES, ProtectedCollectionAttemptHistoryError } = await import("../../lib/clinic-reset");
    expect(RESET_WIPE_TABLES).not.toContain("collection_attempt_retirements");
    expect(RESET_KEEP_TABLES).toContain("collection_attempt_retirements");
    const p = await patient(), k = key("reset");
    // An ordinary refusal (wrong-patient invoice) proven and retired, as the client would after a 409.
    expect((await pay({ patientId: p, invoiceId: await invoice(await patient()), amount: "1000", currency: "YER" }, k)).status).toBeGreaterThanOrEqual(400);
    expect(await retireDirect(k, p)).toBe("retired");
    const before = await q<{ patients: number; retired: number }>("SELECT (SELECT count(*)::int FROM patients) AS patients, (SELECT count(*)::int FROM collection_attempt_retirements) AS retired");
    const backup = vi.fn(async () => ({ ok: true as const, backupId: "synthetic" }));
    await expect(db.resetClinicData({ actor: "synthetic-admin", actorRole: "admin" }, backup)).rejects.toBeInstanceOf(ProtectedCollectionAttemptHistoryError);
    expect(backup).not.toHaveBeenCalled();
    expect(await q("SELECT (SELECT count(*)::int FROM patients) AS patients, (SELECT count(*)::int FROM collection_attempt_retirements) AS retired")).toEqual(before);
    // Identities were not restarted, and the delayed original send is still refused rather than recorded.
    const late = await pay({ patientId: p, invoiceId: await invoice(p), amount: "1000", currency: "YER" }, k);
    expect(late).toMatchObject({ status: 409, body: { reason: "collection_attempt_retired" } });
    // Direct TRUNCATE of retained proof is refused as well; only an empty table truncates.
    const c = await connection();
    try { await expect(c.query("TRUNCATE collection_attempt_retirements")).rejects.toThrow("immutable"); } finally { await c.end(); }
  });
});
