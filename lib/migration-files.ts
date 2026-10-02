import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Filesystem-only provenance shared by migration execution and read-only preflight.
// No database, runtime initialization, or baseline-probe imports.
export interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}


export const BASELINE_VERSION = "0001";

const MIGRATION_FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** مجلد الهجرات مشتق من موقع هذا الملف (lib/ → ../migrations) لا من cwd. */
export function defaultMigrationsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
}


export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/**
 * يقرأ ملفات الهجرات ويفرض الصيغة والترتيب الحتمي.
 * ملف باسم مخالف أو نسخة مكررة ⇒ خطأ فوري — القائمة إما نظيفة أو لا شيء.
 */
export async function loadMigrationFiles(dir?: string): Promise<MigrationFile[]> {
  const resolved = dir ?? defaultMigrationsDir();
  const entries = await readdir(resolved);
  const files: MigrationFile[] = [];
  for (const filename of entries) {
    const match = MIGRATION_FILENAME_PATTERN.exec(filename);
    if (!match) continue;
    if (filename.startsWith(".")) continue;
    const sql = await readFile(path.join(resolved, filename), "utf8");
    files.push({
      version: match[1],
      name: match[2],
      filename,
      sql,
      checksum: checksumOf(sql),
    });
  }
  files.sort((a, b) => a.version.localeCompare(b.version));
  if (files.length === 0) {
    throw new Error(`لا توجد ملفات هجرات صالحة في ${resolved} — النظام يرفض التشغيل بلا مصدر مخطط.`);
  }
  if (files[0].version !== BASELINE_VERSION) {
    throw new Error(`أول هجرة يجب أن تكون خط الأساس ${BASELINE_VERSION} — وُجد ${files[0].version}.`);
  }
  const versions = new Set(files.map((file) => file.version));
  if (versions.size !== files.length) {
    throw new Error("إصدارات هجرات مكررة — الترتيب الحتمي مكسور.");
  }
  return files;
}
