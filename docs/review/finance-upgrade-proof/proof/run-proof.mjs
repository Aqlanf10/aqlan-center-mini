// Synthetic upgrade proof: deployed runtime f2b5eef9 → candidate c998b435 (#451), startup path only.
// No bulk `migrate`, no baseline adoption, no Production connection. Each runtime runs in its own process.
//
// Env: OLD_ROOT, NEW_ROOT (checkouts with dependencies installed), ADMIN_DATABASE_URL (a disposable
// cluster's maintenance DB), EVIDENCE (output JSON path). The proof database is dropped and recreated.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runPrerequisites } from "./prereq.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { OLD_ROOT, NEW_ROOT, ADMIN_DATABASE_URL, EVIDENCE } = process.env;
for (const [name, value] of Object.entries({ OLD_ROOT, NEW_ROOT, ADMIN_DATABASE_URL, EVIDENCE })) if (!value) throw new Error(`${name} required`);
const PROOF_DB = "aqlan_upgrade_proof";
const admin = new URL(ADMIN_DATABASE_URL);
const proofUrl = new URL(ADMIN_DATABASE_URL); proofUrl.pathname = `/${PROOF_DB}`;
if (!["127.0.0.1", "localhost"].includes(proofUrl.hostname)) throw new Error("refusing a non-local database: synthetic proof only");

const EXPECTED_DEPLOYED = ["0051", "0052", "0056", "0057", "0058", "0063", "0064", "0065"];
const EXPECTED_ADDED = ["0066", "0067", "0068", "0069"];
const commitOf = (root) => spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
// The candidate checkout is this review branch: c998b435 plus this directory only, so its runtime is c998b435's.
const evidence = { deployedRuntimeCommit: commitOf(OLD_ROOT), candidateCheckoutCommit: commitOf(NEW_ROOT), steps: [] };
const fail = (message) => { evidence.result = "FAIL"; evidence.failure = message; writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2)); throw new Error(message); };
const check = (condition, message, detail) => { evidence.steps.push({ check: message, ok: Boolean(condition), ...(detail === undefined ? {} : { detail }) }); if (!condition) fail(message); };

function run(script, root, appName, ...extra) {
  const started = performance.now();
  const child = spawnSync("npx", ["tsx", path.join(here, script), root, ...extra], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, DATABASE_URL: proofUrl.toString(), PGAPPNAME: appName, NODE_ENV: "test" } });
  const wallMs = Math.round(performance.now() - started);
  if (child.status !== 0) fail(`${script} (${appName}) exited ${child.status}: ${child.stderr.slice(-2000)}`);
  const line = child.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  return { ...JSON.parse(line), wallMs };
}

const maintenance = new pg.Client({ connectionString: admin.toString() });
await maintenance.connect();
await maintenance.query(`DROP DATABASE IF EXISTS ${PROOF_DB} WITH (FORCE)`);
await maintenance.query(`CREATE DATABASE ${PROOF_DB}`);
await maintenance.end();
const db = new pg.Client({ connectionString: proofUrl.toString() });
await db.connect();
/** @param {string} sql @param {unknown[]} [values] @returns {Promise<any[]>} */
const q = async (sql, values = []) => (await db.query(sql, values)).rows;
const registrations = () => q("SELECT version, name, checksum, adopted, applied_at::text FROM schema_migrations ORDER BY version");

/** Per-table content digest over a FIXED column list (pre-upgrade columns), so added columns cannot hide changes. */
async function tableDigests(columnsByTable) {
  const out = {};
  for (const [table, columns] of Object.entries(columnsByTable)) {
    const list = columns.map((c) => `t."${c}"`).join(",");
    const [{ digest }] = await q(`SELECT count(*)::text || ':' || coalesce(md5(string_agg(ROW(${list})::text, '|' ORDER BY ROW(${list})::text)), '') AS digest FROM "${table}" t`);
    out[table] = digest;
  }
  return out;
}
async function catalog() {
  const objects = await q(`
    SELECT 'table:'||c.relname AS key, '' AS def FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'
    UNION ALL SELECT 'column:'||table_name||'.'||column_name, data_type||'|'||is_nullable||'|'||coalesce(column_default,'') FROM information_schema.columns WHERE table_schema='public'
    UNION ALL SELECT 'constraint:'||t.relname||'.'||con.conname, pg_get_constraintdef(con.oid)||'|validated='||con.convalidated FROM pg_constraint con JOIN pg_class t ON t.oid=con.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
    UNION ALL SELECT 'index:'||indexname, indexdef FROM pg_indexes WHERE schemaname='public'
    UNION ALL SELECT 'trigger:'||c.relname||'.'||tg.tgname, pg_get_triggerdef(tg.oid) FROM pg_trigger tg JOIN pg_class c ON c.oid=tg.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT tg.tgisinternal
    UNION ALL SELECT 'function:'||p.proname, md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`);
  return Object.fromEntries(objects.map((o) => [o.key, o.def]));
}
const diff = (before, after) => ({
  added: Object.keys(after).filter((k) => !(k in before)).sort(),
  removed: Object.keys(before).filter((k) => !(k in after)).sort(),
  changed: Object.keys(before).filter((k) => k in after && before[k] !== after[k]).sort(),
});

