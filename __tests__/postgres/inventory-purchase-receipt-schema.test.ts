import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertPostgresMajorOrThrow, postgresMajorFromVersionNum } from "../../lib/env-contract";
import { applyRuntimeMigrationFiles, loadMigrationFiles, migrate } from "../../lib/migrations";
import { checksumOf, type MigrationFile } from "../../lib/migration-files";
import { INVENTORY_PURCHASE_RECEIPTS_SQL } from "../../lib/inventory-purchase-schema";
import { introspectSchema } from "../../scripts/schema-introspect";
import { inspectSchemaReadOnly } from "../../lib/schema-preflight";
import { compareDetailedSchemaCatalogs, projectDetailedSchemaReadOnly } from "../../lib/schema-manifest";
import { classifyOpenFindings, parseOpenFindingsManifest } from "../../lib/schema-ownership-open-findings";
import openFindings from "../../schema/schema-ownership-open-findings.pg18.json";
import { validateOperationalVerificationEnvironment } from "../../lib/verification-target-policy.mjs";
import { validatePostgresTestTarget } from "./_safe-target";

// Check the original environment and every URL alias before connecting or
// replacing application globals. This suite never resets the supplied database.
validateOperationalVerificationEnvironment(process.env);
const target = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
const owned: Array<{ name: string; oid: string; owner: string; pool: Pool; url: string }> = [];
const namePattern = /^aqlan_purchase_schema_[a-f0-9]{32}$/;
let admin: Client;
let db: typeof import("../../lib/db");
let files: MigrationFile[];
let purchase: MigrationFile;
let throughPurchase: MigrationFile[];
let numbered: Pool;
let runtime: Pool;
const originalEnv = { DATABASE_URL: process.env.DATABASE_URL, SKIP_SEED: process.env.SKIP_SEED };

async function fresh() {
  const name = `aqlan_purchase_schema_${randomUUID().replaceAll("-", "")}`;
  if (!namePattern.test(name)) throw new Error("Invalid owned synthetic database name");
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  const { rows: [identity] } = await admin.query<{ oid: string; owner: string }>(
    "SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1", [name]);
  if (!identity) throw new Error("Created fixture identity unavailable; manual review required");
  const url = new URL(target.testUrl); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), ssl: false, max: 4, statement_timeout: 30_000 });
  const fixture = { name, ...identity, pool, url: url.toString() }; owned.push(fixture);
  const { rows: [connected] } = await pool.query(
    "SELECT datname AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=current_database()");
  expect(connected).toEqual({ name, ...identity });
  expect((await pool.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rows[0].n).toBe(0);
  return fixture;
}
async function runtimeAt(url: string) {
  await db.resetPoolForTesting();
  process.env.DATABASE_URL = url;
  process.env.SKIP_SEED = "true";
  await db.ensureSchema();
  await db.resetPoolForTesting();
}
const registry = async (pool: Pool) => (await pool.query(
  "SELECT version,name,checksum,adopted FROM schema_migrations WHERE version='0065'")).rows;
const expectedRegistry = () => [{ version: purchase.version, name: purchase.name, checksum: purchase.checksum, adopted: false }];

