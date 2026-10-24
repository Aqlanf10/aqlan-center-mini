// Partial-application scenario on a SEPARATE synthetic database: a catalog precondition for 0069 is violated
// (one of the two CHECKs it drops by name is absent), so 0066 and 0068 commit and 0069 fails. Records what
// persists, whether the candidate refuses to start, that a retry leaves the partial state byte-identical,
// whether the deployed runtime still starts and writes, and whether restoring the precondition lets the
// candidate roll forward to the same twelve registrations.
// The violation is injected deliberately here; the main proof (run-proof.mjs) never modifies the schema.
// Env: OLD_ROOT, NEW_ROOT, ADMIN_DATABASE_URL, EVIDENCE.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runPrerequisites } from "./prereq.mjs";
import { assertLoopbackUrl, assertRuntimeRoots, sanitizedEnv, stripReroutingFromProcess } from "./guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { OLD_ROOT, NEW_ROOT, ADMIN_DATABASE_URL, EVIDENCE } = process.env;
for (const [name, value] of Object.entries({ OLD_ROOT, NEW_ROOT, ADMIN_DATABASE_URL, EVIDENCE })) if (!value) throw new Error(`${name} required`);
const DB = "aqlan_upgrade_partial";
const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${DB}`;
assertLoopbackUrl(ADMIN_DATABASE_URL, "ADMIN_DATABASE_URL");
stripReroutingFromProcess();
const roots = assertRuntimeRoots(OLD_ROOT, NEW_ROOT);
/** @param {string} script @param {string} root @param {...string} extra */
const step = (script, root, ...extra) => {
  const child = spawnSync("npx", ["tsx", path.join(here, script), root, ...extra], { cwd: root, encoding: "utf8", env: sanitizedEnv(url.toString()) });
  return { status: child.status, error: child.status === 0 ? null : (child.stderr.match(/(error|Error)[^\n]*/g) ?? []).slice(0, 3) };
};
const maintenance = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
await maintenance.connect();
await maintenance.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await maintenance.query(`CREATE DATABASE ${DB}`);
await maintenance.end();
/** @type {Record<string, any>} */
const result = { scenario: "0069 precondition violated: invoice_settlement_reclassifications_target_currency_check absent", roots };
/** @type {Array<{ check: string, ok: boolean }>} */
const checks = [];
/** @param {unknown} ok @param {string} message */
const check = (ok, message) => { checks.push({ check: message, ok: Boolean(ok) }); };
result.deployedInit = step("init.mjs", OLD_ROOT);
result.fixtures = step("fixtures.mjs", OLD_ROOT);
check(result.deployedInit.status === 0 && result.fixtures.status === 0, "deployed initialisation and fixtures exit 0");
const db = new pg.Client({ connectionString: url.toString() });
await db.connect();
/** @param {string} sql @returns {Promise<any[]>} */
const q = async (sql) => (await db.query(sql)).rows;
const versions = async () => (await q("SELECT version FROM schema_migrations ORDER BY version")).map((r) => r.version);
// Registry rows and the whole public catalog, to compare the partial state before and after a retry.
const state = async () => JSON.stringify({
  registry: await q("SELECT version, name, checksum, adopted, applied_at::text FROM schema_migrations ORDER BY version"),
  catalog: await q(`SELECT kind, name, def FROM (
      SELECT 'relation' AS kind, relname::text AS name, relkind::text AS def FROM pg_class WHERE relnamespace='public'::regnamespace
      UNION ALL SELECT 'constraint', conrelid::regclass::text || '.' || conname, pg_get_constraintdef(oid) || '|' || convalidated FROM pg_constraint WHERE connamespace='public'::regnamespace
      UNION ALL SELECT 'trigger', tgrelid::regclass::text || '.' || tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal
      UNION ALL SELECT 'function', p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE pronamespace='public'::regnamespace) o
    ORDER BY kind, name`),
});
const objects = async () => (await q(`SELECT to_regclass('agreement_delta_amendments') IS NOT NULL AS has_0066,
  to_regclass('collection_attempt_retirements') IS NOT NULL AS has_0068,
  EXISTS(SELECT 1 FROM pg_constraint WHERE conname='invoice_settlement_reclassifications_direction_check') AS has_0069,
  NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname IN ('invoice_settlement_reclassifications_source_currency_check','invoice_settlement_reclassifications_target_currency_check')) AS old_checks_dropped,
  to_regclass('appointments_patient_history_idx') IS NOT NULL AS has_0067`))[0];
// Locks held by any other backend on this database once a step's process has exited.
const strayLocks = async () => (await q(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE a.datname = current_database() AND l.pid <> pg_backend_pid()`))[0].n;

