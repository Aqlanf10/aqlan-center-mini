// Deterministic lock inventory for 0066/0068/0069/0067 on a SEPARATE synthetic database (deployed runtime +
// the same fixtures). Each file runs alone in a transaction exactly as the runtime applies it; while it is
// still open we read the locks it holds and probe whether ordinary reads/writes on the touched tables would
// block (lock_timeout 200 ms), then ROLLBACK. Earlier files are committed first so later files see the same
// state the real startup gives them. Timings are synthetic-size only, never a Production estimate.
// Env: OLD_ROOT, NEW_ROOT, ADMIN_DATABASE_URL, EVIDENCE.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const { OLD_ROOT, NEW_ROOT, ADMIN_DATABASE_URL, EVIDENCE } = process.env;
for (const [name, value] of Object.entries({ OLD_ROOT, NEW_ROOT, ADMIN_DATABASE_URL, EVIDENCE })) if (!value) throw new Error(`${name} required`);
const DB = "aqlan_upgrade_locks";
const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${DB}`;
if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("refusing a non-local database: synthetic proof only");
const step = (script, root) => {
  const child = spawnSync("npx", ["tsx", path.join(here, script), root], { cwd: root, encoding: "utf8", env: { ...process.env, DATABASE_URL: url.toString(), NODE_ENV: "test" } });
  if (child.status !== 0) throw new Error(`${script}: ${child.stderr.slice(-1500)}`);
};
const maintenance = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
await maintenance.connect();
await maintenance.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await maintenance.query(`CREATE DATABASE ${DB}`);
await maintenance.end();
step("init.mjs", OLD_ROOT);
step("fixtures.mjs", OLD_ROOT);

const PROBES = {
  invoices: ["SELECT 1 FROM invoices LIMIT 1", "UPDATE invoices SET note = note WHERE id = (SELECT min(id) FROM invoices)"],
  invoice_items: ["SELECT 1 FROM invoice_items LIMIT 1", "UPDATE invoice_items SET description = description WHERE id = (SELECT min(id) FROM invoice_items)"],
  payments: ["SELECT 1 FROM payments LIMIT 1", "UPDATE payments SET note = note WHERE id = (SELECT min(id) FROM payments)"],
  appointments: ["SELECT 1 FROM appointments LIMIT 1", "UPDATE appointments SET note = note WHERE id = (SELECT min(id) FROM appointments)"],
  invoice_settlement_reclassifications: ["SELECT 1 FROM invoice_settlement_reclassifications LIMIT 1", null],
  patients: ["SELECT 1 FROM patients LIMIT 1", "UPDATE patients SET full_name = full_name WHERE id = (SELECT min(id) FROM patients)"],
  treatment_plans: ["SELECT 1 FROM treatment_plans LIMIT 1", "UPDATE treatment_plans SET note = note WHERE id = (SELECT min(id) FROM treatment_plans)"],
};
async function probe(sql) {
  if (!sql) return "n/a";
  const other = new pg.Client({ connectionString: url.toString() });
  await other.connect();
  try {
    await other.query("BEGIN"); await other.query("SET LOCAL lock_timeout = '200ms'");
    await other.query(sql); await other.query("ROLLBACK"); return "proceeds";
  } catch (error) { await other.query("ROLLBACK").catch(() => undefined); return /lock timeout/i.test(error.message) ? "BLOCKED" : `error: ${error.message}`; }
  finally { await other.end(); }
}

const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
const report = [];
for (const file of ["0066_agreement_delta_amendments", "0068_collection_attempt_retirements", "0069_unpaid_currency_transitions", "0067_patient_appointment_history_index"]) {
  const sql = readFileSync(path.join(NEW_ROOT, "migrations", `${file}.sql`), "utf8");
  const before = new Set((await client.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p')")).rows.map((r) => r.relname));
  await client.query("BEGIN");
  const started = performance.now();
  await client.query(sql);
  const ms = Math.round((performance.now() - started) * 10) / 10;
  const locks = (await client.query(`SELECT c.relname AS target, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
    WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p')
      AND l.mode IN ('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')
    ORDER BY c.relname, l.mode`)).rows;
  const preExisting = locks.filter((l) => before.has(l.target));
  const existing = [...new Set(preExisting.map((l) => l.target))].filter((t) => t in PROBES);
  const probes = {};
  for (const table of existing) probes[table] = { read: await probe(PROBES[table][0]), write: await probe(PROBES[table][1]) };
  await client.query("ROLLBACK");
  // Commit the file for real so the next file sees the startup's actual prior state.
  await client.query("BEGIN"); await client.query(sql); await client.query("COMMIT");
  report.push({ file, syntheticMs: ms, locksOnPreExistingTables: preExisting, probes });
}
await client.end();
writeFileSync(EVIDENCE, JSON.stringify({ note: "Synthetic-size timings; lock modes are exact. Not a Production performance claim.", files: report }, null, 2) + "\n");
console.log(JSON.stringify(report, null, 1));
