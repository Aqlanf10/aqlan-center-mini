// OFFLINE ONLY. Reuses the guarded ownership harness; never packaged or called
// by preflight. Output is a review candidate, never learned from a live target.
import { Client, Pool } from "pg";
import { loadMigrationFiles, migrate } from "../lib/migrations";
import { projectDetailedSchemaReadOnly, type DetailedSchemaCatalog } from "../lib/schema-manifest";
import { FINGERPRINT_FIELDS, FINGERPRINT_SECTIONS, fingerprint, fingerprintIdentity, type FingerprintDisclosurePolicy } from "../lib/schema-fingerprint";
import { assertPostgres18VersionNum, initializeGeneratedRuntimeSchema, validateOwnershipHarnessEnvironment, withGeneratedDatabasePair } from "./verify-schema-ownership";

export function disclosureFromSourceCatalogs(catalogs: DetailedSchemaCatalog[]): FingerprintDisclosurePolicy {
  const sections = {} as FingerprintDisclosurePolicy["sections"];
  for (const section of FINGERPRINT_SECTIONS) {
    const identities = new Set<string>();
    const text = new Map<string, Set<string>>();
    for (const catalog of catalogs) for (const entry of catalog[section]) {
      identities.add(fingerprintIdentity(section, entry));
      const value = JSON.parse(entry.value) as Record<string, unknown>;
      for (const [field, kind] of Object.entries(FINGERPRINT_FIELDS[section])) if (kind === "text") {
        if (!Object.hasOwn(value, field) || (value[field] !== null && typeof value[field] !== "string")) {
          throw new Error("Source catalog does not match disclosure field policy.");
        }
        const known = text.get(field) ?? new Set<string>();
        known.add(fingerprint("property", section, field, value[field])); text.set(field, known);
      }
    }
    sections[section] = { identities: [...identities].sort(),
      textValues: Object.fromEntries([...text].sort(([a], [b]) => a.localeCompare(b, "en")).map(([field, values]) => [field, [...values].sort()])) };
  }
  return { format: "aqlan-preflight-disclosure", formatVersion: 1, sections };
}

export async function generatePreflightDisclosure(): Promise<FingerprintDisclosurePolicy> {
  const target = validateOwnershipHarnessEnvironment();
  if ([...target.testUrl.searchParams.keys()].some((key) => key !== "sslmode")) throw new Error("Unsupported test connection options.");
  const suffix = `${process.pid}_${Date.now().toString(36)}`;
  const names = { migrations: `aqlan_schema_ownership_disclosure_migrations_${suffix}`, runtime: `aqlan_schema_ownership_disclosure_runtime_${suffix}` };
  const urlFor = (name: string) => { const url = new URL(target.testUrl); url.pathname = `/${name}`; return url.toString(); };
  return withGeneratedDatabasePair(new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false }), names,
    async (client) => {
      const result = await client.query("SELECT current_setting('server_version_num') AS version_num, current_setting('server_version') AS version") as { rows: { version_num: string; version: string }[] };
      return { major: assertPostgres18VersionNum(result.rows[0].version_num), version: result.rows[0].version };
    }, async () => {
      // template1 can contain operator data/DDL. Even template0 must yield an
      // empty application catalog before either source builder is permitted.
      for (const name of Object.values(names)) {
        const fresh = new Client({ connectionString: urlFor(name), ssl: false }); await fresh.connect();
        try { await assertPristineDisclosureDatabase(fresh); } finally { await fresh.end(); }
      }
      const pool = new Pool({ connectionString: urlFor(names.migrations), ssl: false });
      try { await migrate(pool, { apply: true, files: await loadMigrationFiles() }); } finally { await pool.end(); }
      await initializeGeneratedRuntimeSchema(target, names.runtime, process.env);
      const catalogs: DetailedSchemaCatalog[] = [];
      for (const name of Object.values(names)) {
        const client = new Client({ connectionString: urlFor(name), ssl: false }); await client.connect();
        try {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          await client.query("SET LOCAL search_path = pg_catalog");
          await client.query("SET LOCAL row_security = off");
          catalogs.push(await projectDetailedSchemaReadOnly(client, "public", { includeMutableSequenceState: false }));
          await client.query("COMMIT");
        } finally { await client.end(); }
      }
      return disclosureFromSourceCatalogs(catalogs);
    }, { template0: true });
}

export async function assertPristineDisclosureDatabase(client: Client): Promise<void> {
  const { rows } = await client.query<{ contaminated: boolean }>(`SELECT
    EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('public','pg_catalog','information_schema','pg_toast'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_collation c JOIN pg_catalog.pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname='public')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_event_trigger)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql') AS contaminated`);
  if (rows.length !== 1 || rows[0].contaminated !== false) throw new Error("Disclosure generation requires a pristine source-only database.");
}

if (process.argv[1]?.endsWith("/generate-preflight-disclosure.ts")) {
  if (process.argv.length > 2) throw new Error("No arguments supported.");
  generatePreflightDisclosure().then((policy) => console.log(JSON.stringify(policy, null, 2)));
}