beforeAll(async () => {
  admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  await admin.connect();
  const { rows: [version] } = await admin.query("SHOW server_version_num");
  assertPostgresMajorOrThrow(postgresMajorFromVersionNum(version.server_version_num));
  files = await loadMigrationFiles();
  purchase = files.find(file => file.version === "0065")!;
  // These are 0065 tests: later numbered migrations (0066+) are outside their subject.
  throughPurchase = files.filter(file => file.version <= "0065");
  expect(purchase).toBeDefined();
  expect(purchase.sql).toBe(INVENTORY_PURCHASE_RECEIPTS_SQL);
  numbered = (await fresh()).pool;
  await migrate(numbered, { apply: true, files });
  const runtimeFixture = await fresh(); runtime = runtimeFixture.pool;
  db = await import("../../lib/db");
  await runtimeAt(runtimeFixture.url);
});
afterAll(async () => {
  const failures: unknown[] = [];
  try { await db?.resetPoolForTesting(); } catch (error) { failures.push(error); }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const fixture of [...owned].reverse()) {
    try {
      await fixture.pool.end();
      const { rows: [actual] } = await admin.query(
        "SELECT datname AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1", [fixture.name]);
      if (!namePattern.test(fixture.name) || actual?.name !== fixture.name || actual.oid !== fixture.oid || actual.owner !== fixture.owner) {
        throw new Error("Owned synthetic fixture identity changed; cleanup refused");
      }
      // Identity-matched fixtures created by this suite only. No FORCE or reset.
      await admin.query(`DROP DATABASE "${fixture.name}"`);
    } catch (error) { failures.push(error); }
  }
  try { await admin?.end(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Synthetic purchase fixture cleanup incomplete");
});

let serial = 0;
async function existingPurchase(pool: Pool) {
  const label = `Synthetic receipt schema ${++serial}`;
  const user = (await pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$1,'synthetic-non-login-hash','admin') RETURNING id", [label])).rows[0];
  const item = (await pool.query("INSERT INTO inventory_items(name,created_by) VALUES($1,$1) RETURNING id", [label])).rows[0];
  const supplier = (await pool.query("INSERT INTO parties(name,kind) VALUES($1,'supplier') RETURNING id", [label])).rows[0];
  const payable = (await pool.query("INSERT INTO payables(party_id,description,amount_minor,currency,base_amount_minor,created_by) VALUES($1,$2,125,'YER',125,$2) RETURNING id", [supplier.id, label])).rows[0];
  const row = (await pool.query("INSERT INTO inventory_movements(item_id,kind,qty,unit_cost_minor,party_id,payable_id,created_by) VALUES($1,'in',1.25,100,$2,$3,$4) RETURNING *", [item.id, supplier.id, payable.id, label])).rows[0];
  await pool.query("INSERT INTO audit_log(actor,action,entity,entity_id,summary,details) VALUES($1,'inventory.move','inventory_movement',$2,'Synthetic existing purchase','{}')", [label, String(row.id)]);
  const snapshot = { balance: 1.25, movement: {
    id: row.id, itemId: item.id, kind: "in", qty: 1.25, expiryDate: null, reason: null, visitId: null,
    createdBy: label, createdAt: row.created_at.toISOString(), unitCostMinor: 100, isReturn: false,
    partyId: supplier.id, payableId: payable.id,
  } };
  return { userId: user.id as number, itemId: item.id as number, movementId: row.id as number, snapshot };
}
async function state(pool: Pool) {
  const output: Record<string, unknown[]> = {};
  for (const table of ["inventory_items", "inventory_movements", "payables", "audit_log"]) {
    output[table] = (await pool.query(`SELECT to_jsonb(t)::text AS value FROM ${table} t ORDER BY id`)).rows;
  }
  return output;
}
async function receipt(pool: Pool, f: Awaited<ReturnType<typeof existingPurchase>>, overrides: {
  key?: string; actor?: number; movementId?: number | null; outcome?: string; snapshot?: unknown;
  digest?: string; fingerprintVersion?: number; resultVersion?: number;
} = {}) {
  const key = overrides.key ?? randomUUID();
  await pool.query(`INSERT INTO inventory_purchase_receipts
    (request_key,actor_user_id,fingerprint_version,request_digest,outcome,movement_id,result_version,result_snapshot)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [key, overrides.actor ?? f.userId,
    overrides.fingerprintVersion ?? 1, overrides.digest ?? "a".repeat(64), overrides.outcome ?? "committed",
    overrides.movementId === undefined ? f.movementId : overrides.movementId, overrides.resultVersion ?? 1,
    JSON.stringify(overrides.snapshot === undefined ? f.snapshot : overrides.snapshot)]);
  return key;
}

describe("purchase receipt installation and upgrade", () => {
  it("installs the same additive table/guards by empty numbered and runtime paths without fabricating receipts", async () => {
    expect(await registry(numbered)).toEqual(expectedRegistry());
    expect(await registry(runtime)).toEqual(expectedRegistry());
    const numberedTable = (await introspectSchema(numbered)).tables.inventory_purchase_receipts;
    expect((await introspectSchema(runtime)).tables.inventory_purchase_receipts).toEqual(numberedTable);
    for (const pool of [numbered, runtime]) {
      expect((await pool.query("SELECT count(*)::int AS n FROM inventory_purchase_receipts")).rows[0].n).toBe(0);
      expect(await applyRuntimeMigrationFiles(pool, [purchase])).toEqual([]);
      expect(await registry(pool)).toEqual(expectedRegistry());
    }
    expect(await migrate(numbered, { apply: true, files })).toMatchObject({ appliedVersions: [], alreadyUpToDate: true });
  });

  it.each(["numbered", "runtime"] as const)("upgrades released 0064 schema via %s while preserving existing purchase, payable and audit rows", async path => {
    const fixture = await fresh();
    await migrate(fixture.pool, { apply: true, files: files.filter(file => file.version < "0065") });
    await existingPurchase(fixture.pool);
    const before = await state(fixture.pool);
    expect((await fixture.pool.query("SELECT to_regclass('public.inventory_purchase_receipts') AS name")).rows[0].name).toBeNull();
    if (path === "numbered") {
      expect((await migrate(fixture.pool, { apply: true, files: throughPurchase })).appliedVersions).toEqual(["0065"]);
    } else await runtimeAt(fixture.url);
    expect(await state(fixture.pool)).toEqual(before);
    expect(await registry(fixture.pool)).toEqual(expectedRegistry());
    expect((await fixture.pool.query("SELECT count(*)::int AS n FROM inventory_purchase_receipts")).rows[0].n).toBe(0);
    if (path === "runtime") await runtimeAt(fixture.url);
    expect(await migrate(fixture.pool, { apply: true, files: throughPurchase })).toMatchObject({ appliedVersions: [], alreadyUpToDate: true });
    expect(await state(fixture.pool)).toEqual(before);
  });

  it("serializes runtime and numbered racers under the same migration lock", async () => {
    const fixture = await fresh();
    await migrate(fixture.pool, { apply: true, files: files.filter(file => file.version < "0065") });
    const competitor = new Pool({ connectionString: fixture.url, ssl: false });
    try {
      const [startup, cli] = await Promise.all([applyRuntimeMigrationFiles(fixture.pool, [purchase]), migrate(competitor, { apply: true, files: throughPurchase })]);
      expect([...startup, ...cli.appliedVersions]).toEqual(["0065"]);
      expect(await registry(fixture.pool)).toEqual(expectedRegistry());
    } finally { await competitor.end(); }
  });

  it("proves 0065 through the existing strict read-only preflight without claiming legacy registration convergence", async () => {
    const client = await runtime.connect();
    try {
      const statements: string[] = [];
      const report = await inspectSchemaReadOnly({
        query: async <T>(sql: string, values?: unknown[]) => {
          statements.push(sql);
          return { rows: (await client.query(sql, values)).rows as T[] };
        },
      }, files);
      expect(report.transaction).toEqual({ readOnly: true, isolation: "repeatable read" });
      expect(report.registry.present).toBe(true);
      for (const versions of [report.registry.missingVersions, report.registry.checksumMismatches,
        report.registry.nameMismatches, report.registry.adoptedVersions]) expect(versions).not.toContain("0065");
      expect(report.registry.missingVersions).toContain("0001");
      expect(report.registry.matchesFiles).toBe(false);
      expect(report.adoptionAssessment).toBe("NOT_PERFORMED");
      expect(report.schemaEquivalence).toBe("NOT_ASSESSED");
      expect(statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect(statements.some(sql => /\b(?:INSERT INTO|CREATE TABLE|ALTER TABLE|UPDATE inventory_|DELETE FROM|pg_advisory_lock)\b/i.test(sql))).toBe(false);
    } finally { client.release(); }
  });

  it("preserves the exact reviewed ownership differences without introducing new schema drift", async () => {
    const comparison = compareDetailedSchemaCatalogs(
      await projectDetailedSchemaReadOnly(numbered), await projectDetailedSchemaReadOnly(runtime));
    const classified = classifyOpenFindings(comparison, parseOpenFindingsManifest(openFindings));
    expect(classified.characterizationOk).toBe(true);
    expect(classified.openFindingsManifestMatch).toBe(true);
    expect(classified.openConvergenceFindings).toHaveLength(16);
    expect(classified.unexpectedDifferences).toEqual([]);
  });

  it("rolls back a failed additive migration and its registration, then applies the exact reviewed source", async () => {
    const fixture = await fresh();
    await migrate(fixture.pool, { apply: true, files: files.filter(file => file.version < "0065") });
    const sql = `${purchase.sql}\nSELECT 1 / 0;\n`;
    await expect(applyRuntimeMigrationFiles(fixture.pool, [{ ...purchase, sql, checksum: checksumOf(sql) }])).rejects.toThrow("division by zero");
    expect(await registry(fixture.pool)).toEqual([]);
    expect((await fixture.pool.query("SELECT to_regclass('public.inventory_purchase_receipts') AS name")).rows[0].name).toBeNull();
    expect(await applyRuntimeMigrationFiles(fixture.pool, [purchase])).toEqual(["0065"]);
  });

  it.each(["table", "function"])("refuses an unregistered existing %s without replacing or adopting it", async collision => {
    const fixture = await fresh();
    await migrate(fixture.pool, { apply: true, files: files.filter(file => file.version < "0065") });
    if (collision === "table") await fixture.pool.query("CREATE TABLE inventory_purchase_receipts(marker TEXT); INSERT INTO inventory_purchase_receipts VALUES('preserve synthetic legacy object')");
    else await fixture.pool.query("CREATE FUNCTION aqlan_inventory_purchase_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'preserve synthetic legacy routine'; END $$");
    await expect(applyRuntimeMigrationFiles(fixture.pool, [purchase])).rejects.toThrow(/already exists/);
    expect(await registry(fixture.pool)).toEqual([]);
    if (collision === "table") expect((await fixture.pool.query("SELECT * FROM inventory_purchase_receipts")).rows).toEqual([{ marker: "preserve synthetic legacy object" }]);
    else {
      expect((await fixture.pool.query("SELECT to_regclass('public.inventory_purchase_receipts') AS name")).rows[0].name).toBeNull();
      expect((await fixture.pool.query("SELECT pg_get_functiondef('aqlan_inventory_purchase_receipt_immutable()'::regprocedure) AS definition")).rows[0].definition).toContain("preserve synthetic legacy routine");
    }
  });

  it.each(["checksum", "name", "adopted"])("fails closed on a mismatched %s without another registration", async field => {
    const original = (await registry(numbered))[0];
    const replacement = field === "adopted" ? true : field === "checksum" ? "0".repeat(64) : "wrong_receipt_contract";
    await numbered.query(`UPDATE schema_migrations SET ${field}=$1 WHERE version='0065'`, [replacement]);
    try {
      await expect(applyRuntimeMigrationFiles(numbered, [purchase])).rejects.toThrow("RUNTIME_MIGRATION_REGISTRY_MISMATCH: 0065");
      expect(await registry(numbered)).toEqual([{ ...original, [field]: replacement }]);
    } finally { await numbered.query(`UPDATE schema_migrations SET ${field}=$1 WHERE version='0065'`, [original[field]]); }
  });
});

describe("immutable typed purchase receipts", () => {
  it.each(["committed", "rejected"])("keeps %s keys permanent across update, delete and truncate attempts", async outcome => {
    const f = await existingPurchase(numbered);
    const key = await receipt(numbered, f, outcome === "committed" ? {} : {
      outcome, movementId: null, snapshot: { message: "Synthetic controlled refusal", httpStatus: 409 },
    });
    const before = (await numbered.query("SELECT * FROM inventory_purchase_receipts WHERE request_key=$1", [key])).rows;
    await expect(numbered.query("UPDATE inventory_purchase_receipts SET request_digest=$2 WHERE request_key=$1", [key, "b".repeat(64)])).rejects.toThrow("immutable");
    await expect(numbered.query("DELETE FROM inventory_purchase_receipts WHERE request_key=$1", [key])).rejects.toThrow("immutable");
    await expect(numbered.query("TRUNCATE inventory_purchase_receipts")).rejects.toThrow("immutable");
    expect((await numbered.query("SELECT * FROM inventory_purchase_receipts WHERE request_key=$1", [key])).rows).toEqual(before);
    await expect(receipt(numbered, f, { key, movementId: null, outcome: "rejected", snapshot: { message: "Replacement must fail", httpStatus: 400 } })).rejects.toMatchObject({ code: "23505" });
  });

  it("restricts actor/movement deletion and enforces one receipt for one committed movement", async () => {
    const f = await existingPurchase(numbered); await receipt(numbered, f);
    await expect(receipt(numbered, f)).rejects.toMatchObject({ code: "23505" });
    await expect(numbered.query("DELETE FROM users WHERE id=$1", [f.userId])).rejects.toMatchObject({ code: "23001" });
    await expect(numbered.query("DELETE FROM inventory_movements WHERE id=$1", [f.movementId])).rejects.toBeDefined();
    const fks = (await numbered.query("SELECT conname,confdeltype FROM pg_constraint WHERE conrelid='inventory_purchase_receipts'::regclass AND contype='f' ORDER BY conname")).rows;
    expect(fks).toEqual([
      { conname: "inventory_purchase_receipts_actor_user_id_fkey", confdeltype: "r" },
      { conname: "inventory_purchase_receipts_movement_id_fkey", confdeltype: "r" },
    ]);
    const other = await existingPurchase(numbered);
    await expect(receipt(numbered, other, { actor: 2147483647 })).rejects.toMatchObject({ code: "23503" });
    const snapshot = { ...other.snapshot, movement: { ...other.snapshot.movement, id: 2147483647 } };
    await expect(receipt(numbered, other, { movementId: 2147483647, snapshot })).rejects.toMatchObject({ code: "23503" });
  });

  it.each([
    { outcome: "pending" }, { movementId: null }, { digest: "g".repeat(64) }, { fingerprintVersion: 2 }, { resultVersion: 2 },
    { snapshot: null }, { snapshot: [] }, { snapshot: {} },
    { outcome: "rejected", movementId: null, snapshot: { message: "", httpStatus: 400 } },
    { outcome: "rejected", movementId: null, snapshot: { message: "Synthetic", httpStatus: "400" } },
    { outcome: "rejected", movementId: null, snapshot: { message: "Synthetic", httpStatus: 500 } },
    { outcome: "rejected", movementId: null, snapshot: { message: "Synthetic", httpStatus: 400, rawRequest: {} } },
  ])("rejects invalid receipt shape %#", async overrides => {
    const f = await existingPurchase(numbered);
    await expect(receipt(numbered, f, overrides)).rejects.toMatchObject({ code: "23514" });
  });

  it.each([
    { id: "1" }, { kind: "out" }, { isReturn: true }, { itemId: {} }, { qty: {} }, { expiryDate: {} },
    { reason: {} }, { visitId: 1 }, { createdBy: {} }, { createdAt: {} }, { unitCostMinor: {} },
    { partyId: {} }, { payableId: {} }, { rawRequest: { confidential: "must not persist" } },
  ])("rejects non-allowlisted or incorrectly typed movement snapshots %#", async fields => {
    const f = await existingPurchase(numbered);
    await expect(receipt(numbered, f, { snapshot: { balance: 1.25, movement: { ...f.snapshot.movement, ...fields } } })).rejects.toMatchObject({ code: "23514" });
  });
});
