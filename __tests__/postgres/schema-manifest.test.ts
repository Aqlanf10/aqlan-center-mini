import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import {
  comparePublicSchemaToManifest,
  manifestFromProjection,
  projectSchemaReadOnly,
  type BaselineSchemaManifest,
  type ReadOnlyCatalogClient,
} from "../../lib/schema-manifest";
import { adminClient, createIsolatedDatabase } from "./_setup";

const DATABASE_NAME = `aqlan_manifest_${process.pid}_${Date.now()}`.toLowerCase();
let url = "";
let client: Client;
let baselineSql = "";

beforeAll(async () => {
  url = await createIsolatedDatabase(DATABASE_NAME);
  client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  baselineSql = await readFile(path.resolve("migrations/0001_baseline_schema.sql"), "utf8");
  await client.query(baselineSql);
});

afterAll(async () => {
  await client?.end().catch(() => {});
  const admin = adminClient("postgres");
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE_NAME} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

/** كل اختبار تخريبي يعمل داخل معاملة تُراجع دائمًا — لا تلوث للحالات التالية. */
async function withTxn(fn: () => Promise<void>): Promise<void> {
  await client.query("BEGIN");
  try {
    await fn();
  } finally {
    await client.query("ROLLBACK");
  }
}

function manifestNow(baselineSqlText: string = baselineSql): Promise<BaselineSchemaManifest> {
  return (async () => {
    const { rows } = await client.query<{ server_version: string }>(
      "SELECT current_setting('server_version') AS server_version",
    );
    const projection = await projectSchemaReadOnly(client as unknown as ReadOnlyCatalogClient, "public", ["public"]);
    return manifestFromProjection(projection, {
      baselineSql: baselineSqlText,
      postgresMajor: 18,
      postgresVersion: rows[0]?.server_version ?? "18-test",
    });
  })();
}

describe("PostgreSQL 18 baseline schema manifest", () => {
  it("matches an intact 0001 schema and production comparison issues SELECT only", async () => {
    const { rows } = await client.query<{ server_version: string; server_version_num: string }>(
      "SELECT current_setting('server_version') AS server_version, current_setting('server_version_num') AS server_version_num",
    );
    const versionNum = Number(rows[0]?.server_version_num ?? 0);
    expect(Math.floor(versionNum / 10_000)).toBe(18);

    const manifest = await manifestNow();
    const observed: string[] = [];
    const readOnlyClient: ReadOnlyCatalogClient = {
      query: async <T = any>(sql: string, values?: unknown[]) => {
        observed.push(sql.trim());
        const result = await client.query(sql, values as never[] | undefined);
        return { rows: result.rows as T[] };
      },
    };
    const diff = await comparePublicSchemaToManifest(readOnlyClient, manifest);

    expect(diff.ok).toBe(true);
    expect(manifest.postgresMajor).toBe(18);
    expect(manifest.checked.tables).toBeGreaterThan(40);
    expect(manifest.checked.columns).toBeGreaterThan(200);
    expect(observed.length).toBe(5);
    expect(observed.every((sql) => /^SELECT\b/i.test(sql))).toBe(true);
    expect(observed.join("\n")).not.toMatch(/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|SET|LOCK)\b/i);
  });

  it("fails closed when a required baseline table is missing", async () => {
    await withTxn(async () => {
      const manifest = await manifestNow();
      // display_announcements لا يشير إليها أي مفتاح أجنبي — إسقاطها نظيف داخل المعاملة.
      await client.query("DROP TABLE display_announcements");
      const diff = await comparePublicSchemaToManifest(client as unknown as ReadOnlyCatalogClient, manifest);
      expect(diff.ok).toBe(false);
      expect(diff.missingTables).toContain("display_announcements");
    });
  });

  it("fails closed when a required baseline column is missing", async () => {
    await withTxn(async () => {
      const manifest = await manifestNow();
      await client.query("ALTER TABLE services DROP COLUMN category");
      const diff = await comparePublicSchemaToManifest(client as unknown as ReadOnlyCatalogClient, manifest);
      expect(diff.ok).toBe(false);
      expect(diff.columnProblems).toContainEqual(
        expect.objectContaining({ table: "services", column: "category", kind: "missing" }),
      );
    });
  });

  it("fails closed on a column data type mismatch", async () => {
    await withTxn(async () => {
      const manifest = await manifestNow();
      await client.query("ALTER TABLE services ALTER COLUMN name TYPE varchar(64)");
      const diff = await comparePublicSchemaToManifest(client as unknown as ReadOnlyCatalogClient, manifest);
      expect(diff.ok).toBe(false);
      expect(diff.columnProblems).toContainEqual(
        expect.objectContaining({ table: "services", column: "name", kind: "signature_mismatch" }),
      );
    });
  });

  it("fails closed on a column nullability mismatch", async () => {
    await withTxn(async () => {
      const manifest = await manifestNow();
      await client.query("ALTER TABLE services ALTER COLUMN name DROP NOT NULL");
      const diff = await comparePublicSchemaToManifest(client as unknown as ReadOnlyCatalogClient, manifest);
      expect(diff.ok).toBe(false);
      expect(diff.columnProblems).toContainEqual(
        expect.objectContaining({ table: "services", column: "name", kind: "signature_mismatch" }),
      );
    });
  });

  it("fails closed when a UNIQUE constraint is missing", async () => {
    await withTxn(async () => {
      const manifest = await manifestNow();
      await client.query("ALTER TABLE service_materials DROP CONSTRAINT service_materials_uniq");
      const diff = await comparePublicSchemaToManifest(client as unknown as ReadOnlyCatalogClient, manifest);
      expect(diff.ok).toBe(false);
      expect(diff.missingConstraints.some((entry) => entry.startsWith("service_materials|"))).toBe(true);
    });
  });

  it("fails closed when a FOREIGN KEY constraint is missing", async () => {
    await withTxn(async () => {
      const manifest = await manifestNow();
      await client.query("ALTER TABLE visits DROP CONSTRAINT visits_planned_visit_id_fkey");
      const diff = await comparePublicSchemaToManifest(client as unknown as ReadOnlyCatalogClient, manifest);
      expect(diff.ok).toBe(false);
      expect(diff.missingConstraints.some((entry) => entry.startsWith("visits|FOREIGN KEY"))).toBe(true);
    });
  });

  it("fails closed when a CHECK constraint is missing", async () => {
    await withTxn(async () => {
      const manifest = await manifestNow();
      await client.query("ALTER TABLE messages DROP CONSTRAINT messages_kind_check");
      const diff = await comparePublicSchemaToManifest(client as unknown as ReadOnlyCatalogClient, manifest);
      expect(diff.ok).toBe(false);
      expect(diff.missingConstraints.some((entry) => entry.startsWith("messages|CHECK"))).toBe(true);
    });
  });

  it("fails closed when a required baseline index is missing", async () => {
    await withTxn(async () => {
      const manifest = await manifestNow();
      await client.query("DROP INDEX patients_name_idx");
      const diff = await comparePublicSchemaToManifest(client as unknown as ReadOnlyCatalogClient, manifest);
      expect(diff.ok).toBe(false);
      expect(diff.missingIndexes.some((entry) => entry.includes("patients_name_idx"))).toBe(true);
    });
  });

  it("fails closed when a required baseline trigger is missing", async () => {
    await withTxn(async () => {
      const manifest = await manifestNow();
      await client.query("DROP TRIGGER audit_log_no_update ON audit_log");
      const diff = await comparePublicSchemaToManifest(client as unknown as ReadOnlyCatalogClient, manifest);
      expect(diff.ok).toBe(false);
      expect(diff.missingTriggers.some((entry) => entry.includes("audit_log_no_update"))).toBe(true);
    });
  });

  it("passes when production has extra objects beyond the baseline (expected ⊆ actual)", async () => {
    await withTxn(async () => {
      const manifest = await manifestNow();
      await client.query("CREATE TABLE manifest_extra_probe (id INTEGER PRIMARY KEY)");
      await client.query("CREATE INDEX manifest_extra_probe_idx ON manifest_extra_probe (id)");
      const diff = await comparePublicSchemaToManifest(client as unknown as ReadOnlyCatalogClient, manifest);
      expect(diff.ok).toBe(true);
      expect(diff.missingTables).toEqual([]);
      expect(diff.missingIndexes).toEqual([]);
    });
  });

  it("fingerprint is deterministic across repeated projections", async () => {
    const first = await manifestNow();
    const second = await manifestNow();
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.checked).toEqual(first.checked);
    expect(second.tables).toEqual(first.tables);
    expect(second.columns).toEqual(first.columns);
    expect(second.constraints).toEqual(first.constraints);
    expect(second.indexes).toEqual(first.indexes);
    expect(second.triggers).toEqual(first.triggers);
  });

  it("baseline SQL SHA-256 changes when the baseline file content changes", async () => {
    const original = await manifestNow();
    const tampered = await manifestNow(`${baselineSql}\n-- tampered probe\n`);
    expect(tampered.baselineSqlSha256).not.toBe(original.baselineSqlSha256);
    // نفس النص ⇒ نفس البصمة (حتمية) والبصمة المخططية لا تتأثر ببصمة SQL.
    const originalAgain = await manifestNow();
    expect(originalAgain.baselineSqlSha256).toBe(original.baselineSqlSha256);
    expect(originalAgain.fingerprint).toBe(original.fingerprint);
  });
});
