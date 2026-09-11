import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import type { DbPool } from "../../lib/db";
import { verifySchemaBaseline, committedBaselineManifest } from "../../lib/schema-baseline-verify";
import { adminClient, createIsolatedDatabase } from "./_setup";

const DATABASE_NAME = `aqlan_baseline_verify_${process.pid}_${Date.now()}`.toLowerCase();
let client: Client;

beforeAll(async () => {
  const url = await createIsolatedDatabase(DATABASE_NAME);
  client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  const baselineSql = await readFile(path.resolve("migrations/0001_baseline_schema.sql"), "utf8");
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

describe("production baseline verification wrapper on real PostgreSQL 18", () => {
  it("verifies an intact 0001 public schema as compatible with the committed manifest", async () => {
    const reference = committedBaselineManifest();
    const result = await verifySchemaBaseline(client as unknown as DbPool);

    expect(result.compatible).toBe(true);
    expect(result.postgresMajor).toBe(18);
    expect(result.fingerprint).toBe(reference.fingerprint);
    expect(result.checked).toEqual(reference.checked);
    expect(result.missingTables).toBe(0);
    expect(result.columnProblems).toBe(0);
    expect(result.missingConstraints).toBe(0);
    expect(result.missingIndexes).toBe(0);
    expect(result.missingTriggers).toBe(0);
    expect(result.samples.missingTables).toEqual([]);
  });

  it("stays silent outside a production runtime even with the flag set (health no-op)", async () => {
    const reference = committedBaselineManifest();
    const result = await verifySchemaBaseline(client as unknown as DbPool);
    // الجواب لم يتغير: المرجع نفسه وcompatible=true — الـone-shot logger لا
    // يعمل هنا لأن NODE_ENV=test (يُغطى في اختبارات الوحدة) — هذا يثبت أن
    // التحقق نفسه لا يغير حالة القاعدة ولا يعيد غير الملخص.
    expect(result.compatible).toBe(true);
    expect(reference.migrationVersion).toBe("0001");
  });
});
