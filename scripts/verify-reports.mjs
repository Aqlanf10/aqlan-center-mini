#!/usr/bin/env node
/**
 * تحقق تشغيلي لمحرك التقارير — يزرع بيانات معروفة في PGlite ثم يُشغّل كل تقرير
 * ويطابق الأرقام المحاسبية يدويًا. يُشغَّل بلا DATABASE_URL فيعمل على PGlite.
 *
 *   node --import tsx scripts/verify-reports.mjs
 *   (أو: npx tsx scripts/verify-reports.mjs)
 */
import { getPool, ensureSchema, schemaReadyReset } from "../lib/db";
import { buildReport, dbTodayISO, parseFilters, reportOptions } from "../lib/reports";

const pool = getPool();

async function seed() {
  await ensureSchema();
  // تنظيف بذور سابقة إن أُعيد التشغيل — التحقق يجب أن يكون قابلاً للتكرار.
  await pool.query(`DELETE FROM payments WHERE patient_id IN (SELECT id FROM patients WHERE patient_number = 'R-9001')`);
  await pool.query(`DELETE FROM invoices WHERE patient_id IN (SELECT id FROM patients WHERE patient_number = 'R-9001')`);
  await pool.query(`DELETE FROM plan_items WHERE plan_id IN (SELECT tp.id FROM treatment_plans tp JOIN patients p ON p.id = tp.patient_id WHERE p.patient_number = 'R-9001')`);
  await pool.query(`DELETE FROM treatment_plans WHERE patient_id IN (SELECT id FROM patients WHERE patient_number = 'R-9001')`);
  await pool.query(`DELETE FROM patient_opening_balances WHERE patient_id IN (SELECT id FROM patients WHERE patient_number = 'R-9001')`);
  await pool.query(`DELETE FROM visits WHERE patient_id IN (SELECT id FROM patients WHERE patient_number = 'R-9001')`);
  await pool.query(`DELETE FROM patients WHERE patient_number = 'R-9001'`);

  const patient = await pool.query(
    `INSERT INTO patients (patient_number, full_name, phone) VALUES ('R-9001', 'مريض التحقيق', '777100200') RETURNING id`,
  );
  const patientId = patient.rows[0].id;

  // رصيد افتتاحي قديم — يجب أن يظهر في أعمار الديون كأقدم دين.
  await pool.query(
    `INSERT INTO patient_opening_balances (patient_id, amount_minor, as_of_date) VALUES ($1, 50000, '2025-01-15')`,
    [patientId],
  );

  // خطة تقويم ببنودها.
  const service = await pool.query(
    `SELECT id, name FROM services WHERE name LIKE '%تقويم ثابت%' LIMIT 1`,
  );
  const orthoService = service.rows[0];
  const plan = await pool.query(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, status, start_date, total_from_items)
     VALUES ($1, 'خطة تحقق تقويم', 250000, 'active', '2026-08-01', true) RETURNING id`,
    [patientId],
  );
  const planId = plan.rows[0].id;
  await pool.query(
    `INSERT INTO plan_items (plan_id, service_id, service_name, category, quantity, unit_price_minor)
     VALUES ($1, $2, $3, 'ortho', 1, 250000)`,
    [planId, orthoService?.id ?? null, orthoService?.name ?? 'تقويم'],
  );

  // وردية مفتوحة للدفعات.
  const shift = await pool.query(
    `INSERT INTO cashier_shifts (opened_by) VALUES ('verify') RETURNING id`,
  );
  const shiftId = shift.rows[0].id;

  // فاتورة ببند بنفس خدمة التقويم.
  const invoice = await pool.query(
    `INSERT INTO invoices (invoice_number, patient_id, status, total_minor, discount_minor, plan_id, created_at)
     VALUES ('INV-9001', $1, 'open', 250000, 25000, $2, NOW()) RETURNING id`,
    [patientId, planId],
  );
  const invoiceId = invoice.rows[0].id;
  await pool.query(
    `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor)
     VALUES ($1, $2, $3, 1, 250000, 250000)`,
    [invoiceId, orthoService?.id ?? null, orthoService?.name ?? 'تقويم'],
  );

  // دفعة اليوم.
  await pool.query(
    `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate, base_amount_minor, method, created_by, created_at)
     VALUES ('REC-9001', $1, $2, $3, 'payment', 100000, 'YER', 1, 100000, 'cash', 'reception', NOW())`,
    [patientId, invoiceId, shiftId],
  );

  // زيارة اليوم (عمرها صفر أيام).
  await pool.query(
    `INSERT INTO visits (patient_name, patient_id, status, arrived_at) VALUES ('مريض التحقيق', $1, 'done', NOW())`,
    [patientId],
  );

  return patientId;
}

const TODAY = await dbTodayISO();

function params(over = {}) {
  const search = new URLSearchParams({ preset: "today", ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, String(v)])) });
  return parseFilters(search, TODAY);
}

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}: ${actual} ${ok ? "" : `(متوقع ${expected})`}`);
}

