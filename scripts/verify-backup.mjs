#!/usr/bin/env node
import "./load-env.mjs";
import { Client } from "pg";
import { writeFileSync, statSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * هل النسخة الاحتياطية تُستعاد فعلًا؟
 *
 * السؤال الوحيد الذي يهمّ في النسخ الاحتياطي — ولا يجيب عنه أي اختبار وحدة. نسخةٌ
 * تُؤخذ كل يوم ولا تُستعاد أسوأ من لا نسخة: الأولى تعطي طمأنينة كاذبة إلى يوم
 * الكارثة، والثانية على الأقل تُعرف.
 *
 * التمرين كله على قاعدتين مؤقتتين يبنيهما هذا الملف ويهدمهما، ولا يلمس قاعدةً
 * قائمة: كان يأخذ النسخة من أيّ قاعدةٍ يجدها في `SOURCE_DATABASE_URL` — فما يُثبته
 * يتغيّر بتغيّر ما صادف وجوده فيها، ويصير «مرّ» و«سقط» خبرًا عن الصدفة لا عن
 * النسخ. الآن:
 *
 *   ١) قاعدة مصدر مؤقتة، بمخطط البرنامج الحالي كما يبنيه في الإنتاج (ببذره).
 *   ٢) صفوفٌ معلومة تُزرع فيها — سريرية ومالية — فتتقدّم العدّادات معها.
 *   ٣) تُؤخذ النسخة.
 *   ٤) قاعدة استعادة مؤقتة ثانية، بالمخطط نفسه وبلا بذر (SKIP_SEED)، ثم تُستعاد.
 *   ٥) تُقارن مجموعة الجداول والصفوف — والاختلاف يُسمّى جدولًا جدولًا وبسببه.
 *   ٦) تُقارن العدّادات — فأول فاتورة بعد الاستعادة لا تصطدم برقمٍ موجود.
 *   ٧) تُهدم القاعدتان في finally مهما كانت النتيجة.
 *
 *   الاستعمال: SOURCE_DATABASE_URL=… npx tsx scripts/verify-backup.mjs
 *   (الرابط للخادم فقط — تُنشأ منه قاعدتان جديدتان ولا تُقرأ قاعدته)
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

