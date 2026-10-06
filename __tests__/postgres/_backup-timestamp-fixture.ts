import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { assertPostgresMajorOrThrow, postgresMajorFromVersionNum } from "../../lib/env-contract";
import { validateOperationalVerificationEnvironment } from "../../lib/verification-target-policy.mjs";
import { validatePostgresTestTarget } from "./_safe-target";

const NAME = /^aqlan_backup_precision_[a-f0-9]{32}(?![\s\S])/;
type Identity = { name: string; oid: string; owner: string };

export function validateBackupTimestampFixtureTarget(environment: NodeJS.ProcessEnv) {
  validateOperationalVerificationEnvironment(environment);
  if (environment.USE_LOCAL_DB === "true") throw new Error("Backup timestamp fixture requires real PostgreSQL.");
  return validatePostgresTestTarget(environment, { allowDatabaseUrlFallback: true });
}

export function assertBackupTimestampFixtureIdentity(expected: Identity, actual: Identity): void {
  if (!NAME.test(expected.name) || actual.name !== expected.name
      || actual.oid !== expected.oid || actual.owner !== expected.owner) {
    throw new Error("Backup timestamp fixture identity changed; cleanup refused.");
  }
}

/** CI-only fixture. No reset of a supplied database, app globals or migrations. */
export async function openBackupTimestampFixture(environment: NodeJS.ProcessEnv) {
  // Check original aliases, classifications and Railway markers before connecting.
  const target = validateBackupTimestampFixtureTarget(environment);
  const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  const owned: { name: string; identity?: Identity; pool?: Pool }[] = [];
  let connected = false;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    for (const database of [...owned].reverse()) {
      try {
        await database.pool?.end();
        if (!database.identity) throw new Error("New backup fixture identity unavailable; cleanup requires review.");
        const { rows } = await admin.query<Identity>(
          "SELECT datname AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=$1", [database.name]);
        if (rows.length !== 1) throw new Error("Owned backup fixture is missing; cleanup refused.");
        assertBackupTimestampFixtureIdentity(database.identity, rows[0]);
        // Only a successfully created, identity-matched fixture. Never FORCE/IF EXISTS.
        await admin.query(`DROP DATABASE "${database.name}"`);
      } catch (error) { failures.push(error); }
    }
    if (connected) try { await admin.end(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Backup timestamp fixture cleanup incomplete.");
  };
  try {
    await admin.connect(); connected = true;
    const { rows: [server] } = await admin.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version");
    assertPostgresMajorOrThrow(postgresMajorFromVersionNum(server.version));
    const open = async () => {
      const name = `aqlan_backup_precision_${randomUUID().replaceAll("-", "")}`;
      if (!NAME.test(name)) throw new Error("Unsafe backup timestamp fixture name.");
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      const database: (typeof owned)[number] = { name };
      owned.push(database); // A collision fails before this database becomes owned.
      const { rows } = await admin.query<Identity>(
        "SELECT datname AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=$1", [name]);
      if (rows.length !== 1) throw new Error("New backup fixture identity unavailable.");
      database.identity = rows[0];
      const url = new URL(target.testUrl); url.pathname = `/${name}`;
      const pool = new Pool({ connectionString: url.toString(), ssl: false, max: 1,
        connectionTimeoutMillis: 10_000, statement_timeout: 15_000 });
      database.pool = pool;
      const { rows: actual } = await pool.query<Identity>(
        "SELECT datname AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=current_database()");
      if (actual.length !== 1) throw new Error("Backup fixture connection identity unavailable.");
      assertBackupTimestampFixtureIdentity(database.identity, actual[0]);
      const { rows: [empty] } = await pool.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'");
      if (empty.count !== 0) throw new Error("Backup timestamp fixture must be pristine.");
      return pool;
    };
    const source = await open();
    const sqlTarget = await open();
    const archiveTarget = await open();
    return { source, sqlTarget, archiveTarget, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Backup timestamp fixture setup/cleanup failed."); }
    throw error;
  }
}
