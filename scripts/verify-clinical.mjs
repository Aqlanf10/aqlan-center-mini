#!/usr/bin/env node
import "./load-env.mjs";
import { Client } from "pg";

/**
 * هل الحلقة بين السريري والمالي متصلة فعلًا؟
 *
 * السؤال الذي يقرّر إن كان البرنامج نظامًا مترابطًا أم شاشات متجاورة: هل يولّد
 * توقيعُ الزيارة فاتورةً في كشف حساب المريض ويحدّث مخططه السني — **في معاملة
 * واحدة**؟ وهل تسقط كلها معًا إن فشل جزء؟
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

const temporary = `clinical_check_${Date.now()}`;
process.env.DATABASE_URL = withDatabase(source, temporary);
const admin = new Client({ connectionString: source, ssl: sslFor(source) });
let failed = false;
const check = (label, ok, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = true;
};

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${temporary}`);
  const db = await import("../lib/db.ts");
  await db.ensureSchema();

  const patient = await db.createPatient({
    fullName: "مريض الترابط", phone: null, altPhone: null, gender: "male",
    birthYear: null, address: null, medicalAlert: null, note: null,
  });
  const doctor = await db.createParty({
    name: "د. عقلان", kind: "doctor", phone: null, note: null, commissionPercent: 40,
  });
  const filling = await db.createService({ name: "حشوة ضوئية", category: "filling", priceMinor: 25000 });
  const consult = await db.createService({ name: "كشف", category: "consultation", priceMinor: 5000 });

  const visit = await db.addVisit({ patientName: patient.fullName, patientPhone: null, note: null });
  await db.getPool().query(`UPDATE visits SET patient_id = $1 WHERE id = $2`, [patient.id, visit.id]);

  await db.saveClinicalNotes({
    visitId: visit.id, chiefComplaint: "ألم في الضرس", examination: "تسوّس عميق",
    diagnosis: "تسوّس الرحى الأولى", treatmentDone: "حشوة ضوئية", nextPlan: "مراجعة بعد أسبوعين",
    doctorId: doctor.id,
  });
  await db.setVisitProcedures({
    visitId: visit.id,
    procedures: [
      { serviceId: filling.id, toothCode: 16, surfaces: "mo", quantity: 1, unitPriceMinor: 25000, doctorId: doctor.id, note: null },
      { serviceId: consult.id, toothCode: null, surfaces: null, quantity: 1, unitPriceMinor: 5000, doctorId: doctor.id, note: null },
    ],
  });

  const before = await db.getClinicalVisit(visit.id);
  check("قبل التوقيع: الزيارة مفتوحة", before.status === "open");
  check("قبل التوقيع: لا فاتورة", before.invoiceId === null);
  const chartBefore = await db.patientChart(patient.id);
  check("قبل التوقيع: المخطط فارغ", chartBefore.records.length === 0);
  const ledgerBefore = await db.patientLedger(patient.id);
  check("قبل التوقيع: لا فواتير في كشف الحساب", ledgerBefore.invoices.length === 0);

  console.log("\n  ── التوقيع ──");
  const result = await db.signClinicalVisit({
    visitId: visit.id, baseCurrency: "YER", signedBy: "د. عقلان",
  });
  check("التوقيع نجح", result.reason === null, result.reason ?? "");
  check("وُلّدت فاتورة", result.invoiceId !== null, `#${result.invoiceId}`);
  check("حُدّث المخطط", result.chartUpdates === 1, `${result.chartUpdates} سن`);

  const ledger = await db.patientLedger(patient.id);
  const invoice = ledger.invoices[0];
  check("الفاتورة في كشف حساب المريض", ledger.invoices.length === 1);
  check("مجموع الفاتورة = مجموع الزيارة", invoice?.totalMinor === 30000, `${invoice?.totalMinor}`);
  check("بنود الفاتورة = عدد الإجراءات", invoice?.items.length === 2);
  check("البند يذكر السن", invoice?.items.some((i) => i.description.includes("سن 16")) === true);
  check("عمولة الطبيب مربوطة بالبند", invoice?.items.some((i) => i.doctorId === doctor.id) === true);

  const chart = await db.patientChart(patient.id);
  const tooth = chart.chart.find(([code]) => code === 16)?.[1];
  check("السن 16 صار حشوةً منجَزة", tooth?.current?.condition === "filling" && tooth?.current?.stage === "completed");
  check("الأسطح انتقلت مرتّبة", tooth?.current?.surfaces === "MO", tooth?.current?.surfaces ?? "");
  check("الكشف لم يلمس المخطط", chart.records.length === 1);

  console.log("\n  ── الحماية ──");
  const again = await db.signClinicalVisit({ visitId: visit.id, baseCurrency: "YER", signedBy: "آخر" });
  check("توقيع ثانٍ مرفوض", again.reason === "already_signed");
  const ledgerAfter = await db.patientLedger(patient.id);
  check("لم تتولّد فاتورة ثانية", ledgerAfter.invoices.length === 1);

  const edited = await db.saveClinicalNotes({
    visitId: visit.id, chiefComplaint: "تغيير", examination: null, diagnosis: null,
    treatmentDone: null, nextPlan: null, doctorId: null,
  });
  check("تعديل الزيارة الموقَّعة مرفوض", edited === false);
  const proceduresEdited = await db.setVisitProcedures({ visitId: visit.id, procedures: [] });
  check("تعديل إجراءات الموقَّعة مرفوض", proceduresEdited === false);

  const added = await db.addVisitAddendum({ visitId: visit.id, text: "صُحّح السن إلى 26", author: "د. عقلان" });
  const withAddendum = await db.getClinicalVisit(visit.id);
  check("الملحق أُضيف", added && withAddendum.addendum?.includes("صُحّح السن") === true);
  check("الملحق يحمل كاتبه", withAddendum.addendum?.includes("د. عقلان") === true);
  check("التوثيق الأصلي باقٍ", withAddendum.diagnosis === "تسوّس الرحى الأولى");

  console.log("\n  ── المريض المشي: ملفٌ يُنشأ داخل المعاملة ──");
  const walkIn = await db.addVisit({ patientName: "مريض مشي", patientPhone: "770111222", note: null });
  await db.setVisitProcedures({
    visitId: walkIn.id,
    procedures: [{ serviceId: filling.id, toothCode: 36, surfaces: null, quantity: 1, unitPriceMinor: 25000, doctorId: doctor.id, note: null }],
  });
  const walkResult = await db.signClinicalVisit({ visitId: walkIn.id, baseCurrency: "YER", signedBy: "د. عقلان" });
  check("توقيع زيارة مريض مشي نجح", walkResult.reason === null, walkResult.reason ?? "");
  check("أُنشئ له ملف وفاتورة", walkResult.invoiceId !== null);
  const walkVisit = await db.getClinicalVisit(walkIn.id);
  check("الزيارة صارت مربوطة بالملف", walkVisit.patientId !== null);
  const walkChart = await db.patientChart(walkVisit.patientId);
  check("مخططه تحدّث كذلك", walkChart.records.length === 1);
  const rePhone = await db.duplicateCandidates({ fullName: "مريض مشي", phone: "967770111222", altPhone: null });
  check("رقمه حُفظ موحَّدًا فلا يتكرّر ملفه", rePhone.some((c) => c.id === walkVisit.patientId));

  console.log("\n  ── ذرّية المعاملة ──");
  // زيارة بإجراء يشير إلى خدمة محذوفة: الإدراج يفشل فيجب ألّا يبقى أثر.
  const visit2 = await db.addVisit({ patientName: patient.fullName, patientPhone: null, note: null });
  await db.getPool().query(`UPDATE visits SET patient_id = $1 WHERE id = $2`, [patient.id, visit2.id]);
  await db.setVisitProcedures({
    visitId: visit2.id,
    procedures: [{ serviceId: filling.id, toothCode: 26, surfaces: null, quantity: 1, unitPriceMinor: 25000, doctorId: doctor.id, note: null }],
  });
  // نكسر الرابط بجعل حالة السن مستحيلة (قيد المريض) — بحذف المريض من الزيارة بعد القراءة
  await db.getPool().query(`ALTER TABLE tooth_conditions ADD CONSTRAINT tmp_block CHECK (tooth_code <> 26)`);
  let threw = false;
  try {
    await db.signClinicalVisit({ visitId: visit2.id, baseCurrency: "YER", signedBy: "د. عقلان" });
  } catch { threw = true; }
  await db.getPool().query(`ALTER TABLE tooth_conditions DROP CONSTRAINT tmp_block`);
  const after2 = await db.getClinicalVisit(visit2.id);
  const ledger2 = await db.patientLedger(patient.id);
  check("فشل جزءٍ يُسقط المعاملة", threw);
  check("الزيارة بقيت غير موقَّعة", after2.status === "open");
  check("لم تبقَ فاتورة يتيمة", ledger2.invoices.length === 1, `${ledger2.invoices.length} فاتورة`);

  await db.getPool().end();
} catch (error) {
  console.error(`فشل: ${error.message}`);
  failed = true;
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${temporary}`).catch(() => {});
  await admin.end().catch(() => {});
}
console.log(failed ? "\nسقط الفحص." : "\nالحلقة متصلة: توقيعٌ واحد ← فاتورة ← مخطط، وكلها تسقط معًا.");
process.exit(failed ? 1 : 0);