// 1. Deployed runtime initialisation: exactly the eight selected extension registrations.
evidence.deployedInit = run("init.mjs", OLD_ROOT, "upgrade-proof-deployed");
const deployedRegs = await registrations();
check(JSON.stringify(deployedRegs.map((r) => r.version)) === JSON.stringify(EXPECTED_DEPLOYED), "deployed runtime registers exactly 0051/0052/0056/0057/0058/0063/0064/0065", deployedRegs.map((r) => r.version));
check(deployedRegs.every((r) => r.adopted === false), "deployed registrations are applied, never adopted");
// The starting point is the deployed schema exactly as the deployed runtime left it: nothing is normalised.
const OLD_CHECKS = {
  "constraint:invoice_settlement_reclassifications.invoice_settlement_reclassifications_source_currency_check": "CHECK ((source_currency = 'YER'::text))|validated=true",
  "constraint:invoice_settlement_reclassifications.invoice_settlement_reclassifications_target_currency_check": "CHECK ((target_currency = 'SAR'::text))|validated=true",
};
const catalogDeployed = await catalog();
check(Object.entries(OLD_CHECKS).every(([key, def]) => catalogDeployed[key] === def)
    && !Object.keys(catalogDeployed).some((k) => k.endsWith(".invoice_settlement_reclassifications_direction_check")),
  "unmodified deployed schema keeps its original validated YER/SAR CHECKs and has no direction CHECK",
  Object.fromEntries(Object.keys(OLD_CHECKS).map((k) => [k, catalogDeployed[k] ?? null])));
const prerequisitesDeployed = await runPrerequisites(db);
check(prerequisitesDeployed.failing.length === 0, "prerequisites.sql passes on the deployed schema before fixtures (no candidate object exists)",
  { rows: prerequisitesDeployed.rows.length, failing: prerequisitesDeployed.failing });

// 2. Synthetic clinical/financial fixtures through the deployed runtime's writers; baseline readings.
evidence.fixtures = run("fixtures.mjs", OLD_ROOT, "upgrade-proof-fixtures").fixtures;
evidence.balancesBefore = run("balances.mjs", OLD_ROOT, "upgrade-proof-balances-before").balances;
const columnsByTable = {};
for (const r of await q("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name<>'schema_migrations' ORDER BY table_name, ordinal_position")) {
  (columnsByTable[r.table_name] ??= []).push(r.column_name);
}
const catalogBefore = await catalog();
const fixtureCatalogDiff = diff(catalogDeployed, catalogBefore);
check(!fixtureCatalogDiff.added.length && !fixtureCatalogDiff.removed.length && !fixtureCatalogDiff.changed.length,
  "fixtures write data only: the catalog is identical before and after them", fixtureCatalogDiff);
const [legacy] = await q(`SELECT (SELECT count(*)::int FROM invoice_settlement_reclassifications WHERE source_currency='YER' AND target_currency='SAR') AS documents,
  (SELECT count(*)::int FROM invoice_settlement_reclassification_events) AS events`);
check(legacy.documents >= 1 && legacy.events >= 1 && (await runPrerequisites(db)).failing.length === 0,
  "legacy YER→SAR reclassification fixtures exist under the original CHECKs, and prerequisites still pass", legacy);
const digestsBefore = await tableDigests(columnsByTable);
const nonEmpty = Object.entries(digestsBefore).filter(([, d]) => !d.startsWith("0:")).map(([t]) => t);
evidence.nonEmptyTablesBefore = nonEmpty.length;

// 3. Candidate initialisation, twice. (Lock modes are inventoried deterministically by lock-inventory.mjs.)
const runs = [];
const [{ now: candidateStartedAt }] = await q("SELECT clock_timestamp()::text AS now");
for (const attempt of [1, 2]) {
  const init = run("init.mjs", NEW_ROOT, `upgrade-proof-candidate-${attempt}`);
  runs.push({ attempt, ...init, registrations: await registrations() });
}
evidence.candidateRuns = runs.map(({ registrations: regs, ...rest }) => ({ ...rest, registered: regs.map((r) => r.version) }));
const [first, second] = runs;

