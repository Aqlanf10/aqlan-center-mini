// Validates prerequisites.sql on SEPARATE synthetic databases only: the deployed schema with fixtures must
// pass every check, and each injected violation must fail exactly the checks that describe it.
// Also reports it on the already-upgraded synthetic database (partial-failure.mjs reports its own state).
// Env: OLD_ROOT, ADMIN_DATABASE_URL, EVIDENCE.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const { OLD_ROOT, ADMIN_DATABASE_URL, EVIDENCE } = process.env;
for (const [name, value] of Object.entries({ OLD_ROOT, ADMIN_DATABASE_URL, EVIDENCE })) if (!value) throw new Error(`${name} required`);
const admin = new URL(ADMIN_DATABASE_URL);
if (!["127.0.0.1", "localhost"].includes(admin.hostname)) throw new Error("refusing a non-local database: synthetic proof only");
const urlFor = (db) => { const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${db}`; return url.toString(); };
const SQL = readFileSync(path.join(here, "..", "prerequisites.sql"), "utf8");
const BASE = "aqlan_prereq_base";

const maintenance = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
await maintenance.connect();
const recreate = async (db, template) => {
  await maintenance.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await maintenance.query(`CREATE DATABASE ${db}${template ? ` TEMPLATE ${template}` : ""}`);
};
await recreate(BASE);
for (const script of ["init.mjs", "fixtures.mjs"]) {
  const child = spawnSync("npx", ["tsx", path.join(here, script), OLD_ROOT], { cwd: OLD_ROOT, encoding: "utf8", env: { ...process.env, DATABASE_URL: urlFor(BASE), NODE_ENV: "test" } });
  if (child.status !== 0) throw new Error(`${script}: ${child.stderr.slice(-1500)}`);
}

async function run(db, setup = []) {
  const client = new pg.Client({ connectionString: urlFor(db) });
  await client.connect();
  try {
    for (const statement of setup) await client.query(statement);
    const results = await client.query(SQL);
    const rows = [results].flat().find((r) => r.rows?.[0]?.check_id)?.rows ?? [];
    const stillReadOnly = (await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only;
    return { rows, failing: rows.filter((r) => !r.ok).map((r) => r.check_id).sort(), afterwardsReadOnly: stillReadOnly };
  } finally { await client.end(); }
}

const scenarios = [
  { name: "deployed_with_fixtures", setup: [], expect: [] },
  { name: "target_check_missing", setup: ["ALTER TABLE invoice_settlement_reclassifications DROP CONSTRAINT invoice_settlement_reclassifications_target_currency_check"],
    expect: ["currency.invoice_settlement_reclassifications_target_currency_check"] },
  { name: "source_check_not_validated", setup: [
      "ALTER TABLE invoice_settlement_reclassifications DROP CONSTRAINT invoice_settlement_reclassifications_source_currency_check",
      "ALTER TABLE invoice_settlement_reclassifications ADD CONSTRAINT invoice_settlement_reclassifications_source_currency_check CHECK (source_currency='YER') NOT VALID"],
    expect: ["currency.invoice_settlement_reclassifications_source_currency_check"] },
  { name: "extra_currency_check", setup: ["ALTER TABLE invoice_settlement_reclassifications ADD CONSTRAINT synthetic_extra_check CHECK (target_currency <> 'USD')"],
    expect: ["currency.no_other_checks_on_currency_columns"] },
  { name: "new_object_conflicts", setup: [
      "CREATE TABLE collection_attempt_retirements (synthetic INTEGER)",
      "CREATE FUNCTION aqlan_agreement_delta_immutable() RETURNS TRIGGER AS $$ BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql",
      "CREATE FUNCTION aqlan_unpaid_currency_transition_guard() RETURNS TRIGGER AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql",
      "CREATE TRIGGER invoice_reclassification_direction_guard BEFORE INSERT ON invoice_settlement_reclassifications FOR EACH ROW EXECUTE FUNCTION aqlan_unpaid_currency_transition_guard()",
      "ALTER TABLE payments ADD CONSTRAINT invoice_settlement_reclassifications_direction_check CHECK (true)"],
    expect: ["conflict.direction_check_name", "conflict.functions", "conflict.relation_names", "conflict.triggers_on_existing_tables", "conflict.type_names"] },
  { name: "appointments_index_name_taken_and_equivalent", setup: [
      "CREATE INDEX appointments_patient_history_idx ON appointments (id)",
      "CREATE INDEX synthetic_equivalent_idx ON appointments (patient_id, scheduled_date, scheduled_time, id)"],
    expect: ["appointments.index_name_absent", "appointments.no_equivalent_index", "conflict.relation_names"] },
  { name: "referenced_column_missing", setup: ["ALTER TABLE payments RENAME COLUMN idempotency_key TO synthetic_key"],
    expect: ["columns.payments.idempotency_key"] },
  { name: "referenced_key_not_unique", setup: ["ALTER TABLE parties DROP CONSTRAINT parties_pkey CASCADE"],
    expect: ["keys.parties.id"] },
  { name: "registry_drift", setup: [
      "UPDATE schema_migrations SET adopted = TRUE WHERE version = '0051'",
      "UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE version = '0052'"],
    expect: ["registry.names_and_checksums_match_published", "registry.none_adopted"] },
];

const evidence = { note: "Synthetic databases only. prerequisites.sql is read-only and ends in ROLLBACK.", scenarios: [] };
let failures = 0;
for (const [index, scenario] of scenarios.entries()) {
  const db = `aqlan_prereq_${index}`;
  await recreate(db, BASE);
  const result = await run(db, scenario.setup);
  const ok = JSON.stringify(result.failing) === JSON.stringify([...scenario.expect].sort());
  if (!ok) failures++;
  evidence.scenarios.push({ scenario: scenario.name, expectedFailing: [...scenario.expect].sort(), failing: result.failing, pass: ok,
    rows: index === 0 ? result.rows : result.rows.filter((r) => !r.ok) });
  await maintenance.query(`DROP DATABASE ${db} WITH (FORCE)`);
}
// The fully upgraded synthetic database from run-proof.mjs, when present: reported, not asserted.
for (const db of ["aqlan_upgrade_proof"]) {
  const exists = (await maintenance.query("SELECT 1 FROM pg_database WHERE datname=$1", [db])).rowCount;
  if (!exists) continue;
  const result = await run(db);
  evidence.scenarios.push({ scenario: `existing:${db}`, failing: result.failing, rows: result.rows.filter((r) => !r.ok) });
}
await maintenance.end();
evidence.result = failures === 0 ? "PASS" : `FAIL (${failures})`;
writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence.scenarios.map(({ scenario, failing, pass }) => ({ scenario, failing, pass })), null, 1), evidence.result);
if (failures) process.exit(1);
