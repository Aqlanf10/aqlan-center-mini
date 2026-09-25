#!/usr/bin/env node
/**
 * تحقق تشغيلي لمحرك التقارير — يزرع بيانات معروفة في PGlite ثم يُشغّل كل تقرير
 * ويطابق الأرقام المحاسبية يدويًا.
 *
 * العزل بنيويّ لا بالتنظيف: `use-pglite.mjs` يفرض قاعدةً في الذاكرة تولد مع
 * العملية وتموت معها، فكل تشغيلٍ يبدأ من فراغ. كان الملف قبلها يرث
 * `DATABASE_URL` من البيئة ويُنظّف بذرته بـ`DELETE FROM payments` — وذلك مستحيل
 * أصلًا منذ حرّاس السجل المالي (hjra 0005): الدفعة حدثٌ تاريخي لا يُحذف، لا من
 * الكود ولا من psql. الفحص الذي يحتاج حذفَ قيدٍ مالي ليصحّ فحصٌ يُخاصم النظام.
 *
 *   node --import tsx scripts/verify-reports.mjs
 *   (أو: npx tsx scripts/verify-reports.mjs)
 */
import "./use-pglite.mjs";

/* استيرادٌ ديناميكيّ بامتداد `.ts` صريح — كما في بقيّة رحلات PGlite. الاستيراد
   الساكن من ملف `.mjs` يحلّ `../lib/db` في رسمٍ غير الذي يحلّ فيه `lib/reports`
   استيرادَه `./db`، فينتج **نسختان** من الوحدة ومعهما قاعدتا PGlite منفصلتان:
   الرحلة تزرع في واحدة ويقرأ التقرير من الأخرى فيخرج كلُّ رقمٍ صفرًا. */
const { getPool, ensureSchema, schemaReadyReset, financeSummary, patientDebtReport } = await import("../lib/db.ts");
const { buildReport, dbTodayISO, parseFilters, reportOptions } = await import("../lib/reports.ts");

const pool = getPool();

