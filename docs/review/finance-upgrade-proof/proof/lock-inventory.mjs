// Deterministic lock inventory for 0066/0068/0069/0067 on a SEPARATE synthetic database (deployed runtime +
// the same fixtures). Each file runs alone in a transaction exactly as the runtime applies it. While it is
// still open we read the locks it holds, and for every pre-existing table it locks we run an ordinary reader
// and writer from a second session with a bounded lock_timeout (200 ms). A blocked probe is proven by the
// server itself: pg_locks shows its request ungranted and pg_blocking_pids() names the migration backend.
// Then ROLLBACK: the catalog must be exactly as before and the same probes must proceed. The file is then
// committed so the next file sees the startup's real prior state. The whole inventory runs twice on freshly
// recreated databases and both passes must agree. Timings are synthetic-size only, never a Production estimate.
// Env: OLD_ROOT, NEW_ROOT, ADMIN_DATABASE_URL, EVIDENCE.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertLoopbackUrl, assertRuntimeRoots, sanitizedEnv, stripReroutingFromProcess } from "./guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { OLD_ROOT, NEW_ROOT, ADMIN_DATABASE_URL, EVIDENCE } = process.env;
for (const [name, value] of Object.entries({ OLD_ROOT, NEW_ROOT, ADMIN_DATABASE_URL, EVIDENCE })) if (!value) throw new Error(`${name} required`);
const DB = "aqlan_upgrade_locks";
const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${DB}`;
assertLoopbackUrl(ADMIN_DATABASE_URL, "ADMIN_DATABASE_URL");
stripReroutingFromProcess();
const roots = assertRuntimeRoots(OLD_ROOT, NEW_ROOT);
const FILES = ["0066_agreement_delta_amendments", "0068_collection_attempt_retirements", "0069_unpaid_currency_transitions", "0067_patient_appointment_history_index"];
const LOCK_TIMEOUT_MS = 200;
/** @param {string} script @param {string} root */
const step = (script, root) => {
  const child = spawnSync("npx", ["tsx", path.join(here, script), root], { cwd: root, encoding: "utf8", env: sanitizedEnv(url.toString()) });
  if (child.status !== 0) throw new Error(`${script}: ${child.stderr.slice(-1500)}`);
};

// Ordinary no-op writes where the table has a harmless column; every INSERT/UPDATE/DELETE first takes
// ROW EXCLUSIVE on its table, so for the remaining tables that exact lock request is the writer probe.
/** @type {Record<string, string>} */
const REAL_WRITES = {
  invoices: "UPDATE invoices SET note = note WHERE id = (SELECT min(id) FROM invoices)",
  invoice_items: "UPDATE invoice_items SET description = description WHERE id = (SELECT min(id) FROM invoice_items)",
  payments: "UPDATE payments SET note = note WHERE id = (SELECT min(id) FROM payments)",
  appointments: "UPDATE appointments SET note = note WHERE id = (SELECT min(id) FROM appointments)",
  patients: "UPDATE patients SET full_name = full_name WHERE id = (SELECT min(id) FROM patients)",
  treatment_plans: "UPDATE treatment_plans SET note = note WHERE id = (SELECT min(id) FROM treatment_plans)",
};
/** @param {string} table */
const probesFor = (table) => ({
  read: `SELECT 1 FROM "${table}" LIMIT 1`,
  write: REAL_WRITES[table] ?? `LOCK TABLE "${table}" IN ROW EXCLUSIVE MODE`,
});

/** Runs one probe from its own session with a bounded lock_timeout; returns its outcome and, if it waited,
 * the server's own record of the ungranted request and its blockers.
 * @param {string} sql @param {number} migrationPid */
async function probe(sql, migrationPid) {
  const other = new pg.Client({ connectionString: url.toString() });
  await other.connect();
  const observer = new pg.Client({ connectionString: url.toString() });
  await observer.connect();
  try {
    await other.query("BEGIN");
    await other.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
    await other.query("SET LOCAL statement_timeout = '5s'");
    const pid = /** @type {any} */ (other).processID;
    const started = performance.now();
    let waitedMs = -1;
    /** @type {string | null} */
    let sqlstate = null;
    // 55P03 (lock_not_available) is PostgreSQL's code for a lock_timeout expiry; nothing else counts as BLOCKED.
    const running = other.query(sql).then(() => "proceeds", (/** @type {any} */ error) => { sqlstate = error.code ?? null; return sqlstate === "55P03" ? "BLOCKED" : `error ${sqlstate}: ${error.message}`; })
      .finally(() => { waitedMs = Math.round(performance.now() - started); });
    /** @type {{ requested: string, blockedByMigration: boolean } | null} */
    let waiting = null;
    for (let i = 0; i < 15 && !waiting && waitedMs < 0; i++) {
      const { rows } = await observer.query(`SELECT mode, $2::int = ANY(pg_blocking_pids(pid)) AS blocked_by_migration FROM pg_locks
        WHERE pid = $1 AND NOT granted LIMIT 1`, [pid, migrationPid]);
      if (rows[0]) waiting = { requested: rows[0].mode, blockedByMigration: rows[0].blocked_by_migration };
      else await sleep(10);
      if (performance.now() - started > LOCK_TIMEOUT_MS) break;
    }
    const outcome = await running;
    await other.query("ROLLBACK").catch(() => undefined);
    return { outcome, sqlstate, waitedMs, ...(waiting ? { ungrantedRequest: waiting.requested, blockedByMigrationBackend: waiting.blockedByMigration } : {}) };
  } finally { await other.end(); await observer.end(); }
}

/** @param {pg.Client} client */
const catalogSnapshot = async (client) => JSON.stringify((await client.query(`SELECT kind, name FROM (
    SELECT 'relation' AS kind, relname::text AS name FROM pg_class WHERE relnamespace='public'::regnamespace
    UNION ALL SELECT 'constraint', conrelid::regclass::text || '.' || conname || '|' || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace
    UNION ALL SELECT 'trigger', tgrelid::regclass::text || '.' || tgname FROM pg_trigger WHERE NOT tgisinternal
    UNION ALL SELECT 'function', p.oid::regprocedure::text || md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE pronamespace='public'::regnamespace) o
  ORDER BY kind, name`)).rows);

async function inventory() {
  const maintenance = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
  await maintenance.connect();
  await maintenance.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await maintenance.query(`CREATE DATABASE ${DB}`);
  await maintenance.end();
  step("init.mjs", OLD_ROOT);
  step("fixtures.mjs", OLD_ROOT);
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  const migrationPid = /** @type {any} */ (client).processID;
  const report = [];
  try {
    for (const file of FILES) {
      const sql = readFileSync(path.join(NEW_ROOT, "migrations", `${file}.sql`), "utf8");
      const before = new Set((await client.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p')")).rows.map((r) => r.relname));
      const catalogBefore = await catalogSnapshot(client);
      await client.query("BEGIN");
      const started = performance.now();
      await client.query(sql);
      const syntheticMs = Math.round((performance.now() - started) * 10) / 10;
      const locks = (await client.query(`SELECT c.relname AS target, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
        WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p')
          AND l.mode IN ('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')
        ORDER BY c.relname, l.mode`)).rows;
      const preExisting = locks.filter((l) => before.has(l.target));
      const tables = [...new Set(preExisting.map((l) => l.target))];
      /** @type {Record<string, any>} */
      const whileOpen = {};
      for (const table of tables) whileOpen[table] = { read: await probe(probesFor(table).read, migrationPid), write: await probe(probesFor(table).write, migrationPid) };
      await client.query("ROLLBACK");
      const rollbackClean = await catalogSnapshot(client) === catalogBefore;
      /** @type {Record<string, any>} */
      const afterRollback = {};
      for (const table of tables) afterRollback[table] = { read: (await probe(probesFor(table).read, migrationPid)).outcome, write: (await probe(probesFor(table).write, migrationPid)).outcome };
      // Commit the file for real so the next file sees the startup's actual prior state.
      await client.query("BEGIN"); await client.query(sql); await client.query("COMMIT");
      report.push({ file, syntheticMs, locksOnPreExistingTables: preExisting, probesWhileOpen: whileOpen, rollbackClean, probesAfterRollback: afterRollback });
    }
  } finally { await client.end(); }
  return report;
}

// Deterministic parts only: lock modes, probe outcomes, the server's blocking record, rollback cleanliness.
/** @param {any[]} report */
const shape = (report) => JSON.stringify(report.map((f) => ({ file: f.file, locks: f.locksOnPreExistingTables, rollbackClean: f.rollbackClean, afterRollback: f.probesAfterRollback,
  whileOpen: Object.fromEntries(Object.entries(f.probesWhileOpen).map(([t, p]) => [t, Object.fromEntries(Object.entries(p).map(([k, v]) => [k, [v.outcome, v.ungrantedRequest ?? null, v.blockedByMigrationBackend ?? null]]))])) })));

// Expected behaviour, asserted: the exact strong locks each file holds on pre-existing tables, and which
// ordinary readers (r) and writers (w) must be blocked while the file's transaction is open.
const SRE = "ShareRowExclusiveLock";
/** @type {Record<string, Record<string, { locks: string[], blocked: string }>>} */
const EXPECTED = {
  "0066_agreement_delta_amendments": Object.fromEntries(["clinical_cases", "invoice_items", "invoices", "parties", "patients", "plan_items", "services", "treatment_plans", "users"]
    .map((t) => [t, { locks: [SRE], blocked: "w" }])),
  "0068_collection_attempt_retirements": Object.fromEntries(["agreement_delta_collection_receipts", "patients", "payments"].map((t) => [t, { locks: [SRE], blocked: "w" }])),
  "0069_unpaid_currency_transitions": {
    invoice_settlement_reclassification_events: { locks: [SRE], blocked: "w" },
    invoice_settlement_reclassifications: { locks: ["AccessExclusiveLock", SRE], blocked: "rw" },
  },
  "0067_patient_appointment_history_index": { appointments: { locks: ["ShareLock"], blocked: "w" } },
};
/** @param {any[]} report */
const mismatches = (report) => report.flatMap((f) => {
  const expected = EXPECTED[f.file];
  const actual = /** @type {Record<string, string[]>} */ ({});
  for (const l of f.locksOnPreExistingTables) (actual[l.target] ??= []).push(l.mode);
  const problems = [];
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(expected).sort())) problems.push(`${f.file}: locked tables ${Object.keys(actual).sort()}`);
  for (const [table, want] of Object.entries(expected)) {
    if (JSON.stringify((actual[table] ?? []).sort()) !== JSON.stringify([...want.locks].sort())) problems.push(`${f.file}: ${table} locks ${actual[table]}`);
    const probes = f.probesWhileOpen[table];
    for (const [kind, letter] of [["read", "r"], ["write", "w"]]) {
      const shouldBlock = want.blocked.includes(letter);
      const p = probes?.[kind];
      if (!p || (shouldBlock ? !(p.outcome === "BLOCKED" && p.sqlstate === "55P03" && p.blockedByMigrationBackend === true) : p.outcome !== "proceeds")) problems.push(`${f.file}: ${table} ${kind} ${JSON.stringify(p)}`);
    }
  }
  return problems;
});

const first = await inventory();
const second = await inventory();
/** @type {Array<{ check: string, ok: boolean }>} */
const checks = [];
const everyProbe = (/** @type {(p: any) => boolean} */ predicate) => first.every((f) => Object.values(f.probesWhileOpen).every((p) => predicate(p.read) && predicate(p.write)));
const unexpected = mismatches(first);
checks.push({ check: "exact expected lock modes per file and table; expected readers and writers blocked (SQLSTATE 55P03, blocked by the migration backend) and all others proceed",
  ok: unexpected.length === 0 });
checks.push({ check: "every blocked probe is recorded by the server as an ungranted request blocked by the migration backend",
  ok: everyProbe((p) => p.outcome !== "BLOCKED" || p.blockedByMigrationBackend === true) });
checks.push({ check: `every probe is bounded (lock_timeout ${LOCK_TIMEOUT_MS} ms) and ends as proceeds or BLOCKED`, ok: everyProbe((p) => p.outcome === "proceeds" || p.outcome === "BLOCKED") });
checks.push({ check: "ROLLBACK of every file leaves the catalog exactly as before", ok: first.every((f) => f.rollbackClean) });
checks.push({ check: "after ROLLBACK every reader and writer probe proceeds", ok: first.every((f) => Object.values(f.probesAfterRollback).every((p) => p.read === "proceeds" && p.write === "proceeds")) });
checks.push({ check: "a clean rerun on a recreated database gives identical lock modes, probe outcomes and blocking records", ok: shape(first) === shape(second) });
const result = checks.every((c) => c.ok) ? "PASS" : "FAIL";
writeFileSync(EVIDENCE, JSON.stringify({ note: "Synthetic-size timings; lock modes and blocking are exact. Not a Production performance claim.",
  roots, lockTimeoutMs: LOCK_TIMEOUT_MS, result, checks, unexpected, expected: EXPECTED, files: first, rerunSyntheticMs: second.map((f) => ({ file: f.file, syntheticMs: f.syntheticMs })) }, null, 2) + "\n");
console.log(JSON.stringify(checks, null, 1), result);
if (result !== "PASS") process.exit(1);
