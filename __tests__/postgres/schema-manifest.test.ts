import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import {
  comparePublicSchemaToManifest,
  manifestFromProjection,
  projectSchemaReadOnly,
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

describe("PostgreSQL 18 baseline schema manifest", () => {
  it("matches an intact 0001 schema and production comparison issues SELECT only", async () => {
    const { rows } = await client.query<{ server_version: string; server_version_num: string }>(
      "SELECT current_setting('server_version') AS server_version, current_setting('server_version_num') AS server_version_num",
    );
    const versionNum = Number(rows[0]?.server_version_num ?? 0);
    expect(Math.floor(versionNum / 10_000)).toBe(18);

    const projection = await projectSchemaReadOnly(client as unknown as ReadOnlyCatalogClient, "public", ["public"]);
    const manifest = manifestFromProjection(projection, {
      baselineSql,
      postgresMajor: 18,
      postgresVersion: rows[0]?.server_version ?? "unknown",
    });

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

  it("fails closed when a required baseline index is missing", async () => {
    const projection = await projectSchemaReadOnly(client as unknown as ReadOnlyCatalogClient, "public", ["public"]);
    const manifest = manifestFromProjection(projection, {
      baselineSql,
      postgresMajor: 18,
      postgresVersion: "18-test",
    });

    await client.query("DROP INDEX patients_name_idx");
    const diff = await comparePublicSchemaToManifest(client as unknown as ReadOnlyCatalogClient, manifest);

    expect(diff.ok).toBe(false);
    expect(diff.missingIndexes.some((entry) => entry.includes("patients_name_idx"))).toBe(true);
  });
});
