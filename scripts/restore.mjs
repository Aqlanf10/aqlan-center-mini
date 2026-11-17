#!/usr/bin/env node
// Temporary fail-closed policy: this legacy importer cannot prove that an
// initialized target is empty before connecting. Refuse even a fresh target.
// Keep its implementation below for compatibility review; no argument or
// environment variable enables it. Full-archive restore is a separate path.
const RAW_RESTORE_TEMPORARILY_DISABLED = true;
if (RAW_RESTORE_TEMPORARILY_DISABLED) {
  console.error("الاستعادة من SQL الخام معطّلة مؤقتًا؛ لم يُقرأ ملف النسخة ولم يُفتح اتصال بالهدف.");
  process.exitCode = 2;
} else {

await import("./load-env.mjs");
const { readFileSync } = await import("node:fs");
const { Client } = await import("pg");
const { isCanonicalSourceSql, prepareBackupSql } = await import("../lib/restore/sql.mjs");
const { loadRestoreMigrationChecksums } = await import("../lib/restore/migration-provenance.mjs");
const { finalizeRestoredStaffIdentityInTransaction } = await import("../lib/staff-authority-lifecycle.mjs");
const { assertSafeLegacyRestoreTarget } = await import("./security/synthetic-restore-target-guard.mjs");

/**
 * استعادة نسخة احتياطية.
 *
 * على **قاعدة فارغة** فتحها البرنامج مرة واحدة فأنشأ جداولها. والملف بلا `TRUNCATE`
 * عمدًا، فاستعادته فوق بيانات موجودة تفشل باصطدام المفاتيح — وهو الفشل الصحيح: نسخةٌ
 * تمحو قبل أن تكتب تعني أن نقرة خاطئة تمحو يوم عمل كامل.
 *
 * تحذير: أول فتحٍ للبرنامج على القاعدة الفارغة يبذر أيضًا حسابات ودليل خدمات
 * افتراضيَّين بمعرّفات SERIAL تبدأ من ١ — وملف الاستعادة يحمل الصفوف الحقيقية بنفس
 * المعرّفات، فيصطدم إدراجها بمفتاح مكرّر. لذا يُشغَّل ذلك الفتح الأول (أو هذا السكربت
 * إن استدعى ensureSchema لاحقًا) بـ `SKIP_SEED=true` قبل تنفيذ ملف الاستعادة.
 *
 *   الاستعمال: SKIP_SEED=true DATABASE_URL=… node scripts/restore.mjs الملف.sql
 */

const file = process.argv[2];
const url = process.env.DATABASE_URL ?? "";
if (!file || !url.trim()) {
  console.error("الاستعمال: DATABASE_URL=… node scripts/restore.mjs الملف.sql");
  process.exit(1);
}

// As with full archive restore, schema ownership belongs to the target's
// bootstrap/migrator, not the source backup's historical registry snapshot.
// Application rows still use plain INSERT and reject an occupied target.
// Fail closed before reading/applying SQL or opening a connection.
let validatedTarget;
try {
  validatedTarget = assertSafeLegacyRestoreTarget(url, process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Legacy restore target refused.");
  process.exit(2);
}

let sql;
try {
  const text = readFileSync(file, "utf8");
  // Restore protocol R1: a canonical source needs the staged restore and its hold.
  if (isCanonicalSourceSql(text)) {
    console.error("هذه نسخة من قاعدة بهوية موحّدة. استعادتها تمر بالاستعادة المرحلية مع حجز الاستعادة، لا بهذا الأمر.");
    process.exit(2);
  }
  const prepared = prepareBackupSql(text, { inspectHistorical0079: true, migrationFiles: await loadRestoreMigrationChecksums() });
  if (prepared.historical0079) {
    throw new Error("Historical 0079 backup requires full archive restore to preserve its registry and timestamp.");
  }
  sql = prepared.dataSql;
} catch (error) {
  console.error(`الملف ناقص أو غير مدعوم: ${error.message}`);
  process.exit(1);
}

const client = new Client({ connectionString: validatedTarget.connectionString, ssl: false });
try {
  await client.connect();
  // Match the backup writer's quote escaping even on a differently configured server.
  await client.query("SET standard_conforming_strings = on");
  await client.query("BEGIN");
  await client.query(sql);
  await finalizeRestoredStaffIdentityInTransaction(client);
  await client.query("COMMIT");
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS tables FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  console.log(`تمت الاستعادة. الجداول: ${rows[0].tables}`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`فشلت الاستعادة: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
}
