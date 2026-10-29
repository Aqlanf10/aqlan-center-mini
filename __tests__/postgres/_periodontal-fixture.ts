import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { assertPostgresMajorOrThrow, postgresMajorFromVersionNum } from "../../lib/env-contract";
import { validateOperationalVerificationEnvironment } from "../../lib/verification-target-policy.mjs";
import { PERIODONTAL_SQL } from "../../lib/periodontal-schema";
import { validatePostgresTestTarget } from "./_safe-target";

/** Reviewed test-only chain variants. Unknown counts, gaps or production suffixes fail closed. */
export function periodontalCandidateMigrationVersion(files: readonly { version: string; filename: string }[]): string {
  const reviewedAdditions: Record<string, string> = {
    "0066": "0066_agreement_delta_amendments.sql",
    "0067": "0067_patient_appointment_history_index.sql",
    "0068": "0068_collection_attempt_retirements.sql",
    "0069": "0069_unpaid_currency_transitions.sql",
    "0078": "0078_agreement_reconciliation.sql",
    "0087": "0087_agreement_reminder_metadata.sql",
    "0089": "0089_lab_shade_specification.sql",
  };
  const reviewedTails = ["0066", "0067", "0066,0067", "0066,0068", "0066,0067,0068", "0066,0068,0069", "0066,0067,0068,0069", "0066,0068,0069,0078", "0066,0067,0068,0069,0078", "0066,0068,0069,0078,0087", "0066,0067,0068,0069,0078,0087", "0066,0068,0069,0078,0087,0089", "0066,0067,0068,0069,0078,0087,0089"];
  if (files.length > 59 && reviewedTails.includes(files.slice(59).map(file => file.version).join(",")) &&
      files.slice(59).every(file => reviewedAdditions[file.version] === file.filename)) {
    return periodontalCandidateMigrationVersion(files.slice(0, 59));
  }
  if (files.length === 59 && files[58].version === "0065" && files[58].filename === "0065_inventory_purchase_receipts.sql") {
    return periodontalCandidateMigrationVersion(files.slice(0, 58));
  }
  if(files.length===58&&files[57].version==="0064"&&files[57].filename==="0064_approved_agreement_principal.sql"){
    return periodontalCandidateMigrationVersion(files.slice(0,57));
  }
  if(files.length===57&&files[56].version==="0063"&&files[56].filename==="0063_invoice_currency_reclassification.sql"){
    periodontalCandidateMigrationVersion(files.slice(0,56));
    // Isolated fixture sentinel, not an allocated production migration number.
    return "9000";
  }
  if (files.length === 56) {
    const ortho = files.filter(file => file.version === "0051" || file.version === "0052");
    if (ortho.length !== 2 || ortho[0].filename !== "0051_ortho_treatment_strategy.sql" || ortho[1].filename !== "0052_ortho_assessment.sql") {
      throw new Error("Unreviewed Ortho strategy/assessment union for periodontal test fixture.");
    }
    // Strip only the exact two root-authorized additions, then preserve every
    // existing HR/finance chain guard. No number is allocated by this fixture.
    return periodontalCandidateMigrationVersion(files.filter(file => file.version !== "0051" && file.version !== "0052"));
  }
  if (files.length === 54) {
    const hr = [
      "0045_hr_staff.sql", "0046_hr_tasks.sql", "0048_hr_contracts_attendance_leaves.sql",
      "0049_hr_payroll_disbursements.sql", "0050_hr_payroll_integrity.sql",
      "0056_hr_employment_history.sql", "0057_hr_schedule_policy_versions.sql", "0058_hr_temporal_write_receipts.sql",
    ];
    for (const [index, filename] of hr.entries()) {
      const file = files[43 + index];
      if (file.filename !== filename || file.version !== filename.slice(0, 4)) {
        throw new Error("Unreviewed HR migration suffix for periodontal test fixture.");
      }
    }
    // Reuse the strict invoice-chain guard after validating all eight allocated
    // HR extensions. This remains an isolated test candidate, never a migration.
    return periodontalCandidateMigrationVersion([...files.slice(0, 43), ...files.slice(51)]);
  }
  if(files.length===46&&files[45].version==="0061"&&files[45].filename==="0061_invoice_correction_lineage.sql"){
    periodontalCandidateMigrationVersion(files.slice(0,45));return "0062";
  }
  // Root-allocated0059/0060 are reviewed non-contiguous extensions. The inactive
  // candidate remains test-only and must not fill another branch's reservations.
  if(files.length===45&&files[44].version==="0060"&&files[44].filename==="0060_historical_treatment_documents.sql"){
    periodontalCandidateMigrationVersion(files.slice(0,44));return "0061";
  }
  if(files.length===44&&files[43].version==="0059"&&files[43].filename==="0059_invoice_debt_installments.sql"){
    periodontalCandidateMigrationVersion(files.slice(0,43));return "0060";
  }
  const expectedSuffixes = ["0041_invoice_clinical_linkage.sql", "0042_legacy_treatment_agreements.sql", "0043_legacy_treatment_coverage.sql"];
  if (files.length < 40 || files.length > 43) throw new Error("Unreviewed shipped migration baseline for periodontal candidate.");
  files.forEach((file, index) => {
    const expected = String(index + 1).padStart(4, "0");
    if (file.version !== expected) throw new Error("Shipped migration chain is missing, reordered or duplicated.");
    if (index >= 40 && file.filename !== expectedSuffixes[index - 40]) {
      throw new Error("Unreviewed shipped migration suffix for periodontal candidate.");
    }
  });
  return ({ 40: "0041", 41: "0042", 42: "0043", 43: "0044" } as const)[files.length as 40 | 41 | 42 | 43];
}

