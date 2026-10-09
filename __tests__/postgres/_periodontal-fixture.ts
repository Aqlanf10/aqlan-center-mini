import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { assertPostgresMajorOrThrow, postgresMajorFromVersionNum } from "../../lib/env-contract";
import { validateOperationalVerificationEnvironment } from "../../lib/verification-target-policy.mjs";
import { PERIODONTAL_SQL } from "../../lib/periodontal-schema";
import { validatePostgresTestTarget } from "./_safe-target";

/** Reviewed test-only chain variants. Unknown counts, gaps or production suffixes fail closed. */
export function periodontalCandidateMigrationVersion(files: readonly { version: string; filename: string }[]): string {
  const invoiceSuffixes = ["0041_invoice_clinical_linkage.sql", "0042_legacy_treatment_agreements.sql", "0043_legacy_treatment_coverage.sql"];
  const hrSuffixes = ["0045_hr_staff.sql", "0046_hr_tasks.sql"];
  // 0001–0043 قاعدة main المتصلة، ثم لاحقة هذه المرحلة 0045–0046 — والفجوة 0044
  // **معلنة**: محجوزة لهجرة 0044_invoice_admin_discount_lines.sql (مرشّح فواتير مفتوح
  // #301) لا يُشحن مع هذه الشجرة، فيأخذ المرشّح البيريودنتالي التجريبي فجوة 0044.
  files.forEach((file, index) => {
    const expectedVersion = String(index + 1 + (index >= 43 ? 1 : 0)).padStart(4, "0");
    if (file.version !== expectedVersion) throw new Error("Shipped migration chain is missing, reordered or duplicated.");
    if (index >= 40 && index < 43 && file.filename !== invoiceSuffixes[index - 40]) {
      throw new Error("Unreviewed shipped migration suffix for periodontal candidate.");
    }
    if (index >= 43 && file.filename !== hrSuffixes[index - 43]) {
      throw new Error("Unreviewed shipped migration suffix for periodontal candidate.");
    }
  });
  const candidate: string | undefined = ({ 40: "0041", 41: "0042", 42: "0043", 43: "0044", 45: "0044" } as const)[files.length];
  if (!candidate) throw new Error("Unreviewed shipped migration baseline for periodontal candidate.");
  return candidate;
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
