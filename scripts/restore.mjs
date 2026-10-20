#!/usr/bin/env node
import "./load-env.mjs";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { prepareBackupSql } from "../lib/restore/sql.mjs";
import { assertSafeLegacyRestoreTarget } from "./security/synthetic-restore-target-guard.mjs";

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
  sql = prepareBackupSql(readFileSync(file, "utf8")).sql;
} catch (error) {
  console.error(`الملف ناقص أو غير مدعوم: ${error.message}`);
  process.exit(1);
}

function sslFor(target) {
  const lowered = target.toLowerCase();
  if (lowered.includes("sslmode=disable")) return false;
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(lowered)) return false;
  return { rejectUnauthorized: false };
}

// Never give pg unvalidated connection-string query parameters or TLS file options.
const client = new Client({ connectionString: validatedTarget.connectionString, ssl: false });
try {
  await client.connect();
  // Match the backup writer's quote escaping even on a differently configured server.
  await client.query("SET standard_conforming_strings = on");
  await client.query(sql);
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS tables FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  console.log(`تمت الاستعادة. الجداول: ${rows[0].tables}`);
} catch (error) {
  console.error(`فشلت الاستعادة: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