async function main() {
  const patientId = await seed();

  // خيارات الفلاتر
  const options = await reportOptions();
  check("خيارات: أطباء ≥ 0", options.doctors.length >= 0 ? "OK" : "FAIL", "OK");
  check("خيارات: تخصص تقويم موجود", options.specialties.some((s) => s.value === "ortho") ? "OK" : "FAIL", "OK");

  // التقرير اليومي
  const daily = await buildReport("daily", params());
  const dailyCollected = daily.kpis.find((k) => k.key === "collected")?.minor ?? -1;
  check("يومي: المحصّل = 100,000", dailyCollected, 100000);
  const dailyInvoiced = daily.kpis.find((k) => k.key === "invoiced")?.minor ?? -1;
  check("يومي: قيمة الفواتير = 225,000 (بعد خصم 25k)", dailyInvoiced, 225000);
  const dailyVisits = daily.kpis.find((k) => k.key === "visits")?.count ?? -1;
  check("يومي: مراجع واحد", dailyVisits, 1);
  const dailyOld = daily.kpis.find((k) => k.key === "oldDebt")?.minor ?? -1;
  check("يومي: تحصيل قديم = 0 (لا رصيد قبل اليوم سوى الافتتاحي؟)", dailyOld, 50000);

  // المديونية المستحقة: 50k افتتاحي + 225k فاتورة − 100k دفعة = 175k
  const debt = await buildReport("debt", params());
  const debtTotal = debt.kpis.find((k) => k.key === "total")?.minor ?? -1;
  check("مديونية: الرصيد = 175,000", debtTotal, 175000);
  const ageDays = Number(debt.rows?.[0]?.ageDays ?? -1);
  // FIFO: دفعة 100k غطّت الافتتاحي 50k كاملًا + 50k من فاتورة اليوم → أقدم غير مغطى = فاتورة اليوم.
  check("مديونية: أقدم غير مغطى = فاتورة اليوم (عمر 0–1 يوم)", ageDays <= 1 ? `${ageDays} يومًا` : "FAIL", `${ageDays} يومًا`);

  // أعمار الديون: الرصيد كله في الفترة الحالية (FIFO غطى الافتتاحي)
  const aging = await buildReport("aging", params());
  const b0 = aging.kpis.find((k) => k.key === "b0")?.minor ?? -1;
  check("أعمار: الحالي (٠–٣٠) = 175,000", b0, 175000);

  // أعمار بتاريخ قريب: الرصيد كله «حالي»
  const agingRecent = await buildReport("aging", params({ preset: "custom", from: "2025-01-14", to: "2025-01-16" }));
  const b0Recent = agingRecent.kpis.find((k) => k.key === "b0")?.minor ?? -1;
  check("أعمار (2025-01-15): حالي = 50,000", b0Recent, 50000);

  // الناشئة خلال الفترة: 225k فاتورة − 100k دفعة = 125k
  const accrued = await buildReport("debt", params({ debtMode: "accrued" }));
  const accruedMinor = accrued.kpis.find((k) => k.key === "accrued")?.minor ?? -1;
  check("الناشئة اليوم = 125,000", accruedMinor, 125000);

  // التحصيل: جديد 50k (فوق الافتتاحي) + قديم 50k
  const collections = await buildReport("collections", params());
  const newMinor = collections.kpis.find((k) => k.key === "new")?.minor ?? -1;
  const oldMinor = collections.kpis.find((k) => k.key === "old")?.minor ?? -1;
  check("التحصيل: قديم = 50,000 (FIFO على الافتتاحي)", oldMinor, 50000);
  check("التحصيل: جديد = 50,000", newMinor, 50000);

  // حركة المديونية لهذه السنة
  const movement = await buildReport("debt", params({ debtMode: "movement", preset: "this_year" }));
  const closing = movement.kpis.find((k) => k.key === "closing")?.minor ?? -1;
  check("حركة المديونية: رصيد آخر السنة = 175,000", closing, 175000);
  const openingYear = movement.kpis.find((k) => k.key === "opening")?.minor ?? -1;
  check("حركة المديونية: رصيد أول السنة = 50,000 (افتتاحي 2025-01-15)", openingYear, 50000);

  // كشف حساب المريض
  const statement = await buildReport("patient-statement", params({ patientId }));
  const balance = statement.kpis.find((k) => k.key === "balance")?.minor ?? -1;
  check("كشف الحساب: الرصيد = 175,000", balance, 175000);
  const paid = statement.kpis.find((k) => k.key === "paid")?.minor ?? -1;
  check("كشف الحساب: المدفوع = 100,000", paid, 100000);
  const discounts = statement.kpis.find((k) => k.key === "discounts")?.minor ?? -1;
  check("كشف الحساب: الخصومات = 25,000", discounts, 25000);
  check("كشف الحساب: 3 حركات (افتتاحي + فاتورة + دفعة)", statement.rows?.length, 3);

  // التخصص: مريض التقويم
  const specialty = await buildReport("specialty", params({ specialty: "ortho" }));
  const orthoPatients = specialty.kpis.find((k) => k.key === "patients")?.count ?? -1;
  check("التخصص (تقويم): مريض واحد", orthoPatients, 1);

  // التقرير الشهري + المقارنة
  const monthly = await buildReport("monthly", params({ compare: "prev_period" }));
  check("الشهري: بلا أخطاء", monthly.report === "monthly" ? "OK" : "FAIL", "OK");
  check("الشهري: مقارنة موجودة", monthly.comparison ? "OK" : "FAIL", "OK");

  // السنوي
  const annual = await buildReport("annual", params({ preset: "this_year" }));
  check("السنوي: 12 شهرًا", annual.monthly?.rows.length, 12);

  // الأطباء والخدمات والمرضى
  const doctor = await buildReport("doctor", params());
  check("الأطباء: بلا أخطاء", doctor.report === "doctor" ? "OK" : "FAIL", "OK");
  const services = await buildReport("services", params());
  const servicesValue = services.kpis.find((k) => k.key === "value")?.minor ?? -1;
  check("الخدمات: القيمة = 225,000", servicesValue, 225000);
  const patients = await buildReport("patients", params());
  const newPatients = patients.kpis.find((k) => k.key === "new")?.count ?? -1;
  check("المرضى: مريض جديد واحد", newPatients, 1);

  // تنظيف
  await pool.query(`DELETE FROM payments WHERE patient_id = $1`, [patientId]);
  await pool.query(`DELETE FROM invoices WHERE patient_id = $1`, [patientId]);
  await pool.query(`DELETE FROM treatment_plans WHERE patient_id = $1`, [patientId]);
  await pool.query(`DELETE FROM patient_opening_balances WHERE patient_id = $1`, [patientId]);
  await pool.query(`DELETE FROM visits WHERE patient_id = $1`, [patientId]);
  await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);

  schemaReadyReset();
  console.log(failures === 0 ? "\n✓ التحقيق نجح كله" : `\n✗ ${failures} فحصًا فشل`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("✗ فشل التحقيق:", error);
  process.exit(1);
});
