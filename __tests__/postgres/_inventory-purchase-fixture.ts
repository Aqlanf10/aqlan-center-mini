import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { validateOperationalVerificationEnvironment } from "../../lib/verification-target-policy.mjs";
import { validatePostgresTestTarget } from "./_safe-target";

/** New identity-checked synthetic database only. Never reset a supplied target. */
export async function openInventoryPurchaseFixture(environment: NodeJS.ProcessEnv = process.env) {
  validateOperationalVerificationEnvironment(environment);
  const target = validatePostgresTestTarget(environment, { allowDatabaseUrlFallback: true });
  const name = `aqlan_purchase_reset_${randomUUID().replaceAll("-", "")}`;
  if (!/^aqlan_purchase_reset_[a-f0-9]{32}$/.test(name)) throw new Error("Unsafe purchase fixture name");
  const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  await admin.connect();
  const managed = ["DATABASE_URL", "SKIP_SEED", "DB_POOL_MAX", "SESSION_SECRET"] as const;
  const previous = Object.fromEntries(managed.map(key => [key, process.env[key]]));
  let identity: { oid: string; owner: string } | undefined;
  let db: typeof import("../../lib/db") | undefined;
  let created = false;
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    try {
      await db?.resetPoolForTesting();
      for (const key of managed) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      }
      if (created) {
        const { rows: [actual] } = await admin.query("SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1", [name]);
        if (!identity || actual?.oid !== identity.oid || actual.owner !== identity.owner) throw new Error("Purchase fixture identity changed; cleanup refused");
        await admin.query(`DROP DATABASE "${name}"`);
      }
    } finally { await admin.end(); }
  };
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
    identity = (await admin.query("SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1", [name])).rows[0];
    if (!identity) throw new Error("Purchase fixture identity unavailable");
    const url = new URL(target.testUrl); url.pathname = `/${name}`;
    db = await import("../../lib/db"); await db.resetPoolForTesting();
    process.env.DATABASE_URL = url.toString(); process.env.SKIP_SEED = "true"; process.env.DB_POOL_MAX = "12";
    const pool = db.getPool();
    const { rows: [actual] } = await pool.query("SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=current_database()");
    if (actual?.oid !== identity.oid || actual.owner !== identity.owner) throw new Error("Purchase fixture connection identity mismatch");
    await db.ensureSchema();
    return { db, pool, url: url.toString(), close };
  } catch (error) { await close(); throw error; }
}