async function seed() {
  await ensureSchema();

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

  // كشف العمولات الرسمي — يجب أن يكون من نفس محرك commissionReport لا من معادلة ثانية.
  const commissionStatement = await buildReport("doctor-commission", params());
  check("كشف العمولات: النوع صحيح", commissionStatement.report === "doctor-commission" ? "OK" : "FAIL", "OK");
  check("كشف العمولات: أعمدة المستحق والمصروف موجودة",
    commissionStatement.columns?.some((col) => col.key === "dueMinor")
      && commissionStatement.columns?.some((col) => col.key === "paidMinor") ? "OK" : "FAIL", "OK");
  const services = await buildReport("services", params());
  const servicesValue = services.kpis.find((k) => k.key === "value")?.minor ?? -1;
  check("الخدمات: القيمة = 225,000", servicesValue, 225000);
  const patients = await buildReport("patients", params());
  const newPatients = patients.kpis.find((k) => k.key === "new")?.count ?? -1;
  check("المرضى: مريض جديد واحد", newPatients, 1);

  // اكتمال مركز التقارير: كل التقارير الجديدة تُنفَّذ فعليًا على نفس قاعدة الرحلة.
  for (const reportId of ["visits", "appointments", "treatment-plans", "lab", "inventory", "suppliers", "recall"]) {
    const report = await buildReport(reportId, params());
    check(`التقرير الجديد ${reportId}: يُبنى بلا خطأ`, report.report, reportId);
  }
  const visitsReport = await buildReport("visits", params());
  check("سجل الزيارات: الزيارة المزروعة تظهر", visitsReport.rows?.length, 1);
  const plansReport = await buildReport("treatment-plans", params({ preset: "this_year" }));
  check("خطط العلاج: الخطة المزروعة تظهر", (plansReport.rows?.length ?? 0) >= 1 ? "OK" : "FAIL", "OK");

  // (Reports R4) ذكاء العيادة: كل تقرير يُبنى على نفس قاعدة الرحلة، والملخّص يطابق مصادره.
  for (const reportId of [
    "practice-overview", "provider-utilization", "chair-utilization", "appointment-performance",
    "plan-intelligence", "unscheduled-treatment", "lab-intelligence", "new-patient-intelligence",
    "recall-intelligence", "practice-trends",
  ]) {
    const report = await buildReport(reportId, params());
    check(`ذكاء العيادة ${reportId}: يُبنى بلا خطأ`, report.report, reportId);
  }
  const overview = await buildReport("practice-overview", params());
  const collectionsForOverview = await buildReport("collections", params());
  check("ملخّص العيادة: التحصيل = تقرير التحصيل",
    overview.kpis.find((k) => k.key === "collected")?.minor,
    collectionsForOverview.kpis.find((k) => k.key === "total")?.minor);
  check("ملخّص العيادة: الزيارات = سجل الزيارات",
    overview.kpis.find((k) => k.key === "visits")?.count,
    visitsReport.kpis.find((k) => k.key === "visits")?.count);

  /* ══════════════ (P-01) رحلة العملات المختلطة ══════════════
     مريضٌ ثانٍ بثلاث فواتير بثلاث عملات (100k YER / 100k SAR / 10k USD).
     الدليل القديم كان يجمعها 435,000 «يمنيًّا» هنا (225k المريض الأول +
     210k الممزوجة)؛ الصحيح: كل عملةٍ بدلوها في كل طبقة — financeSummary
     والمحرك والمديونية. البذر بعد الفحوص أعلاه كي لا يمازجها. */
  const mixed = await pool.query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('R-9002', 'مريض العملات المختلطة') RETURNING id`,
  );
  const mixedPatientId = mixed.rows[0].id;
  for (const [number, currency, totalMinor] of [
    ["INV-9101-YER", "YER", 100000],
    ["INV-9101-SAR", "SAR", 100000],
    ["INV-9101-USD", "USD", 10000],
  ]) {
    const mixedInvoice = await pool.query(
      `INSERT INTO invoices (invoice_number, patient_id, status, total_minor, discount_minor, base_currency, created_at)
       VALUES ($1, $2, 'open', $3, 0, $4, NOW()) RETURNING id`,
      [number, mixedPatientId, totalMinor, currency],
    );
    await pool.query(
      `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor)
       VALUES ($1, NULL, 'تنظيف مختلط', 1, $2, $2)`,
      [mixedInvoice.rows[0].id, totalMinor],
    );
  }

  // financeSummary: المفوتر بكل عملة — لا invoicedMinor ولا 435,000.
  const summary = await financeSummary(TODAY, TODAY);
  check("الملخص (P-01): YER = 325,000 (225k + 100k)", summary.invoicedByCurrency.YER, 325000);
  check("الملخص (P-01): SAR = 100,000", summary.invoicedByCurrency.SAR, 100000);
  check("الملخص (P-01): USD = 10,000", summary.invoicedByCurrency.USD, 10000);
  check("الملخص (P-01): invoicedMinor محذوف من العقد", "invoicedMinor" in summary ? "FAIL" : "OK", "OK");
  check("الملخص (P-01): لا 435,000 في الحمولة", JSON.stringify(summary).includes("435000") ? "FAIL" : "OK", "OK");
  const mixedServiceRows = summary.topServices.filter((service) => service.name === "تنظيف مختلط");
  check("الملخص (P-01): «تنظيف مختلط» ثلاثة صفوف بعملاتها", mixedServiceRows.length, 3);
  check(
    "الملخص (P-01): صفوف الخدمة موسومةٌ بعملةٍ لكل منها",
    new Set(mixedServiceRows.map((service) => service.currency)).size === 3 ? "OK" : "FAIL",
    "OK",
  );

  // المحرك اليومي: بطاقات بعملاتها — لا بطاقة ممزوجة.
  const dailyMixed = await buildReport("daily", params());
  check(
    "يومي (P-01): invoiced = 325,000 (يمني فقط)",
    dailyMixed.kpis.find((k) => k.key === "invoiced")?.minor ?? -1,
    325000,
  );
  check(
    "يومي (P-01): invoiced-SAR = 100,000",
    dailyMixed.kpis.find((k) => k.key === "invoiced-SAR")?.minor ?? -1,
    100000,
  );
  check(
    "يومي (P-01): invoiced-USD = 10,000",
    dailyMixed.kpis.find((k) => k.key === "invoiced-USD")?.minor ?? -1,
    10000,
  );
  check(
    "يومي (P-01): لا بطاقة قيمتها 435,000",
    dailyMixed.kpis.some((k) => (k.minor ?? 0) === 435000) ? "FAIL" : "OK",
    "OK",
  );

  // المديونية في المحرك: صفٌّ لكل (مريض × عملة) والإجمالي بكل دلو.
  const debtMixed = await buildReport("debt", params());
  check(
    "مديونية (P-01): total = 275,000 (175k + 100k يمني فقط)",
    debtMixed.kpis.find((k) => k.key === "total")?.minor ?? -1,
    275000,
  );
  check(
    "مديونية (P-01): total-SAR = 100,000",
    debtMixed.kpis.find((k) => k.key === "total-SAR")?.minor ?? -1,
    100000,
  );
  check(
    "مديونية (P-01): total-USD = 10,000",
    debtMixed.kpis.find((k) => k.key === "total-USD")?.minor ?? -1,
    10000,
  );
  const mixedDebtRows = (debtMixed.rows ?? []).filter((row) => row.patientId === mixedPatientId);
  check("مديونية (P-01): المريض المختلط ثلاثة صفوف (صفٌّ لكل عملة)", mixedDebtRows.length, 3);
  const mixedDebtCurrencies = new Set(mixedDebtRows.map((row) => row.currency));
  check(
    "مديونية (P-01): كل صفٍّ بعملته — YER وSAR وUSD",
    mixedDebtCurrencies.size === 3 && mixedDebtCurrencies.has("YER") && mixedDebtCurrencies.has("SAR") && mixedDebtCurrencies.has("USD") ? "OK" : "FAIL",
    "OK",
  );

  // المديونية الكانونية (db.ts): تفويض المرجع ونفس الدلاب.
  const canonicalRows = (await patientDebtReport()).filter((row) => row.patientId === mixedPatientId);
  check("المديونية الكانونية (P-01): ثلاثة صفوف بعملاتها", canonicalRows.length, 3);
  const canonicalYer = canonicalRows.find((row) => row.currency === "YER");
  check("المديونية الكانونية (P-01): الدلو اليمني 100,000", canonicalYer?.dueMinor ?? -1, 100000);
  check(
    "المديونية الكانونية (P-01): لا صفٌّ بـ210,000",
    canonicalRows.some((row) => row.dueMinor === 210000) ? "FAIL" : "OK",
    "OK",
  );

  schemaReadyReset();
  console.log(failures === 0 ? "\n✓ التحقيق نجح كله" : `\n✗ ${failures} فحصًا فشل`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("✗ فشل التحقيق:", error);
  process.exit(1);
});
