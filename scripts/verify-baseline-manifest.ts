#!/usr/bin/env node
/**
 * بوابة تحقق حتمية: الـmanifest الملتزم في المستودع هو المرجع الثابت.
 *
 * يولّد manifest طازجًا من `migrations/0001_baseline_schema.sql` على PostgreSQL 18
 * معزولة (schema مؤقتة تُراجع) — أو يقبل `--fresh <path>` لملف ولّده خطوة CI سابقة —
 * ثم يقارنه بالملف الملتزم `schema/baseline-schema-manifest.pg18.json`.
 *
 * أي اختلاف في المحتوى المخططي (الجداول/الأعمدة/القيود/الفهارس/المشغّلات/
 * البصمة/عدّادات الفحص/بصمة SQL) ⇒ فشل ب.exit 1. هذا يمنع تعديل 0001
 * (التاريخية immutable) من تغيير المرجع دون مراجعة صريحة تعيد توليد الملف.
 *
 * ملاحظة مقصودة: `postgresVersion` الكاملة توثيقية فقط ولا تُقارن بايت-ببايت —
 * ترقية patch لصورة CI (18.6→18.7 مثلاً) لا تغيّر أي كائن مخططي، وفشلها كان
 * سيُحدث ضجيجًا زائفًا. المطلوب الثابت: postgresMajor=18 والمحتوى المخططي.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { decideTls } from "../lib/db-tls";
import type { BaselineSchemaManifest } from "../lib/schema-manifest";
import { generateManifestOnTempSchema } from "./generate-baseline-manifest";

const COMMITTED_MANIFEST_PATH = "schema/baseline-schema-manifest.pg18.json";

function freshPathArg(): string | null {
  const index = process.argv.indexOf("--fresh");
  if (index >= 0 && process.argv[index + 1]) return path.resolve(process.argv[index + 1]);
  return null;
}

async function loadCommitted(): Promise<BaselineSchemaManifest> {
  const raw = await readFile(path.resolve(COMMITTED_MANIFEST_PATH), "utf8");
  const parsed = JSON.parse(raw) as BaselineSchemaManifest;
  if (parsed.format !== "aqlan-baseline-schema-manifest" || parsed.formatVersion !== 1) {
    throw new Error(`${COMMITTED_MANIFEST_PATH}: format غير مدعوم — الملف المرجعي تالف.`);
  }
  return parsed;
}

async function loadFresh(): Promise<BaselineSchemaManifest> {
  const freshFile = freshPathArg();
  if (freshFile) {
    const raw = await readFile(freshFile, "utf8");
    return JSON.parse(raw) as BaselineSchemaManifest;
  }
  const url = process.env.TEST_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || "";
  if (!url) {
    throw new Error("TEST_DATABASE_URL أو DATABASE_URL مطلوب (أو مرّر --fresh <path> لملف جاهز).");
  }
  const tls = decideTls(url, { productionRuntime: false });
  const client = new Client({ connectionString: url, ssl: tls.ssl });
  await client.connect();
  try {
    return await generateManifestOnTempSchema(client);
  } finally {
    await client.end().catch(() => {});
  }
}

interface DiffEntry { path: string; committed: string; fresh: string; }

function diffManifest(committed: BaselineSchemaManifest, fresh: BaselineSchemaManifest): DiffEntry[] {
  const diffs: DiffEntry[] = [];
  const push = (field: string, a: unknown, b: unknown): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      diffs.push({
        path: field,
        committed: JSON.stringify(a)?.slice(0, 120) ?? "(undefined)",
        fresh: JSON.stringify(b)?.slice(0, 120) ?? "(undefined)",
      });
    }
  };

  push("format", committed.format, fresh.format);
  push("formatVersion", committed.formatVersion, fresh.formatVersion);
  push("migrationVersion", committed.migrationVersion, fresh.migrationVersion);
  push("baselineSqlSha256", committed.baselineSqlSha256, fresh.baselineSqlSha256);
  push("postgresMajor", committed.postgresMajor, fresh.postgresMajor);
  push("fingerprint", committed.fingerprint, fresh.fingerprint);
  push("checked.tables", committed.checked.tables, fresh.checked.tables);
  push("checked.columns", committed.checked.columns, fresh.checked.columns);
  push("checked.constraints", committed.checked.constraints, fresh.checked.constraints);
  push("checked.indexes", committed.checked.indexes, fresh.checked.indexes);
  push("checked.triggers", committed.checked.triggers, fresh.checked.triggers);
  push("tables", committed.tables, fresh.tables);
  push("columns", committed.columns, fresh.columns);
  push("constraints", committed.constraints, fresh.constraints);
  push("indexes", committed.indexes, fresh.indexes);
  push("triggers", committed.triggers, fresh.triggers);
  return diffs;
}

async function main(): Promise<void> {
  if (process.env.DATABASE_ENVIRONMENT === "production" || process.env.NODE_ENV === "production") {
    throw new Error("تحقق baseline manifest (توليد fresh) مرفوض في سياق production — استخدم --fresh أو قاعدة CI معزولة.");
  }

  const [committed, fresh] = await Promise.all([loadCommitted(), loadFresh()]);

  if (fresh.postgresMajor !== 18) {
    throw new Error(`الـmanifest الطازج وُلّد على PostgreSQL ${fresh.postgresMajor} — المطلوب 18 حصرًا.`);
  }
  if (!String(committed.postgresVersion).startsWith(`${committed.postgresMajor}.`)) {
    throw new Error(
      `الملف الملتزم postgresVersion=${committed.postgresVersion} لا يطابق major=${committed.postgresMajor}.`,
    );
  }

  const diffs = diffManifest(committed, fresh);
  if (diffs.length > 0) {
    console.error(
      `BASELINE_MANIFEST_MISMATCH: الملف الملتزم ${COMMITTED_MANIFEST_PATH} لا يطابق توليد 0001 على PostgreSQL 18 `
      + `(${diffs.length} فرقًا). إن كان تعديل 0001 مقصودًا فأعد توليد الملف بـ `
      + "`npm run db:baseline:manifest` واعرِضه للمراجعة؛ وإلا فعدّل 0001 عن عمد ممنوع.",
    );
    for (const d of diffs) {
      console.error(`  - ${d.path}: committed=${d.committed} | fresh=${d.fresh}`);
    }
    process.exit(1);
  }

  console.log(
    `baseline manifest verify: OK — committed=${COMMITTED_MANIFEST_PATH} `
    + `fingerprint=${fresh.fingerprint} pg=${fresh.postgresVersion} `
    + `tables=${fresh.checked.tables} columns=${fresh.checked.columns} `
    + `constraints=${fresh.checked.constraints} indexes=${fresh.checked.indexes} triggers=${fresh.checked.triggers}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
