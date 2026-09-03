#!/usr/bin/env node
import "./load-env.mjs";
import { readFileSync } from "node:fs";
import { Client } from "pg";

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

const sql = readFileSync(file, "utf8");
if (!sql.includes("COMMIT;")) {
  console.error("الملف ناقص: لا يحمل خاتمة سليمة. لا تُستعاد منه قاعدة.");
  process.exit(1);
}

function sslFor(target) {
  const lowered = target.toLowerCase();
  if (lowered.includes("sslmode=disable")) return false;
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(lowered)) return false;
  return { rejectUnauthorized: false };
}

const client = new Client({ connectionString: url, ssl: sslFor(url) });
try {
  await client.connect();
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
