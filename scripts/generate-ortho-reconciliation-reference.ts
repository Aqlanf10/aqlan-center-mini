import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { Client } from "pg";
import { ensureSchema, resetPoolForTesting } from "../lib/db";
import { validateOwnershipHarnessEnvironment, assertPostgres18VersionNum } from "./verify-schema-ownership";
import { catalogHash, readOrthoCatalog, readRegistryCatalog, ORTHO_REFERENCE_SOURCE, ORTHO_VERSIONS } from "../lib/ortho-reconciliation-catalog";
import contracts from "../lib/ortho-assessment-runtime.generated.json";

// This generator never connects to an operator target: only the guarded test
// server and a fresh, separately owned database created from template0.
async function main() {
  execFileSync("git", ["diff", "--quiet", ORTHO_REFERENCE_SOURCE, "--", "lib/db.ts", "lib/migrations.ts", "lib/ortho-assessment-runtime.ts", "lib/ortho-assessment-runtime.generated.json", "migrations"]);
  const target = validateOwnershipHarnessEnvironment(process.env);
  const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  const name = `aqlan_ortho_reference_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(target.testUrl); url.pathname = `/${name}`;
  let identity: { oid: string; owner: string } | undefined;
  async function cleanupOwned() {
    if (!identity) return;
    const actual = (await admin.query("SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1", [name])).rows[0];
    if (!actual || actual.oid !== identity.oid || actual.owner !== identity.owner) throw new Error("REFERENCE_CLEANUP_IDENTITY_CHANGED");
    await admin.query(`DROP DATABASE "${name}"`);
  }
  await admin.connect();
  try {
    const { rows: [server] } = await admin.query("SELECT current_setting('server_version_num') AS version");
    assertPostgres18VersionNum(server.version);
    for (const file of contracts) {
      if (await readFile(new URL(`../migrations/${file.filename}`, import.meta.url), "utf8") !== file.sql) throw new Error("REFERENCE_SOURCE_MISMATCH");
    }
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    identity = (await admin.query("SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1", [name])).rows[0];
    process.env.DATABASE_URL = url.toString(); process.env.SKIP_SEED = "true";
    await resetPoolForTesting(); await ensureSchema(); await resetPoolForTesting();
    const client = new Client({ connectionString: url.toString(), ssl: false }); await client.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const catalogs = Object.fromEntries(await Promise.all(ORTHO_VERSIONS.map(async version => [version, await readOrthoCatalog(client, version)])));
      const registryCatalog = await readRegistryCatalog(client);
      const runtimeRegistry = (await client.query("SELECT version,name,checksum,adopted FROM public.schema_migrations ORDER BY version")).rows;
      await client.query("ROLLBACK");
      const manifest = { format: 1, source: ORTHO_REFERENCE_SOURCE, postgresMajor: 18,
        contracts: contracts.map(({ version, checksum }) => ({ version, checksum })), catalogs, registryCatalog, runtimeRegistry, digest: catalogHash({ catalogs, registryCatalog, runtimeRegistry }) };
      await writeFile(new URL("../schema/ortho-reconciliation-reference.pg18.json", import.meta.url), JSON.stringify(manifest, null, 2) + "\n");
      console.log(JSON.stringify({ event: "ortho_reference_generated", digest: manifest.digest }));
    } finally { await client.end(); }
  } finally {
    try { await resetPoolForTesting(); await cleanupOwned(); }
    finally { await admin.end(); }
  }
}
main().catch(() => { console.error("ORTHO_REFERENCE_GENERATION_FAILED"); process.exitCode = 1; });
