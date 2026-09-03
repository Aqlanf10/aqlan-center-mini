#!/usr/bin/env node
import "./load-env.mjs";
import { Client } from "pg";
import { writeFileSync, statSync } from "node:fs";

/**
 * هل النسخة الاحتياطية تُستعاد فعلًا؟
 *
 * السؤال الوحيد الذي يهمّ في النسخ الاحتياطي — ولا يجيب عنه أي اختبار وحدة. نسخةٌ
 * تُؤخذ كل يوم ولا تُستعاد أسوأ من لا نسخة: الأولى تعطي طمأنينة كاذبة إلى يوم
 * الكارثة، والثانية على الأقل تُعرف.
 *
 * يأخذ نسخة من قاعدة، ويبني قاعدة مؤقتة بمخطط البرنامج نفسه، ويستعيد فيها، ثم يقارن
 * عدد صفوف كل جدول. ثم يحذف المؤقتة.
 *
 *   الاستعمال: SOURCE_DATABASE_URL=… npx tsx scripts/verify-backup.mjs
 */

const source = process.env.SOURCE_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
if (!source.trim()) { console.error("خطأ: SOURCE_DATABASE_URL غير مضبوط."); process.exit(1); }

function sslFor(url) {
  const lowered = url.toLowerCase();
  if (lowered.includes("sslmode=disable")) return false;
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(lowered)) return false;
  return { rejectUnauthorized: false };
}
const withDatabase = (url, name) => {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
};
async function counts(client) {
  const { rows: tables } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`,
  );
  const result = {};
  for (const { table_name: table } of tables) {
    const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM "${table}"`);
    result[table] = rows[0].n;
  }
  return result;
}

const temporary = `backup_check_${Date.now()}`;
const target = withDatabase(source, temporary);
// يُضبط **قبل** استيراد وحدة القاعدة: مجمّع الاتصالات يرتبط بأول رابط يراه.
process.env.DATABASE_URL = target;

const origin = new Client({ connectionString: source, ssl: sslFor(source) });
const admin = new Client({ connectionString: source, ssl: sslFor(source) });
let failed = false;

try {
  await origin.connect();
  const before = await counts(origin);

  const { backupSqlLines } = await import("../lib/db.ts");
  let sql = "";
  for await (const line of backupSqlLines(origin)) sql += line;
  const file = `/tmp/${temporary}.sql`;
  writeFileSync(file, sql, "utf8");
  console.log(`أُخذت النسخة: ${(statSync(file).size / 1024).toFixed(1)} كيلوبايت`);
  await origin.end();

  await admin.connect();
  await admin.query(`CREATE DATABASE ${temporary}`);

  // SKIP_SEED=true: يُنشئ الجداول فقط، بلا بذر المستخدمين/الخدمات/المخزون الافتراضي.
  // البذر يُدرج بمعرّفات SERIAL تبدأ من ١، ونسخة `sql` تحمل نفس المعرّفات من قاعدة
  // بُذرت بالطريقة نفسها — فيصطدم كل إدراج بمفتاح مكرّر لو بُذرت القاعدة المؤقتة أولًا.
  process.env.SKIP_SEED = "true";
  const { ensureSchema, getPool } = await import("../lib/db.ts");
  await ensureSchema();
  console.log("بُني المخطط في القاعدة المؤقتة كما يبنيه البرنامج في الإنتاج.");

  await getPool().query(sql);
  const after = await counts(getPool());
  await getPool().end();

  const tables = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  let mismatches = 0;
  let restored = 0;
  for (const table of tables) {
    const a = before[table] ?? -1;
    const b = after[table] ?? -1;
    restored += b > 0 ? b : 0;
    if (a !== b) { console.error(`  اختلاف: ${table} — الأصل ${a} والمستعاد ${b}`); mismatches += 1; }
  }
  if (mismatches > 0) failed = true;
  else console.log(`تطابق كامل: ${tables.length} جدولًا، ${restored} صفًّا مستعادًا.`);

  // العدّادات: أهمّ ما يُنسى. بلا إعادة ضبطها تصطدم أول فاتورة جديدة برقم موجود.
  const check = new Client({ connectionString: target, ssl: sslFor(target) });
  await check.connect();
  const { rows } = await check.query(
    `SELECT last_value FROM patients_id_seq`,
  );
  const { rows: maxRows } = await check.query(`SELECT COALESCE(MAX(id),0) AS m FROM patients`);
  const ok = Number(rows[0].last_value) >= Number(maxRows[0].m);
  console.log(ok
    ? `العدّادات مضبوطة: عدّاد المرضى ${rows[0].last_value} ≥ أكبر رقم ${maxRows[0].m}.`
    : `خلل: عدّاد المرضى ${rows[0].last_value} أقل من أكبر رقم ${maxRows[0].m}.`);
  if (!ok) failed = true;
  await check.end();
} catch (error) {
  console.error(`فشل: ${error.message}`);
  failed = true;
} finally {
  await origin.end().catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${temporary}`).catch(() => {});
  await admin.end().catch(() => {});
}
process.exit(failed ? 1 : 0);
