#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { decideTls } from "../lib/db-tls";
import { manifestFromProjection, projectSchemaReadOnly } from "../lib/schema-manifest";

function outputPath(): string {
  const index = process.argv.indexOf("--output");
  if (index >= 0 && process.argv[index + 1]) return path.resolve(process.argv[index + 1]);
  return path.resolve("baseline-schema-manifest.json");
}

function safeProbeSchema(): string {
  return `aqlan_manifest_${process.pid}_${Date.now().toString(36)}`.toLowerCase();
}

async function main(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || "";
  if (!url) throw new Error("TEST_DATABASE_URL أو DATABASE_URL مطلوب لتوليد manifest على PostgreSQL حقيقي.");
  if (process.env.DATABASE_ENVIRONMENT === "production" || process.env.NODE_ENV === "production") {
    throw new Error("توليد baseline manifest مرفوض في سياق production — استخدم قاعدة CI/اختبار معزولة فقط.");
  }

  const baselinePath = path.resolve("migrations/0001_baseline_schema.sql");
  const baselineSql = await readFile(baselinePath, "utf8");
  const tls = decideTls(url, { productionRuntime: false });
  const client = new Client({ connectionString: url, ssl: tls.ssl });
  await client.connect();

  const schema = safeProbeSchema();
  try {
    const { rows: versionRows } = await client.query<{ server_version: string; server_version_num: string }>(
      "SELECT current_setting('server_version') AS server_version, current_setting('server_version_num') AS server_version_num",
    );
    const version = versionRows[0]?.server_version ?? "unknown";
    const versionNum = Number(versionRows[0]?.server_version_num ?? 0);
    const major = Math.floor(versionNum / 10_000);
    if (major !== 18) {
      throw new Error(`baseline manifest يجب أن يُولَّد على PostgreSQL 18؛ الخادم الحالي ${version}.`);
    }

    await client.query("BEGIN");
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      await client.query(baselineSql);
      await client.query("SET LOCAL search_path TO public");

      const projection = await projectSchemaReadOnly(client, schema, [schema]);
      const manifest = manifestFromProjection(projection, {
        baselineSql,
        postgresMajor: major,
        postgresVersion: version,
      });
      const output = outputPath();
      await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      console.log(
        `baseline manifest generated: pg=${manifest.postgresVersion} tables=${manifest.checked.tables} `
        + `columns=${manifest.checked.columns} constraints=${manifest.checked.constraints} `
        + `indexes=${manifest.checked.indexes} triggers=${manifest.checked.triggers} `
        + `fingerprint=${manifest.fingerprint}`,
      );
      console.log(`output=${output}`);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
