/** EXPERIMENT ONLY: SQL/pg mechanics, not an application reader or authority API.
 * Run only with vitest.config.readonly-probe.mts via the reviewed owned PG18 runner.
 * Primary/session pooling only; replicas/transaction poolers are NOT covered.
 * No application imports/schema, permanent XID allocation, sequence calls or
 * application mutations in read sections. Internal PostgreSQL activity is normal.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { validateOwnershipHarnessEnvironment } from "../verify-schema-ownership";

// Reuse the same ownership guard directly, without a Docker-excluded test import.
// This experiment requires TEST_DATABASE_URL; there is no fallback.
const target = validateOwnershipHarnessEnvironment(process.env);
// Require local runner filesystem proof BEFORE this file opens a connection.
const run = dirname(realpathSync(process.env.TMPDIR ?? "/missing-owned-run"));
if (!/^pg18-[A-Za-z0-9]+$/.test(basename(run)) ||
    readFileSync(join(run, "OWNER.txt"), "utf8").trim() !== `synthetic-recovery:${basename(run)}` ||
    process.versions.node.split(".")[0] !== "22" ||
    target.testUrl.hostname !== "127.0.0.1" || target.testUrl.port !== "55632") {
  throw new Error("Owned PG18 runner / Node22 prerequisite missing");
}
const pool = new Pool({ connectionString: target.testUrl.toString(), ssl: false, max: 6 });
const borrowers = new Pool({ connectionString: target.testUrl.toString(), ssl: false, max: 1 });
const table = "public.canonical_readonly_probe_revision";
const fence = "aqlan.canonical.identity.substrate.v1:synthetic_readonly_probe";
const key = "hashtextextended($1, 0)";
const own = new Map<PoolClient, number>();
let proved = false;
const identitySql = `SELECT virtualxid::text FROM pg_catalog.pg_locks
 WHERE pid = pg_catalog.pg_backend_pid()
 AND locktype = 'virtualxid' AND mode = 'ExclusiveLock' AND granted`;
async function borrow(p = pool) {
  const c = await p.connect();
  // An owned terminated connection can emit an asynchronous driver error.
  c.on("error", () => {});
  own.set(c, (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
  return c;
}
function release(c: PoolClient, discard = false) { own.delete(c); c.release(discard); }
async function identity(c: PoolClient) {
  const rows = (await c.query(identitySql)).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].virtualxid).toMatch(/^\d+\/\d+$/);
  const r = (await c.query(`SELECT current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS readonly, pg_current_xact_id_if_assigned()::text AS xid`)).rows[0];
  expect(r).toEqual({ isolation: "repeatable read", readonly: "on", xid: null });
  return rows[0].virtualxid as string;
}
async function shared(c: PoolClient) { await c.query(`SELECT pg_advisory_lock_shared(${key})`, [fence]); }
async function unlock(c: PoolClient, name = fence) {
  const r = await c.query(`SELECT pg_advisory_unlock_shared(${key}) AS unlocked`, [name]);
  expect(r.rows).toEqual([{ unlocked: true }]);
}
async function blocked(observer: PoolClient, waiter: PoolClient, holder: PoolClient) {
  const end = performance.now() + 5000;
  while (performance.now() < end) {
    const r = await observer.query("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [own.get(holder), own.get(waiter)]);
    if (r.rows[0].blocked) return;
    // Poll yielding only; correctness is conditioned on the observed PG barrier.
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error("Expected owned PID blocking barrier not observed");
}
async function signal(observer: PoolClient, victim: PoolClient, terminate: boolean) {
  if (!proved || !own.has(victim) || victim === observer) throw new Error("Unproved signal target");
  const pid = own.get(victim)!;
  const r = await observer.query(`SELECT ${terminate ? "pg_terminate_backend" : "pg_cancel_backend"}(pid) AS signalled
    FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND usename=current_user`, [pid]);
  expect(r.rows).toEqual([{ signalled: true }]);
}
async function revision(c: PoolClient) { return (await c.query(`SELECT revision FROM ${table}`)).rows[0].revision as number; }

beforeAll(async () => {
  const c = await borrow();
  try {
    const r = (await c.query(`SELECT current_setting('data_directory') AS data,
      current_setting('server_version_num')::int AS version, pg_is_in_recovery() AS recovery,
      (SELECT system_identifier::text FROM pg_control_system()) AS system`)).rows[0];
    const data = join(run, "data");
    expect(realpathSync(r.data)).toBe(realpathSync(data));
    const s = statSync(data);
    expect(`${s.dev}:${s.ino}`).toBe(readFileSync(join(run, "data-identity.txt"), "utf8").trim());
    expect(r.version).toBeGreaterThanOrEqual(180000); expect(r.version).toBeLessThan(190000);
    expect(r.recovery).toBe(false);
    expect(readFileSync(join(run, "runtime-identity.txt"), "utf8").split("\n")[0]).toBe(r.system);
    expect((await c.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rows[0].n).toBe(0);
    proved = true;
    await c.query(`CREATE TABLE ${table}(revision integer NOT NULL); INSERT INTO ${table} VALUES(1)`);
  } finally { release(c); }
});
afterAll(async () => {
  // No DROP/forced cleanup of unknown databases. Runner shuts down its own cluster.
  for (const c of [...own.keys()]) release(c, true);
  await Promise.all([pool.end(), borrowers.end()]);
});

it("requires stable exact top virtual identity without assigning a permanent XID", async () => {
  const a = await borrow(), b = await borrow();
  try {
    await expect(identity(a)).rejects.toThrow(); // default autocommit is not admission
    await a.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const first = await identity(a);
    for (let i = 0; i < 20; i++) expect(await identity(a)).toBe(first);
    await a.query("SAVEPOINT outer_probe; SAVEPOINT inner_probe");
    expect(await identity(a)).toBe(first);
    await a.query("ROLLBACK TO inner_probe; RELEASE inner_probe");
    expect(await identity(a)).toBe(first);
    await a.query("SAVEPOINT later_probe");
    expect(await identity(a)).toBe(first);
    // The SELECT probe did not destroy either savepoint.
    await a.query("ROLLBACK TO later_probe; RELEASE later_probe; ROLLBACK TO outer_probe; RELEASE outer_probe");
    expect(await identity(a)).toBe(first);
    await b.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(await identity(b)).not.toBe(first);
    await b.query("ROLLBACK");
    await a.query("COMMIT; BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const second = await identity(a); expect(second).not.toBe(first);
    await a.query("ROLLBACK; BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(await identity(a)).not.toBe(second);
    await a.query("ROLLBACK");
    // Even default RR READ ONLY autocommit changes identity across statements.
    await a.query("SET default_transaction_isolation='repeatable read'; SET default_transaction_read_only=on");
    const auto1 = (await a.query(identitySql)).rows[0].virtualxid;
    expect((await a.query(identitySql)).rows[0].virtualxid).not.toBe(auto1);
  } finally { release(a, true); release(b, true); }
});

it("fences before BEGIN, demonstrates the inside-RR stale negative control, and linearizes revoke at writer commit", async () => {
  const reader = await borrow(), writer = await borrow(), observer = await borrow();
  try {
    for (const inside of [false, true]) {
      const old = await revision(observer);
      await writer.query("BEGIN");
      await writer.query(`SELECT pg_advisory_xact_lock(${key})`, [fence]);
      await writer.query(`UPDATE ${table} SET revision=revision+1`);
      if (inside) { await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); expect(await revision(reader)).toBe(old); }
      const waiting = shared(reader); // attached rejection immediately, drained below
      const settled = waiting.then(() => null, e => e);
      await blocked(observer, reader, writer);
      await writer.query("COMMIT");
      expect(await settled).toBeNull();
      if (!inside) await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await identity(reader);
      expect(await revision(reader)).toBe(inside ? old : old + 1);
      await reader.query("COMMIT"); await unlock(reader);
    }
    await shared(reader); await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const admitted = await revision(reader);
    await writer.query("BEGIN");
    const waiting = writer.query(`SELECT pg_advisory_xact_lock(${key})`, [fence]).then(() => null, e => e);
    await blocked(observer, writer, reader);
    expect(await revision(observer)).toBe(admitted);
    await reader.query("COMMIT");
    await blocked(observer, writer, reader); // session lock survives COMMIT
    await unlock(reader); expect(await waiting).toBeNull();
    await writer.query(`UPDATE ${table} SET revision=revision+1`);
    expect(await revision(observer)).toBe(admitted); // request/uncommitted update is not revocation
    await writer.query("COMMIT");
    await shared(reader); await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(await revision(reader)).toBe(admitted + 1); // new reader observes committed synthetic revision; no token admission is implemented
    await identity(reader); await reader.query("COMMIT"); await unlock(reader);
  } finally { release(reader, true); release(writer, true); release(observer, true); }
});

// Deliberately test-local lifecycle sketch, NOT a raw-client application facade.
async function experimentalRead(effect: (c: PoolClient) => Promise<void>, wrongUnlock = false) {
  const c = await borrow(borrowers);
  let acquired = false, started = false, discard = false, failure: unknown, facts: number | undefined;
  try {
    await shared(c); acquired = true;
    started = true; await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const id = await identity(c);
    facts = await revision(c);
    await effect(c);
    expect(await identity(c)).toBe(id);
    await c.query("COMMIT"); started = false;
  } catch (e) { failure = e; }
  try {
    if (started) await c.query("ROLLBACK");
    if (acquired) await unlock(c, wrongUnlock ? `${fence}:wrong` : fence);
  } catch (e) { discard = true; failure ??= e; }
  release(c, discard);
  if (failure) throw failure;
  return facts; // publishing is AFTER confirmed cleanup only
}

it("suppresses facts on abort, server timeout, owned cancellation/loss and false/wrong unlock; next borrower is clean", async () => {
  const observer = await borrow(), blocker = await borrow();
  const faultKey = `${fence}:fault`;
  try {
    await blocker.query(`SELECT pg_advisory_lock(${key})`, [faultKey]);
    for (const kind of ["abort", "timeout", "cancel", "loss", "false-unlock", "wrong-unlock"] as const) {
      let victimPid = 0;
      let published = false;
      const attempt = experimentalRead(async c => {
        victimPid = own.get(c)!;
        if (kind === "abort") { await c.query("SELECT 1/0"); return; }
        if (kind === "false-unlock") { await unlock(c); return; }
        if (kind === "wrong-unlock") return;
        if (kind === "timeout") await c.query("SET LOCAL statement_timeout='150ms'");
        const pending = c.query(`SELECT pg_advisory_xact_lock(${key})`, [faultKey]).then(() => null, e => e);
        if (kind !== "timeout") {
          await blocked(observer, c, blocker);
          await signal(observer, c, kind === "loss");
        }
        const error = await pending;
        expect(error).not.toBeNull();
        if (kind !== "loss") expect(error.code).toBe("57014");
        throw error;
      }, kind === "wrong-unlock").then(value => { published = true; return value; });
      await expect(attempt).rejects.toThrow(); expect(published).toBe(false);
      const next = await borrow(borrowers);
      try {
        if (["loss", "false-unlock", "wrong-unlock"].includes(kind)) expect(own.get(next)).not.toBe(victimPid);
        expect((await next.query("SELECT count(*)::int AS n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'")).rows[0].n).toBe(0);
        expect((await next.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("off");
        // Exclusive try-lock independently proves the old reader left no session fence.
        expect((await next.query(`SELECT pg_try_advisory_lock(${key}) AS acquired`, [fence])).rows[0].acquired).toBe(true);
        expect((await next.query(`SELECT pg_advisory_unlock(${key}) AS unlocked`, [fence])).rows[0].unlocked).toBe(true);
      } finally { release(next); }
    }
    expect(await experimentalRead(async () => {})).toBe(await revision(observer));
  } finally { release(blocker, true); release(observer, true); }
});
