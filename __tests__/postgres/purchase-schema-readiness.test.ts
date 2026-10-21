import { Client, type QueryResultRow } from "pg";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { dropPublicSchema } from "./_setup";
import { loadMigrationFiles } from "../../lib/migration-files";
import { inspectSchemaReadOnly } from "../../lib/schema-preflight";
import { projectDetailedSchemaReadOnly, type ReadOnlyCatalogClient } from "../../lib/schema-manifest";
const target = validatePostgresTestTarget(process.env);
const client = new Client({ connectionString: target.testUrl.toString() });
const files = await loadMigrationFiles();
const migration = files.find(file => file.version === "0065")!;
beforeAll(async () => { await client.connect(); });
beforeEach(async () => {
  await dropPublicSchema(target.testUrl.toString());
  await client.query("CREATE TABLE public.users(id integer PRIMARY KEY); CREATE TABLE public.inventory_movements(id integer PRIMARY KEY)");
});
afterAll(async () => { await client.end(); });
async function install(register = true) {
  await client.query(migration.sql);
  if (register) {
    await client.query("CREATE TABLE public.schema_migrations(version text NOT NULL PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, adopted boolean NOT NULL)");
    await client.query("INSERT INTO public.schema_migrations VALUES ($1,$2,$3,false)", [migration.version, migration.name, migration.checksum]);
  }
}
async function inspect() {
  const before = await projectDetailedSchemaReadOnly(client, "public", { includeMutableSequenceState: false });
  const sql: string[] = [];
  const guarded: ReadOnlyCatalogClient = { query: async <T>(query: string, values?: unknown[]) => {
    sql.push(query);
    expect(query.trim()).toMatch(/^(SELECT|BEGIN|SET LOCAL|COMMIT|ROLLBACK)\b/);
    expect(query).not.toMatch(/FROM\s+(?:public\.)?inventory_purchase_receipts\b/i);
    return client.query<T & QueryResultRow>(query, values);
  } };
  const result = await inspectSchemaReadOnly(guarded, files, { purchaseReceiptsReadiness: true });
  expect(sql[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  expect(sql.at(-1)).toBe("COMMIT");
  expect(await projectDetailedSchemaReadOnly(client, "public", { includeMutableSequenceState: false })).toEqual(before);
  expect(result.schemaEquivalence).toBe("NOT_ASSESSED"); expect(result.registry.matchesFiles).toBe(false);
  return result.purchaseReceiptsReadiness!;
}
describe("0065 catalog-only synthetic PostgreSQL readiness", () => {
  it("observes absence without initialization", async () => { expect((await inspect()).catalogShape).toBe("ABSENT"); });
  it("detects same-name views rather than reporting absence", async () => {
    await client.query("CREATE VIEW public.inventory_purchase_receipts AS SELECT 1 AS synthetic");
    expect(await inspect()).toMatchObject({ relation: "CONFLICT", catalogShape: "PARTIAL_OR_CONFLICTING" });
  });
  it("recognizes exact migration shape and preserves historical registry gaps", async () => {
    await install(); expect(await inspect()).toMatchObject({ catalogShape: "COMPATIBLE", registry: "MATCH", registrationAndShapeMatch: true });
    expect((await inspectSchemaReadOnly(client, files)).purchaseReceiptsReadiness).toBeUndefined();
  });
  it("does not adopt a complete but unregistered schema", async () => {
    await install(false); expect(await inspect()).toMatchObject({ catalogShape: "COMPATIBLE", registry: "ABSENT", registrationAndShapeMatch: false });
  });
  it("detects partial schema", async () => {
    await install(); await client.query("DROP TRIGGER inventory_purchase_receipts_no_truncate ON public.inventory_purchase_receipts");
    expect((await inspect()).catalogShape).toBe("PARTIAL_OR_CONFLICTING");
  });
  it("detects disabled FK and immutable triggers", async () => {
    await install(); await client.query("ALTER TABLE public.inventory_purchase_receipts DISABLE TRIGGER ALL");
    expect((await inspect()).catalogShape).toBe("PARTIAL_OR_CONFLICTING");
  });
  it("withholds conflicting definitions and detects altered check semantics", async () => {
    await install(); await client.query("ALTER TABLE public.inventory_purchase_receipts DROP CONSTRAINT inventory_purchase_receipts_result_version_check; ALTER TABLE public.inventory_purchase_receipts ADD CONSTRAINT inventory_purchase_receipts_result_version_check CHECK (result_version = 2)");
    expect((await inspect()).catalogShape).toBe("PARTIAL_OR_CONFLICTING");
  });
});