const EIGHT = ["0051", "0052", "0056", "0057", "0058", "0063", "0064", "0065"];
const TEN = [...EIGHT, "0066", "0068"];
result.registeredBeforeInjection = await versions();
check(JSON.stringify(result.registeredBeforeInjection) === JSON.stringify(EIGHT), "registry state 8 before the violation is injected");
await db.query("ALTER TABLE invoice_settlement_reclassifications DROP CONSTRAINT invoice_settlement_reclassifications_target_currency_check");
result.candidateFirstStart = step("init.mjs", NEW_ROOT);
result.registeredAfterFailure = await versions();
result.objectsAfterFailure = await objects();
check(result.candidateFirstStart.status === 1 && JSON.stringify(result.candidateFirstStart.error).includes("invoice_settlement_reclassifications_target_currency_check"),
  "candidate initialisation exits 1, failing in 0069 on the missing CHECK");
check(JSON.stringify(result.registeredAfterFailure) === JSON.stringify(TEN),
  "0066 and 0068 stay committed and registered after the 0069 failure (10 registrations)");
check(result.objectsAfterFailure.has_0066 && result.objectsAfterFailure.has_0068 && !result.objectsAfterFailure.has_0069 && !result.objectsAfterFailure.has_0067,
  "0066 and 0068 objects exist; 0069 and 0067 objects do not");
// What the read-only prerequisite check reports in this partially applied state (it must refuse it).
result.prerequisitesAfterFailure = (await runPrerequisites(db)).failing;
check(result.prerequisitesAfterFailure.includes("currency.invoice_settlement_reclassifications_target_currency_check")
  && result.prerequisitesAfterFailure.includes("registry.candidate_versions_absent"), "prerequisites.sql refuses the partial state and names the missing CHECK");
const partialState = await state();
result.candidateSecondStart = step("init.mjs", NEW_ROOT);
result.registeredAfterRetry = await versions();
result.strayLocksAfterRetry = await strayLocks();
check(result.candidateSecondStart.status === 1 && JSON.stringify(result.registeredAfterRetry) === JSON.stringify(TEN), "a retry exits 1 the same way and registry state stays 10 (fail closed)");
check(await state() === partialState, "the retry leaves the partial registry and catalog byte-identical");
check(result.strayLocksAfterRetry === 0, "no lock is left held after the failed retry");
result.deployedReinit = step("init.mjs", OLD_ROOT);
result.deployedWrites = step("fixtures.mjs", OLD_ROOT, "-partial");
result.registeredAfterDeployedFallback = await versions();
check(result.deployedReinit.status === 0 && result.deployedWrites.status === 0
  && JSON.stringify(result.registeredAfterDeployedFallback) === JSON.stringify(TEN),
  "the deployed runtime re-initialises and its writers succeed on the partial state, registering nothing");
// Forward repair (synthetic only): restore the exact precondition the prerequisite check names, then start the
// candidate again. Its validated re-add scans the table under ACCESS EXCLUSIVE, like 0069's own CHECK.
await db.query("ALTER TABLE invoice_settlement_reclassifications ADD CONSTRAINT invoice_settlement_reclassifications_target_currency_check CHECK (target_currency = 'SAR')");
result.candidateAfterRollForward = step("init.mjs", NEW_ROOT);
result.registeredAfterRollForward = await versions();
result.objectsAfterRollForward = await objects();
check(result.candidateAfterRollForward.status === 0 && JSON.stringify(result.registeredAfterRollForward) === JSON.stringify([...TEN, "0067", "0069"].sort())
  && Object.values(result.objectsAfterRollForward).every(Boolean), "after the forward repair the candidate reaches exactly 12 registrations with 0069 and 0067 applied");
await db.end();
result.checks = checks;
result.result = checks.every((c) => c.ok) ? "PASS" : "FAIL";
writeFileSync(EVIDENCE, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(checks, null, 1), result.result);
if (result.result !== "PASS") process.exit(1);
