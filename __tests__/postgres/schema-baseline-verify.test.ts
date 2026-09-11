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

  it("fails closed when a baseline object is removed inside an isolated transaction, and restores after rollback", async () => {
    await client.query("BEGIN");
    try {
      // هدف آمن: CHECK constraint مستقل لا تعتمد عليه كائنات أخرى.
      const { rows } = await client.query<{ tbl: string; conname: string }>(
        `SELECT conrelid::regclass::text AS tbl, conname
           FROM pg_constraint
          WHERE contype = 'c' AND connamespace = 'public'::regnamespace
          ORDER BY conname
          LIMIT 1`,
      );
      expect(rows).toHaveLength(1);
      const tableName = rows[0].tbl.replace(/^public\./, "").replace(/"/g, '""');
      const constraintName = rows[0].conname.replace(/"/g, '""');
      await client.query(
        `ALTER TABLE public."${tableName}" DROP CONSTRAINT "${constraintName}"`,
      );

      const drifted = await verifySchemaBaseline(client as unknown as DbPool);
      expect(drifted.compatible).toBe(false);
      expect(drifted.missingConstraints).toBe(1);
      expect(drifted.samples.missingConstraints.length).toBeGreaterThan(0);
    } finally {
      // المعاملة معزولة: الإسقاط لا يبقى في القاعدة.
      await client.query("ROLLBACK");
    }

    // بعد ROLLBACK: القاعدة سليمة والتحقّق يعود compatible=true.
    const restored = await verifySchemaBaseline(client as unknown as DbPool);
    expect(restored.compatible).toBe(true);
    expect(restored.missingConstraints).toBe(0);
  });

  it("tolerates extra runtime objects — expected ⊆ actual stays compatible", async () => {
    await client.query("BEGIN");
    try {
      // كائنات زائدة (تاريخيًّا من ensureSchema) لا تُفشل خط الأساس.
      await client.query(
        "CREATE TABLE public.__pr20_extra_probe (id integer PRIMARY KEY)",
      );

      const result = await verifySchemaBaseline(client as unknown as DbPool);
      expect(result.compatible).toBe(true);
      expect(result.missingTables).toBe(0);
      expect(result.columnProblems).toBe(0);
      expect(result.missingConstraints).toBe(0);
      expect(result.missingIndexes).toBe(0);
      expect(result.missingTriggers).toBe(0);
    } finally {
      await client.query("ROLLBACK");
    }

    const after = await verifySchemaBaseline(client as unknown as DbPool);
    expect(after.compatible).toBe(true);
  });

  it("proves the verification runtime issues SELECT statements only against real PG18", async () => {
    const recorded: string[] = [];
    const realQuery = client.query.bind(client);
    const probeClient = {
      query: (sql: string, values?: unknown[]) => {
        recorded.push(sql);
        return realQuery(sql, values as never[]);
      },
    } as unknown as DbPool;

    const result = await verifySchemaBaseline(probeClient);

    expect(result.compatible).toBe(true);
    expect(recorded).toHaveLength(5); // 5 استعلامات كتالوج فقط، لا شيء غيرها
    for (const statement of recorded) {
      expect(statement.trim()).toMatch(/^SELECT\b/i);
    }
    expect(recorded.join("\n")).not.toMatch(
      /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|SET|LOCK|GRANT|REVOKE|COMMENT|DO|CALL)\b/i,
    );
  });
});