const NAME = /^aqlan_perio_[a-f0-9]{32}(?![\s\S])/;
export function validatePeriodontalFixtureTarget(environment: NodeJS.ProcessEnv) {
  // Inspect original aliases/classifications BEFORE changing process.env or connecting.
  validateOperationalVerificationEnvironment(environment);
  if (environment.USE_LOCAL_DB === "true") throw new Error("Periodontal fixture requires real PostgreSQL.");
  return validatePostgresTestTarget(environment, { allowDatabaseUrlFallback: true });
}
export function assertPeriodontalFixtureIdentity(name: string, expectedOid: string, observed: {
  name: string; oid: string; owner: string;
}, expectedOwner: string): void {
  if (!NAME.test(name) || observed.name !== name || observed.oid !== expectedOid || observed.owner !== expectedOwner) {
    throw new Error("Periodontal fixture identity changed; cleanup refused.");
  }
}

/** CI-only caller. Fresh UUID database, never drop/reset a pre-existing target. */
export async function openPeriodontalFixture(
  environment: NodeJS.ProcessEnv = process.env,
  options: { pristine?: boolean } = {},
) {
  const target = validatePeriodontalFixtureTarget(environment);
  const name = `aqlan_perio_${randomUUID().replaceAll("-", "")}`;
  if (!NAME.test(name)) throw new Error("Unsafe periodontal fixture name.");
  const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  let connected = false;
  let created = false;
  let identity: { oid: string; owner: string } | undefined;
  let db: typeof import("../../lib/db") | undefined;
  const managed = ["DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL_NON_POOLING",
    "NODE_ENV", "DATABASE_ENVIRONMENT", "USE_LOCAL_DB", "SKIP_SEED", "DB_POOL_MAX"] as const;
  const mutableEnv = process.env as Record<string, string | undefined>;
  const previous = Object.fromEntries(managed.map((key) => [key, mutableEnv[key]]));
  let changedEnvironment = false;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    try { await db?.resetPoolForTesting(); } catch (error) { failures.push(error); }
    if (changedEnvironment) for (const key of managed) {
      if (previous[key] === undefined) delete mutableEnv[key]; else mutableEnv[key] = previous[key];
    }
    if (created) {
      try {
        if (!identity) throw new Error("New periodontal fixture identity was not verified; cleanup requires review.");
        const { rows } = await admin.query<{ name: string; oid: string; owner: string }>(
          "SELECT datname AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname = $1", [name]);
        if (rows.length !== 1) throw new Error("Owned periodontal fixture is missing; cleanup refused.");
        assertPeriodontalFixtureIdentity(name, identity.oid, rows[0], identity.owner);
        // Pool must have drained. No FORCE, no IF EXISTS and no blanket schema reset.
        await admin.query(`DROP DATABASE "${name}"`);
      } catch (error) { failures.push(error); }
    }
    if (connected) try { await admin.end(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Periodontal fixture cleanup incomplete.");
  };
  try {
    await admin.connect(); connected = true;
    const { rows: [server] } = await admin.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version");
    assertPostgresMajorOrThrow(postgresMajorFromVersionNum(server.version));
    // A name collision fails. Only a successfully created database can be cleaned up.
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
    const { rows } = await admin.query<{ oid: string; owner: string }>(
      "SELECT oid::text, datdba::text AS owner FROM pg_database WHERE datname = $1", [name]);
    if (rows.length !== 1) throw new Error("New periodontal fixture identity unavailable.");
    identity = rows[0];
    const url = new URL(target.testUrl); url.pathname = `/${name}`;
    db = await import("../../lib/db");
    await db.resetPoolForTesting();
    changedEnvironment = true;
    mutableEnv.DATABASE_URL = url.toString();
    for (const key of ["POSTGRES_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL_NON_POOLING", "USE_LOCAL_DB"]) delete mutableEnv[key];
    mutableEnv.NODE_ENV = "test"; mutableEnv.DATABASE_ENVIRONMENT = "test";
    mutableEnv.SKIP_SEED = "true"; mutableEnv.DB_POOL_MAX = "8";
    const pool = db.getPool();
    const { rows: [actual] } = await pool.query<{ name: string; oid: string; owner: string }>(
      "SELECT datname AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname = current_database()");
    assertPeriodontalFixtureIdentity(name, identity.oid, actual, identity.owner);
    const { rows: [empty] } = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'");
    if (empty.count !== 0) throw new Error("Periodontal fixture must be a pristine owned database.");
    // Only the restore rehearsal opts out. Identity and emptiness were still verified.
    if (options.pristine === true) return { db, pool, name, url: url.toString(), close };
    await db.ensureSchema(); // Existing baseline only, in the fresh owned fixture.
    const { rows: [inactive] } = await pool.query<{ records: string | null; sites: string | null }>(
      "SELECT to_regclass('public.periodontal_records')::text AS records, to_regclass('public.periodontal_sites')::text AS sites");
    if (inactive.records !== null || inactive.sites !== null) throw new Error("Periodontal foundation unexpectedly activated by runtime.");
    await pool.query(PERIODONTAL_SQL); // Test-only proposal application; no runtime registration.
    return { db, pool, name, url: url.toString(), close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Periodontal fixture setup/cleanup failed."); }
    throw error;
  }
}
