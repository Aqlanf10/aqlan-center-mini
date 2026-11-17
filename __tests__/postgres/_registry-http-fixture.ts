import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { assertPostgresMajorOrThrow, postgresMajorFromVersionNum } from '../../lib/env-contract';
import { validateOperationalVerificationEnvironment } from '../../lib/verification-target-policy.mjs';
import { validatePostgresTestTarget } from './_safe-target';
import { validateStandaloneWitnessEnvironment } from './_standalone-restore-witness-guard';

type Identity = { name: string; oid: string; owner: string };
const NAME = /^aqlan_registry_http_[a-f0-9]{32}$/;

/** Allocate only new, identity-checked databases; preserve them on every exit. */
export async function openRegistryHttpFixture(env: NodeJS.ProcessEnv, targetCount: number) {
  validateStandaloneWitnessEnvironment(env);
  validateOperationalVerificationEnvironment(env);
  if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 8) throw new Error('Invalid synthetic target count');
  const target = validatePostgresTestTarget(env);
  const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  const owned: { name: string; identity?: Identity; pool?: Pool }[] = [];
  let connected = false;
  const close = async () => {
    const errors: unknown[] = [];
    for (const db of owned) {
      try {
        await db.pool?.end();
        if (!db.identity) throw new Error('Synthetic database identity unavailable');
        const rows = (await admin.query<Identity>('SELECT datname AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=$1', [db.name])).rows;
        if (rows.length !== 1 || JSON.stringify(rows[0]) !== JSON.stringify(db.identity)) throw new Error('Synthetic database identity changed');
      } catch (error) { errors.push(error); }
    }
    if (connected) try { await admin.end(); } catch (error) { errors.push(error); }
    connected = false;
    if (errors.length) throw new AggregateError(errors, 'Synthetic evidence retention verification failed');
  };
  try {
    await admin.connect(); connected = true;
    const version = (await admin.query<{version:string}>("SELECT current_setting('server_version_num') AS version")).rows[0].version;
    assertPostgresMajorOrThrow(postgresMajorFromVersionNum(version));
    async function create(restrictedTarget: boolean) {
      const name = `aqlan_registry_http_${randomUUID().replaceAll('-', '')}`;
      if (!NAME.test(name)) throw new Error('Invalid synthetic database name');
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      const entry: (typeof owned)[number] = { name }; owned.push(entry);
      const rows = (await admin.query<Identity>('SELECT datname AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=$1', [name])).rows;
      if (rows.length !== 1) throw new Error('New synthetic identity unavailable');
      entry.identity = rows[0];
      const url = new URL(target.testUrl); url.pathname = `/${name}`;
      entry.pool = new Pool({connectionString:url.toString(), ssl:false, max:1, connectionTimeoutMillis:10000, statement_timeout:15000});
      const actual = (await entry.pool.query<Identity>('SELECT current_database() AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=current_database()')).rows;
      if (actual.length !== 1 || JSON.stringify(actual[0]) !== JSON.stringify(entry.identity)) throw new Error('Synthetic identity mismatch');
      const count = (await entry.pool.query<{count:number}>("SELECT COUNT(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rows[0].count;
      if (count !== 0) throw new Error('Synthetic target is not empty');
      let restoreUrl = url.toString();
      if (restrictedTarget) {
        // This login cannot own or drop the target schema, even if a regression
        // reaches the application's destructive reset. Retain the role too.
        const role = `aqlan_registry_guard_${randomUUID().replaceAll('-', '')}`;
        if (!/^aqlan_registry_guard_[a-f0-9]{32}$/.test(role)) throw new Error('Invalid synthetic role');
        await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'synthetic-registry-test-only'`);
        await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO "${role}"`);
        const safety = (await entry.pool.query<{superuser:boolean;owns_public:boolean}>(
          "SELECT r.rolsuper AS superuser, (n.nspowner=r.oid OR pg_has_role(r.oid,n.nspowner,'MEMBER')) AS owns_public FROM pg_roles r CROSS JOIN pg_namespace n WHERE r.rolname=$1 AND n.nspname='public'",[role])).rows;
        if (safety.length !== 1 || safety[0].superuser || safety[0].owns_public) throw new Error('Synthetic guard role is not restricted');
        const restricted = new URL(url); restricted.username=role; restricted.password='synthetic-registry-test-only';
        restoreUrl = restricted.toString();
      }
      return { pool:entry.pool, identity:entry.identity, restoreUrl };
    }
    const source = await create(false);
    const targets = [];
    // The first target is a fresh positive control; all refusal targets use
    // restricted logins that cannot reset their populated schemas.
    for (let i=0; i<targetCount; i++) targets.push(await create(i !== 0));
    return { source, targets, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error,cleanup], 'Synthetic fixture setup failed'); }
    throw error;
  }
}
