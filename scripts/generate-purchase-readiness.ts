// Synthetic-only fixture generator. Never use an application or Production target.
import { Client } from "pg";
import { writeFile } from "node:fs/promises";
import { validatePostgresTestTarget } from "../__tests__/postgres/_safe-target";
import { loadMigrationFiles } from "../lib/migration-files";
import { projectDetailedSchemaReadOnly } from "../lib/schema-manifest";
import { PURCHASE_READINESS_SECTIONS, purchaseReadinessValue, isPurchaseReadinessObject } from "../lib/purchase-schema-readiness";

async function main() {
const target = validatePostgresTestTarget(process.env);
const client = new Client({ connectionString: target.testUrl.toString() });
await client.connect();
try {
  // Transaction rolls back every synthetic fixture object, even on failure.
  await client.query("BEGIN");
  await client.query("CREATE TABLE public.users(id integer PRIMARY KEY); CREATE TABLE public.inventory_movements(id integer PRIMARY KEY)");
  const file = (await loadMigrationFiles()).find(file => file.version === "0065")!;
  await client.query(file.sql);
  await client.query("SET LOCAL search_path = pg_catalog");
  const catalog = await projectDetailedSchemaReadOnly(client, "public", { includeMutableSequenceState: false });
  if (catalog.postgresMajor !== 18) throw new Error("PostgreSQL 18 required.");
  const sections = Object.fromEntries(PURCHASE_READINESS_SECTIONS.map(section => [section, catalog[section]
    .filter(entry => isPurchaseReadinessObject(section, entry))
    .map(entry => ({ ...entry, value: purchaseReadinessValue(section, entry) }))]));
  await writeFile("schema/purchase-receipts-readiness.pg18.json", JSON.stringify({
    formatVersion: 1, postgresMajor: 18, migrationName: file.name, migrationSha256: file.checksum, sections,
  }, null, 2) + "\n");
} finally { await client.query("ROLLBACK"); await client.end(); }

}
main().catch(() => { console.error("Synthetic purchase readiness generation failed."); process.exitCode = 1; });