/** أسماء فريدة: تشغيلان متوازيان (أو تشغيلٌ سابق مات) لا يتنازعان قاعدةً واحدة. */
const suffix = `${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
const sourceDb = `backup_src_${suffix}`;
const restoreDb = `backup_dst_${suffix}`;
const dumpFile = join(tmpdir(), `${restoreDb}.sql`);

let failed = false;
const check = (label, ok, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = true;
};

/** عدّ صفوف كل جدول أساسي في المخطط العام — مع تمييز «غائب» عن «صفر». */
async function tableCounts(client) {
  const { rows: tables } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`,
  );
  const result = new Map();
  for (const { table_name: table } of tables) {
    const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM "${table}"`);
    result.set(table, rows[0].n);
  }
  return result;
}

/** العدّادات التي يصطدم بها أول إدراجٍ بعد الاستعادة إن لم تُضبط. */
const SEQUENCES = [
  ["patients_id_seq", "patients"],
  ["visits_id_seq", "visits"],
  ["invoices_id_seq", "invoices"],
  ["payments_id_seq", "payments"],
  ["expenses_id_seq", "expenses"],
];

const admin = new Client({ connectionString: source, ssl: sslFor(source) });
let sourceClient = null;

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${sourceDb}`);
  await admin.query(`CREATE DATABASE ${restoreDb}`);

  /* ── ١+٢: قاعدة المصدر بمخطط البرنامج الحالي وببذره، ثم صفوفٌ معلومة ── */
  process.env.DATABASE_URL = withDatabase(source, sourceDb);
  const db = await import("../lib/db.ts");
  await db.ensureSchema();

  const patient = await db.createPatient({
    fullName: "مريض تمرين الاستعادة", phone: "770001122", altPhone: null,
    gender: "male", birthYear: 1990, address: null, medicalAlert: null, note: null,
  });
  const visit = await db.addVisit({
    patientName: patient.fullName, patientPhone: patient.phone, note: null, patientId: patient.id,
  });
  const invoice = await db.createInvoice({
    patientId: patient.id, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: "تمرين",
    items: [{ serviceId: null, doctorId: null, description: "كشف", quantity: 1, unitPriceMinor: 15000 }],
  });
  /* وردية مفتوحة: القبض والصرف لا يمرّان بلاها — وهذا حارسٌ مقصود لا عقبة. */
  const shift = await db.openShift({ openedBy: "تمرين", opening: { YER: 0, SAR: 0, USD: 0 } });
  const payment = await db.recordPayment({
    patientId: patient.id, invoiceId: invoice.id, kind: "payment",
    amountMinor: 5000, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
    method: "cash", note: null, createdBy: "تمرين",
  });
  const expense = await db.recordExpense({
    category: "other", partyId: null, payeeText: "نثريات التمرين",
    amountMinor: 700, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
    payableId: null, note: null, createdBy: "تمرين",
  });
  const gaps = [];
  if (patient == null) gaps.push("المريض");
  if (visit == null) gaps.push("الزيارة");
  if (invoice == null) gaps.push("الفاتورة");
  if (shift == null) gaps.push("الوردية");
  if (payment.payment == null) gaps.push(`الدفعة (${payment.reason ?? "؟"})`);
  if (expense.expense == null) gaps.push(`سند الصرف (${expense.reason ?? "؟"})`);
  check("قاعدة مصدر مؤقتة بمخطط البرنامج وصفوفٍ معلومة", gaps.length === 0, gaps.join("، "));

  /* ── ٣: النسخة ── */
  sourceClient = new Client({ connectionString: process.env.DATABASE_URL, ssl: sslFor(source) });
  await sourceClient.connect();
  const before = await tableCounts(sourceClient);
  let sql = "";
  for await (const line of db.backupSqlLines(sourceClient)) sql += line;
  writeFileSync(dumpFile, sql, "utf8");
  check("النسخة أُخذت", statSync(dumpFile).size > 0, `${(statSync(dumpFile).size / 1024).toFixed(1)} كيلوبايت`);
  const beforeSeq = new Map();
  for (const [sequence, table] of SEQUENCES) {
    const { rows } = await sourceClient.query(`SELECT COALESCE(MAX(id),0)::int AS m FROM "${table}"`);
    beforeSeq.set(sequence, rows[0].m);
  }
  await sourceClient.end();
  sourceClient = null;

  /* ── ٤: قاعدة الاستعادة — المخطط نفسه بلا بذر، ثم ملف النسخة فوقه ──
     SKIP_SEED=true: بلا بذرٍ يصطدم بصفوف النسخة نفسها. والبذر كله تحت حارسه في
     ensureSchema — وإدراجا مزوّد الذكاء الاصطناعي كانا فوقه فكانا يُسقطان هذا
     التمرين بـduplicate key على ai_providers_pkey. */
  await db.resetPoolForTesting();
  process.env.DATABASE_URL = withDatabase(source, restoreDb);
  process.env.SKIP_SEED = "true";
  await db.ensureSchema();
  await db.getPool().query(sql);
  const after = await tableCounts(db.getPool());

  /* ── ٥: المقارنة — والاختلاف يُسمّى بسببه لا برقمٍ مبهم ── */
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const missingFromRestored = [];
  const missingFromSource = [];
  const countMismatch = [];
  let restoredRows = 0;
  for (const table of names) {
    const inSource = before.has(table);
    const inRestored = after.has(table);
    if (inRestored) restoredRows += after.get(table);
    if (inSource && !inRestored) { missingFromRestored.push(`${table} (${before.get(table)} صفًّا في المصدر)`); continue; }
    if (!inSource && inRestored) { missingFromSource.push(`${table} (${after.get(table)} صفًّا في المستعادة)`); continue; }
    if (before.get(table) !== after.get(table)) {
      countMismatch.push(`${table}: المصدر ${before.get(table)} · المستعادة ${after.get(table)}`);
    }
  }
  check("كل جدولٍ في المصدر موجودٌ في المستعادة", missingFromRestored.length === 0,
    missingFromRestored.join("، "));
  check("ولا جدولَ في المستعادة بلا مقابلٍ في المصدر", missingFromSource.length === 0,
    missingFromSource.join("، "));
  check("عدد الصفوف متطابق في كل جدول", countMismatch.length === 0,
    countMismatch.join(" | ") || `${names.length} جدولًا · ${restoredRows} صفًّا`);

  /* المريض المزروع بعينه — لا عدّ صفوفٍ فقط: العدّ يتساوى ولو استُعيد غيرُ ما نُسخ. */
  const { rows: restoredPatient } = await db.getPool().query(
    `SELECT full_name, phone FROM patients WHERE id = $1`, [patient.id],
  );
  check("المريض المزروع عاد باسمه ورقمه", restoredPatient[0]?.full_name === patient.fullName
    && restoredPatient[0]?.phone === patient.phone);
  const { rows: restoredMoney } = await db.getPool().query(
    `SELECT (SELECT COALESCE(SUM(amount_minor),0)::int FROM payments) AS paid,
            (SELECT COALESCE(SUM(amount_minor),0)::int FROM expenses)  AS spent`,
  );
  check("والمال عاد بمقاديره", restoredMoney[0].paid === 5000 && restoredMoney[0].spent === 700,
    `مقبوض ${restoredMoney[0].paid} · مصروف ${restoredMoney[0].spent}`);

  /* ── ٦: العدّادات — أهمّ ما يُنسى ── */
  const badSequences = [];
  for (const [sequence, table] of SEQUENCES) {
    const { rows } = await db.getPool().query(
      `SELECT (SELECT last_value FROM "${sequence}")::int AS last,
              (SELECT COALESCE(MAX(id),0) FROM "${table}")::int AS max`,
    );
    if (rows[0].last < rows[0].max) badSequences.push(`${sequence}: ${rows[0].last} < ${rows[0].max}`);
    if (beforeSeq.get(sequence) !== rows[0].max) {
      badSequences.push(`${sequence}: أكبر رقمٍ اختلف — المصدر ${beforeSeq.get(sequence)} · المستعادة ${rows[0].max}`);
    }
  }
  check("العدّادات مضبوطة فوق أكبر رقمٍ مستعاد", badSequences.length === 0, badSequences.join(" | "));
  await db.resetPoolForTesting();
} catch (error) {
  console.error(`  ✗ سقط التمرين: ${error.message}`);
  failed = true;
} finally {
  await sourceClient?.end().catch(() => {});
  try { rmSync(dumpFile, { force: true }); } catch {}
  for (const name of [sourceDb, restoreDb]) {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    });
  }
  await admin.end().catch(() => {});
}

console.log(failed ? "\nالنتيجة: تمرين الاستعادة سقط." : "\nالنتيجة: النسخة تُستعاد كما أُخذت.");
process.exit(failed ? 1 : 0);
