#!/usr/bin/env node
import "./load-env.mjs";
import { Client } from "pg";

/**
 * مريضٌ واحد بسجلٍّ واحد — المبدأ الأول.
 *
 * العلّة التي وُجدت: المريض المسجَّل الذي يصل بلا رقم جوال كان يُنشأ له ملفٌ **ثانٍ**
 * عند التوقيع، لأن حلّ الملف يطابق بالهاتف وحده. فتذهب فاتورته ومخططه إلى ملفٍ غير
 * ملفّه، ويصير له تاريخان.
 *
 * والحلّ ليس مطابقةً بالاسم: «محمد أحمد» اسمُ رجلين، ودمجُ ملفَّي شخصين يخلط تاريخين
 * طبيّين — وهو أسوأ من تكرار ملفٍّ واحد يُدمج لاحقًا. فالربط قرارٌ بشري، والبرنامج
 * يعرض المرشّحين ولا يقرّر. وهذا الفحص يثبت الأمرين معًا: أن الربط يعمل، وأن
 * البرنامج **لا** يربط من تلقاء نفسه.
 */

const source = process.env.SOURCE_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
if (!source.trim()) { console.error("خطأ: SOURCE_DATABASE_URL غير مضبوط."); process.exit(1); }

const sslFor = (url) => {
  const l = url.toLowerCase();
  if (l.includes("sslmode=disable")) return false;
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(l)) return false;
  return { rejectUnauthorized: false };
};
const withDatabase = (url, name) => {
  const parsed = new URL(url); parsed.pathname = `/${name}`; return parsed.toString();
};

const temporary = `identity_check_${Date.now()}`;
process.env.DATABASE_URL = withDatabase(source, temporary);
const admin = new Client({ connectionString: source, ssl: sslFor(source) });
let failed = false;
const check = (label, ok, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = true;
};

const filesNamed = async (db, name) => {
  const { rows } = await db.getPool().query(
    `SELECT id, patient_number, phone FROM patients WHERE full_name = $1 ORDER BY id`, [name]);
  return rows;
};

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${temporary}`);
  const db = await import("../lib/db.ts");
  await db.ensureSchema();
  const consult = await db.createService({ name: "كشف", category: "consultation", priceMinor: 3000 });

  // إجراءٌ في كل زيارة: بلا إجراءٍ لا فاتورة، وسؤالُ هذا الفحص هو **إلى أيّ ملفٍّ
  // تذهب الفاتورة** — فزيارةٌ بلا فاتورة لا تجيب عنه.
  const notes = async (visitId) => {
    await db.saveClinicalNotes({
      visitId, chiefComplaint: null, examination: null,
      diagnosis: "كشف", treatmentDone: "كشف", nextPlan: null, doctorId: null,
    });
    await db.setVisitProcedures({
      visitId,
      procedures: [{
        serviceId: consult.id, toothCode: null, surfaces: null, quantity: 1,
        unitPriceMinor: consult.priceMinor, doctorId: null, note: null,
      }],
    });
  };

  console.log("\n  ── العلّة: الوصول بلا رقم كان يُنشئ ملفًّا ثانيًا ──");

  const name = "سعيد عبدالله القدسي";
  const file = await db.createPatient({
    fullName: name, phone: "770112233", altPhone: null, gender: "male",
    birthYear: null, address: null, medicalAlert: null, note: null,
  });

  // الاستقبال تختار ملفّه من القائمة — وهذا ما يمنع الملف الثاني.
  const linked = await db.addVisit({
    patientName: name, patientPhone: null, note: null, patientId: file.id,
  });
  check("الوصول باختيار الملف يربط الزيارة به", linked.patientId === file.id, `الملف ${linked.patientId}`);

  await notes(linked.id);
  const signedLinked = await db.signClinicalVisit({
    visitId: linked.id, baseCurrency: "YER", signedBy: "فحص",
  });
  check("وُقّعت الزيارة", signedLinked.reason === null);
  check("ولم يُنشأ ملفٌ ثانٍ", (await filesNamed(db, name)).length === 1,
    `${(await filesNamed(db, name)).length} ملف`);
  const ledger = await db.patientLedger(file.id);
  check("الفاتورة في ملفّه هو", ledger.invoices.length === 1);

  console.log("\n  ── الربط بعد الوصول: آخر فرصةٍ قبل التوقيع ──");

  const late = await db.addVisit({ patientName: name, patientPhone: null, note: null });
  check("الزيارة بلا ملف كما تصل من اللوحة", late.patientId === null);

  const link = await db.linkVisitToPatient(late.id, file.id);
  check("رُبطت بملفٍّ قائم", link.ok, link.ok ? link.patientName : link.message);

  await notes(late.id);
  const signedLate = await db.signClinicalVisit({
    visitId: late.id, baseCurrency: "YER", signedBy: "فحص",
  });
  check("وُقّعت", signedLate.reason === null);
  check("ولا يزال ملفًّا واحدًا", (await filesNamed(db, name)).length === 1,
    `${(await filesNamed(db, name)).length} ملف`);
  check("وفاتورتاه في ملفٍّ واحد", (await db.patientLedger(file.id)).invoices.length === 2);

  const afterSign = await db.linkVisitToPatient(late.id, file.id);
  check("لا ربط بعد التوقيع", !afterSign.ok, afterSign.ok ? "" : afterSign.message);

  console.log("\n  ── ولا يربط البرنامج بالاسم من تلقاء نفسه ──");

  const walkIn = await db.addVisit({ patientName: name, patientPhone: null, note: null });
  await notes(walkIn.id);
  await db.signClinicalVisit({ visitId: walkIn.id, baseCurrency: "YER", signedBy: "فحص" });
  const files = await filesNamed(db, name);
  check("مريضٌ مشي بالاسم نفسه يُنشأ له ملفُّه", files.length === 2, `${files.length} ملف`);
  check("ولم يُدمج بملفِّ الآخر", files[1].id !== file.id,
    "دمج الاسم يخلط تاريخين طبيّين — والتكرار أهون");

  console.log("\n  ── والهاتف يظلّ يربط كما كان ──");

  const byPhone = await db.addVisit({
    patientName: "اسمٌ كُتب خطأً", patientPhone: "770112233", note: null,
  });
  await notes(byPhone.id);
  await db.signClinicalVisit({ visitId: byPhone.id, baseCurrency: "YER", signedBy: "فحص" });
  const resolved = await db.getClinicalVisit(byPhone.id);
  check("الرقم يجد الملف ولو أُخطئ الاسم", resolved.patientId === file.id, `الملف ${resolved.patientId}`);

  await db.getPool().end();
} catch (error) {
  console.error(`فشل: ${error.message}`);
  failed = true;
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${temporary}`).catch(() => {});
  await admin.end().catch(() => {});
}
console.log(failed
  ? "\nسقط الفحص."
  : "\nمريضٌ واحد بسجلٍّ واحد: يُربط بقرارٍ بشري، ولا يُدمج بالاسم صامتًا.");
process.exit(failed ? 1 : 0);
