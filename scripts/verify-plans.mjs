#!/usr/bin/env node
import "./load-env.mjs";
import { Client } from "pg";

/**
 * هل خطة العلاج اتفاقٌ حيّ أم ورقةٌ تُكتب وتُنسى؟
 *
 * أربعة أسئلة يقرّر جوابها ذلك، ولا يجيب عنها أي اختبار وحدة لأنها كلها عن سلوك
 * القاعدة تحت المعاملات:
 *
 * ١) هل يُشتقّ إجمالي الخطة من بنودها فلا يفترق رقمان لعملٍ واحد؟
 * ٢) هل تُقفل البنود بعد الموافقة فلا تُعدَّل الوثيقة التي وقّع عليها المريض؟
 * ٣) هل تنتقل البنود إلى المخطط السني حالاتٍ **مخطَّطة** — لا منجَزة؟
 * ٤) هل تشطب الزيارةُ الموقَّعة بنودَ الخطة التي نفّذتها، بلا أن تلمس غيرها؟
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

const temporary = `plans_check_${Date.now()}`;
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

  const today = "2026-09-01";
  const patient = await db.createPatient({
    fullName: "مريض الخطة", phone: null, altPhone: null, gender: "male",
    birthYear: null, address: null, medicalAlert: null, note: null,
  });
  const filling = await db.createService({ name: "حشوة ضوئية", category: "filling", priceMinor: 25000 });
  const crown = await db.createService({ name: "تاج خزفي", category: "crown", priceMinor: 120000 });
  const consult = await db.createService({ name: "كشف", category: "consultation", priceMinor: 5000 });

  console.log("\n  ── الإجمالي يُشتقّ من البنود ──");

  const planId = await db.createPlan({
    patientId: patient.id, title: "علاج ترميمي", totalMinor: 0, baseCurrency: "YER",
    startDate: today, note: null, createdBy: "فحص", installments: [],
  });
  check("أُنشئت خطة سريرية فارغة", Number.isInteger(planId), `رقم ${planId}`);

  const a = await db.addPlanItem({
    planId, serviceId: filling.id, serviceName: filling.name, category: "filling",
    toothCode: 16, surfaces: "om", quantity: 1, unitPriceMinor: filling.priceMinor, note: null,
  });
  const b = await db.addPlanItem({
    planId, serviceId: crown.id, serviceName: crown.name, category: "crown",
    toothCode: 26, surfaces: null, quantity: 1, unitPriceMinor: crown.priceMinor, note: null,
  });
  check("أُضيف بندان", a.ok && b.ok);
  check("الإجمالي = مجموع البنود", b.totalMinor === 145000, String(b.totalMinor));

  const drafted = await db.getPlan(planId, today);
  check("الأسطح انتقلت مرتّبة", drafted.items[0].surfaces === "MO", String(drafted.items[0].surfaces));
  check("الخطة مسوّدة بلا موافقة", drafted.consentAt === null);

  const badTooth = await db.addPlanItem({
    planId, serviceId: filling.id, serviceName: filling.name, category: "filling",
    toothCode: 99, surfaces: null, quantity: 1, unitPriceMinor: 1000, note: null,
  });
  check("سنٌّ خارج الترقيم مرفوض", !badTooth.ok);

  const removed = await db.removePlanItem(planId, drafted.items[1].id);
  const afterRemove = await db.getPlan(planId, today);
  check("حذف بندٍ قبل الموافقة يُعيد حساب الإجمالي", removed.ok && afterRemove.totalMinor === 25000,
    String(afterRemove.totalMinor));

  // يُعاد التاج ليكون في الخطة بندان.
  await db.addPlanItem({
    planId, serviceId: crown.id, serviceName: crown.name, category: "crown",
    toothCode: 26, surfaces: null, quantity: 1, unitPriceMinor: crown.priceMinor, note: null,
  });

  console.log("\n  ── الموافقة: من مسوّدة إلى اتفاق ──");

  const chartBefore = await db.patientChart(patient.id);
  check("المخطط فارغ قبل الموافقة", chartBefore.records.length === 0, `${chartBefore.records.length} سجل`);

  const consent = await db.recordPlanConsent({ planId, actor: "فحص", note: "توقيع ورقي بالملف" });
  check("سُجّلت الموافقة", consent.ok, `${consent.itemCount} بندًا`);

  const consented = await db.getPlan(planId, today);
  check("الموافقة محفوظة باسم من سجّلها", consented.consentBy === "فحص");
  check("إجمالي الاتفاق مُثبَّت", consented.totalMinor === 145000, String(consented.totalMinor));

  const chartAfter = await db.patientChart(patient.id);
  const planned = chartAfter.records.filter((record) => record.stage === "planned");
  check("البنود صارت على المخطط", planned.length === 2, `${planned.length} سجل`);
  check("وهي **مخطَّطة** لا منجَزة",
    chartAfter.records.every((record) => record.stage === "planned"));
  check("والأسنان هي أسنان الخطة",
    planned.map((record) => record.toothCode).sort((a, b) => a - b).join(",") === "16,26",
    planned.map((record) => record.toothCode).join(","));

  const twice = await db.recordPlanConsent({ planId, actor: "فحص", note: null });
  check("موافقة ثانية مرفوضة", !twice.ok, twice.ok ? "" : twice.message);

  const late = await db.addPlanItem({
    planId, serviceId: consult.id, serviceName: consult.name, category: "consultation",
    toothCode: null, surfaces: null, quantity: 1, unitPriceMinor: consult.priceMinor, note: null,
  });
  check("إضافة بندٍ بعد الموافقة مرفوضة", !late.ok, late.ok ? "" : late.message);

  const lateRemove = await db.removePlanItem(planId, consented.items[0].id);
  check("حذف بندٍ بعد الموافقة مرفوض", !lateRemove.ok);

  const stillTwo = await db.getPlan(planId, today);
  check("البنود لم تتغيّر", stillTwo.items.length === 2, `${stillTwo.items.length} بند`);

  console.log("\n  ── الأقساط بعد الموافقة لا قبلها ──");

  const scheduled = await db.schedulePlanInstallments({
    planId, count: 5, everyDays: 30, firstDueDate: today,
  });
  const withInstalments = await db.getPlan(planId, today);
  check("جُدولت الأقساط", scheduled.ok && withInstalments.installments.length === 5);
  check("مجموع الأقساط = الإجمالي",
    withInstalments.installments.reduce((sum, i) => sum + i.amountMinor, 0) === 145000);

  const twiceScheduled = await db.schedulePlanInstallments({
    planId, count: 3, everyDays: 30, firstDueDate: today,
  });
  check("جدولة ثانية مرفوضة", !twiceScheduled.ok);

  const draftPlan = await db.createPlan({
    patientId: patient.id, title: "خطة بلا موافقة", totalMinor: 0, baseCurrency: "YER",
    startDate: today, note: null, createdBy: "فحص", installments: [],
  });
  await db.addPlanItem({
    planId: draftPlan, serviceId: filling.id, serviceName: filling.name, category: "filling",
    toothCode: 36, surfaces: null, quantity: 1, unitPriceMinor: filling.priceMinor, note: null,
  });
  const early = await db.schedulePlanInstallments({
    planId: draftPlan, count: 3, everyDays: 30, firstDueDate: today,
  });
  check("لا جدولة قبل الموافقة", !early.ok, early.ok ? "" : early.message);

  console.log("\n  ── الزيارة تشطب بنود الخطة ──");

  const visit = await db.addVisit({ patientName: patient.fullName, patientPhone: null, note: null });
  await db.getPool().query(`UPDATE visits SET patient_id = $1 WHERE id = $2`, [patient.id, visit.id]);
  await db.saveClinicalNotes({
    visitId: visit.id, chiefComplaint: null, examination: null,
    diagnosis: "تسوّس", treatmentDone: "حشوة", nextPlan: null, doctorId: null,
  });
  await db.setVisitProcedures({
    visitId: visit.id,
    procedures: [{
      serviceId: filling.id, toothCode: 16, surfaces: "mo", quantity: 1,
      unitPriceMinor: filling.priceMinor, doctorId: null, note: null,
    }],
  });

  const preview = await db.getClinicalVisit(visit.id);
  check("الزيارة تعرف أنها تنفّذ بندًا من الخطة", preview.planItemsMatched === 1,
    `${preview.planItemsMatched} بند`);
  check("وتحذّر من الفوترة المزدوجة لأن للخطة أقساطًا",
    typeof preview.planWarning === "string" && preview.planWarning.includes("أقساط"));

  const signed = await db.signClinicalVisit({
    visitId: visit.id, baseCurrency: "YER", signedBy: "فحص",
  });
  check("وُقّعت الزيارة", signed.reason === null);
  check("شُطب بندٌ واحد", signed.planItemsDone === 1, `${signed.planItemsDone}`);

  const executed = await db.getPlan(planId, today);
  const done = executed.items.filter((item) => item.status === "done");
  check("البند المنفَّذ مربوطٌ بزيارته", done.length === 1 && done[0].visitId === visit.id);
  check("البند الآخر ما زال مخطَّطًا",
    executed.items.filter((item) => item.status === "planned").length === 1);
  check("تقدّم العلاج غير تقدّم الدفع",
    executed.itemsProgress.doneMinor === 25000 && executed.itemsProgress.remainingMinor === 120000,
    `${executed.itemsProgress.doneMinor} من ${executed.itemsProgress.totalMinor}`);
  check("بنود خطةٍ أخرى لم تُمسّ",
    (await db.getPlan(draftPlan, today)).items.every((item) => item.status === "planned"));

  const secondVisit = await db.addVisit({ patientName: patient.fullName, patientPhone: null, note: null });
  await db.getPool().query(`UPDATE visits SET patient_id = $1 WHERE id = $2`, [patient.id, secondVisit.id]);
  await db.saveClinicalNotes({
    visitId: secondVisit.id, chiefComplaint: null, examination: null,
    diagnosis: "متابعة", treatmentDone: "حشوة", nextPlan: null, doctorId: null,
  });
  await db.setVisitProcedures({
    visitId: secondVisit.id,
    procedures: [{
      serviceId: filling.id, toothCode: 16, surfaces: null, quantity: 1,
      unitPriceMinor: filling.priceMinor, doctorId: null, note: null,
    }],
  });
  const again = await db.signClinicalVisit({
    visitId: secondVisit.id, baseCurrency: "YER", signedBy: "فحص",
  });
  check("البند المنفَّذ لا يُشطب مرتين", again.planItemsDone === 0, `${again.planItemsDone}`);

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
  : "\nالخطة اتفاقٌ حيّ: بنودٌ تُسعّر، وموافقةٌ تُقفل، وزيارةٌ تشطب.");
process.exit(failed ? 1 : 0);
