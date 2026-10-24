// Partial-application scenario on a SEPARATE synthetic database: a catalog precondition for 0069 is violated
// (one of the two CHECKs it drops by name is absent), so 0066 and 0068 commit and 0069 fails. Records what
// persists, whether the candidate refuses to start, whether the deployed runtime still starts and writes, and
// whether restoring the precondition lets the candidate roll forward to the same twelve registrations.
// Env: OLD_ROOT, NEW_ROOT, ADMIN_DATABASE_URL, EVIDENCE.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const { OLD_ROOT, NEW_ROOT, ADMIN_DATABASE_URL, EVIDENCE } = process.env;
for (const [name, value] of Object.entries({ OLD_ROOT, NEW_ROOT, ADMIN_DATABASE_URL, EVIDENCE })) if (!value) throw new Error(`${name} required`);
const DB = "aqlan_upgrade_partial";
const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${DB}`;
if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("refusing a non-local database: synthetic proof only");
const step = (script, root, ...extra) => {
  const child = spawnSync("npx", ["tsx", path.join(here, script), root, ...extra], { cwd: root, encoding: "utf8", env: { ...process.env, DATABASE_URL: url.toString(), NODE_ENV: "test" } });
  return { status: child.status, error: child.status === 0 ? null : (child.stderr.match(/(error|Error)[^\n]*/g) ?? []).slice(0, 3) };
};
const maintenance = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
await maintenance.connect();
await maintenance.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await maintenance.query(`CREATE DATABASE ${DB}`);
await maintenance.end();
const result = { scenario: "0069 precondition violated: invoice_settlement_reclassifications_target_currency_check absent" };
result.deployedInit = step("init.mjs", OLD_ROOT);
result.fixtures = step("fixtures.mjs", OLD_ROOT);
const db = new pg.Client({ connectionString: url.toString() });
await db.connect();
await db.query("ALTER TABLE invoice_settlement_reclassifications DROP CONSTRAINT invoice_settlement_reclassifications_target_currency_check");
const versions = async () => (await db.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map((r) => r.version);
result.candidateFirstStart = step("init.mjs", NEW_ROOT);
result.registeredAfterFailure = await versions();
result.objectsAfterFailure = (await db.query(`SELECT to_regclass('agreement_delta_amendments') IS NOT NULL AS has_0066,
  to_regclass('collection_attempt_retirements') IS NOT NULL AS has_0068,
  EXISTS(SELECT 1 FROM pg_constraint WHERE conname='invoice_settlement_reclassifications_direction_check') AS has_0069,
  to_regclass('appointments_patient_history_idx') IS NOT NULL AS has_0067`)).rows[0];
// What the read-only prerequisite check reports in this partially applied state (it must refuse it).
const prerequisites = [await db.query(readFileSync(path.join(here, "..", "prerequisites.sql"), "utf8"))].flat().find((r) => r.rows?.[0]?.check_id).rows;
result.prerequisitesAfterFailure = prerequisites.filter((r) => !r.ok).map((r) => r.check_id).sort();
result.candidateSecondStart = step("init.mjs", NEW_ROOT);
result.registeredAfterRetry = await versions();
result.deployedReinit = step("init.mjs", OLD_ROOT);
result.deployedWrites = step("fixtures.mjs", OLD_ROOT, "-partial");
result.registeredAfterDeployedFallback = await versions();
// Roll-forward (synthetic only): restore the exact precondition the prerequisite check names, then start the
// candidate again. Its validated re-add scans the table under ACCESS EXCLUSIVE, like 0069's own CHECK.
await db.query("ALTER TABLE invoice_settlement_reclassifications ADD CONSTRAINT invoice_settlement_reclassifications_target_currency_check CHECK (target_currency = 'SAR')");
result.candidateAfterRollForward = step("init.mjs", NEW_ROOT);
result.registeredAfterRollForward = await versions();
result.objectsAfterRollForward = (await db.query(`SELECT
  EXISTS(SELECT 1 FROM pg_constraint WHERE conname='invoice_settlement_reclassifications_direction_check') AS has_0069,
  NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname IN ('invoice_settlement_reclassifications_source_currency_check','invoice_settlement_reclassifications_target_currency_check')) AS old_checks_dropped,
  to_regclass('appointments_patient_history_idx') IS NOT NULL AS has_0067`)).rows[0];
await db.end();
writeFileSync(EVIDENCE, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 1));
