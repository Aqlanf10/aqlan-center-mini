import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { assertPostgresMajorOrThrow, postgresMajorFromVersionNum } from "../../lib/env-contract";
import { validateOperationalVerificationEnvironment } from "../../lib/verification-target-policy.mjs";
import { validatePostgresTestTarget } from "./_safe-target";
import { validateStandaloneWitnessEnvironment } from "./_standalone-restore-witness-guard";

type Identity = { name: string; oid: string; owner: string };
const NAME = /^aqlan_0090_witness_[a-f0-9]{32}$/;

/** Four newly created synthetic databases; retain them even after failures. */
export async function openStandalone0090Fixture(env: NodeJS.ProcessEnv) {
  validateStandaloneWitnessEnvironment(env);
  validateOperationalVerificationEnvironment(env);
  const target = validatePostgresTestTarget(env);
  const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  const owned: { name: string; identity?: Identity; pool?: Pool }[] = [];
  let connected = false;
  const close = async () => {
    const errors: unknown[] = [];
    for (const entry of owned) {
      try {
        await entry.pool?.end();
        if (!entry.identity) throw new Error("Owned database identity unavailable");
        const rows = (await admin.query<Identity>("SELECT datname AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=$1", [entry.name])).rows;
        if (rows.length !== 1 || JSON.stringify(rows[0]) !== JSON.stringify(entry.identity)) throw new Error("Owned database identity changed");
      } catch (error) { errors.push(error); }
    }
    if (connected) try { await admin.end(); } catch (error) { errors.push(error); }
    connected = false;
    if (errors.length) throw new AggregateError(errors, "Synthetic database retention verification failed");
  };
  try {
    await admin.connect(); connected = true;
    const version = (await admin.query<{ version: string }>("SELECT current_setting('server_version_num') AS version")).rows[0].version;
    assertPostgresMajorOrThrow(postgresMajorFromVersionNum(version));
    async function create() {
      const name = `aqlan_0090_witness_${randomUUID().replaceAll("-", "")}`;
      if (!NAME.test(name)) throw new Error("Invalid synthetic database name");
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      const entry: (typeof owned)[number] = { name }; owned.push(entry);
      const rows = (await admin.query<Identity>("SELECT datname AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=$1", [name])).rows;
      if (rows.length !== 1) throw new Error("New database identity unavailable");
      entry.identity = rows[0];
      const url = new URL(target.testUrl); url.pathname = `/${name}`;
      entry.pool = new Pool({ connectionString: url.toString(), ssl: false, max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 15_000 });
      const actual = (await entry.pool.query<Identity>("SELECT current_database() AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=current_database()")).rows;
      if (actual.length !== 1 || JSON.stringify(actual[0]) !== JSON.stringify(entry.identity)) throw new Error("New database identity mismatch");
      const count = (await entry.pool.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rows[0].count;
      if (count !== 0) throw new Error("New database is not empty");
      return { pool: entry.pool, identity: entry.identity };
    }
    const source = await create(), controlTarget = await create(), emptyTarget = await create(), populatedTarget = await create();
    return { source, controlTarget, emptyTarget, populatedTarget, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Synthetic fixture setup failed"); }
    throw error;
  }
}