// 4. Registrations: exactly twelve, the eight untouched, four added in startup order, second run a no-op.
const finalRegs = second.registrations;
check(JSON.stringify(finalRegs.map((r) => r.version)) === JSON.stringify([...EXPECTED_DEPLOYED, ...EXPECTED_ADDED].sort()), "exactly twelve registrations after the candidate", finalRegs.map((r) => r.version));
check(JSON.stringify(finalRegs.filter((r) => EXPECTED_DEPLOYED.includes(r.version))) === JSON.stringify(deployedRegs), "the eight deployed registrations are byte-identical (name, checksum, adopted, applied_at)");
const added = first.registrations.filter((r) => EXPECTED_ADDED.includes(r.version));
check(added.every((r) => r.adopted === false), "0066/0067/0068/0069 are applied, never adopted");
const order = [...added].sort((a, b) => a.applied_at.localeCompare(b.applied_at) || a.version.localeCompare(b.version)).map((r) => r.version);
check(JSON.stringify(order) === JSON.stringify(["0066", "0068", "0069", "0067"]), "candidate startup applies 0066, 0068, 0069, then 0067", order);
const [{ ok: appliedByCandidate }] = await q("SELECT bool_and(applied_at > $1::timestamptz) AS ok FROM schema_migrations WHERE version = ANY($2)", [candidateStartedAt, EXPECTED_ADDED]);
check(appliedByCandidate === true, "0066/0067/0068/0069 (including 0069's constraint change) were applied only by the candidate's own initialisation", { candidateStartedAt });
check(JSON.stringify(second.registrations) === JSON.stringify(first.registrations), "second candidate initialisation registers and re-applies nothing");
const fileChecksums = run("checksums.mjs", NEW_ROOT, "upgrade-proof-checksums").checksums;
check(added.every((r) => r.checksum === fileChecksums[r.version]), "added registrations carry the published file checksums", Object.fromEntries(added.map((r) => [r.version, r.checksum])));
const unregistered = Object.keys(fileChecksums).filter((v) => !finalRegs.some((r) => r.version === v));
evidence.unregisteredHistoricalVersions = unregistered;
check(unregistered.length === Object.keys(fileChecksums).length - 12 && !unregistered.some((v) => [...EXPECTED_DEPLOYED, ...EXPECTED_ADDED].includes(v)),
  "every other historical migration stays unregistered (no retroactive registration or baseline adoption)", unregistered.length);

// 5. Existing records unchanged; catalog changes are exactly the expected additions plus 0069's constraint swap.
const digestsAfter = await tableDigests(columnsByTable);
const changedTables = Object.keys(digestsBefore).filter((t) => digestsBefore[t] !== digestsAfter[t]);
check(changedTables.length === 0, "every pre-existing table's rows are unchanged on their pre-upgrade columns", changedTables);
const catalogDiff = diff(catalogBefore, await catalog());
evidence.catalogDiff = catalogDiff;
const allowedRemoved = ["constraint:invoice_settlement_reclassifications.invoice_settlement_reclassifications_source_currency_check",
  "constraint:invoice_settlement_reclassifications.invoice_settlement_reclassifications_target_currency_check"];
check(JSON.stringify(catalogDiff.removed) === JSON.stringify(allowedRemoved), "only 0069's two currency CHECKs are removed", catalogDiff.removed);
check(catalogDiff.changed.every((k) => k.startsWith("function:")), "no pre-existing table, column, constraint, index or trigger definition changes (only CREATE OR REPLACE functions may differ)", catalogDiff.changed);
check(catalogDiff.added.includes("index:appointments_patient_history_idx") && catalogDiff.added.includes("constraint:invoice_settlement_reclassifications.invoice_settlement_reclassifications_direction_check"),
  "0067's index and 0069's validated direction CHECK exist");
evidence.balancesAfter = run("balances.mjs", NEW_ROOT, "upgrade-proof-balances-after").balances;
check(JSON.stringify(evidence.balancesAfter) === JSON.stringify(evidence.balancesBefore), "every patient's canonical per-currency balances are identical before (deployed reader) and after (candidate reader)");
// 6. Roll-forward safety: the deployed runtime still starts and writes on the upgraded schema (image fallback).
evidence.deployedReinit = run("init.mjs", OLD_ROOT, "upgrade-proof-deployed-reinit");
check(JSON.stringify((await registrations()).map((r) => r.version)) === JSON.stringify(finalRegs.map((r) => r.version)),
  "deployed runtime re-initialises on the upgraded schema without registering, replaying or refusing anything");
evidence.deployedWritesAfterUpgrade = run("fixtures.mjs", OLD_ROOT, "upgrade-proof-deployed-writes", "-after").fixtures;
check(evidence.deployedWritesAfterUpgrade.payments > evidence.fixtures.payments && evidence.deployedWritesAfterUpgrade.reclassifications === 2,
  "deployed runtime writers (invoices, receipts, reversal, plan, opening, appointments, YER→SAR reclassification) still succeed on the upgraded schema",
  evidence.deployedWritesAfterUpgrade);
evidence.result = "PASS";
evidence.digest = createHash("sha256").update(JSON.stringify(evidence.steps)).digest("hex");
writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2) + "\n");
await db.end();
console.log(`PASS: ${evidence.steps.length} checks; evidence ${EVIDENCE}`);
