#!/usr/bin/env node
/**
 * التحقق التشغيلي لرحلة المريض V2 — الرحلات الإلزامية (المواصفة §٥٠).
 *
 * يُزرع مريضٌ وخطةٌ متعددة الجلسات في PGlite ثم تُنفَّذ الرحلات الحقيقية بدوال
 * القاعدة نفسها التي تستعملها المسارات، وتُطابق الأرقام يدويًا:
 *
 *   الرحلة ١ — علاج بسيط: خطة ← زيارة ← توقيع ← فاتورة ← زيارة قادمة مقترحة.
 *   الرحلة ٢ — علاج متعدد الجلسات: RCT ثلاث جلسات بفوترة «لكل جلسة» ← نتيجة
 *              مالية واحدة صحيحة (١٠٠٠٠×٣) والبند «قيد التنفيذ» بعد الثانية.
 *   الرحلة ٦ — دفعة جزئية: فاتورة ٥٠٠٠٠ ← دفعة ٢٠٠٠٠ ← رصيد ٣٠٠٠٠ من الدفتر وحده.
 *   الرحلة ٧ — لا فوترة مزدوجة: التوقيع مرتين يُرفض، ولا سطر فاتورة بلا مصدر.
 *
 *   node --import tsx scripts/verify-workflow.mjs
 */
import {
  createPatient,
  createPlanV2,
  createService,
  ensureSchema,
  getClinicalVisit,
  getPool,
  patientLedger,
  patientWorkflow,
  recordPayment,
  recordPlanConsent,
  saveClinicalNotes,
  schedulePlannedVisit,
  setVisitProcedures,
  signClinicalVisit,
  startVisitFromPlannedVisit,
  listPatientPlannedVisits,
} from "../lib/db";

const pool = getPool();
const BASE = "YER";
const TODAY = new Date().toISOString().slice(0, 10);

let failed = false;
const check = (label, ok, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = true;
};

async function seed() {
  await ensureSchema();
  // وردية مفتوحة — القبض لا يمرّ بلاها.
  await pool.query(`UPDATE cashier_shifts SET status = 'closed', closed_at = NOW() WHERE status = 'open'`);
  await pool.query(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
     SELECT 'فحص', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`,
  );
}

const number = () => "WF-" + Date.now().toString().slice(-8);

async function signVisit(visitId) {
  return signClinicalVisit({ visitId, baseCurrency: BASE, signedBy: "فحص" });
}

/* ═══════════ الرحلة ٢ (الأصعب أولًا): RCT ثلاث جلسات بفوترة «لكل جلسة» ═══════════ */

async function journeyMultiSession() {
  console.log("\n── الرحلة ٢: علاج متعدد الجلسات — RCT 30,000 على ثلاث جلسات ──");

  const patient = await createPatient({
    fullName: "مريض العصب " + number(), phone: "77" + number(),
    altPhone: null, gender: "male", birthYear: 1990,
    address: null, medicalAlert: null, note: null,
  });
  const rct = await createService({ name: "علاج عصب " + number(), category: "rct", priceMinor: 30000 });

  const created = await createPlanV2({
    patientId: patient.id,
    title: "RCT 11 — ثلاث جلسات",
    specialty: "علاج عام",
    primaryDoctorId: null,
    billingMode: "per_procedure",
    baseCurrency: BASE,
    startDate: TODAY,
    note: null,
    createdBy: "فحص",
    items: [{
      serviceId: rct.id, serviceName: rct.name, category: "rct",
      toothCode: 11, surfaces: null, quantity: 1, unitPriceMinor: 30000,
      billingRule: "per_session", sessionCount: 3, note: null,
    }],
    installments: [],
  });
  check("أُنشئت الخطة بجلساتها في زرٍّ واحد", created.ok, `رقم ${created.planId}`);

  const consent = await recordPlanConsent({ planId: created.planId, actor: "فحص", note: "ورقي" });
  check("وُفِّقت الخطة فصارت اتفاقًا", consent.ok);

  const planned = await listPatientPlannedVisits(patient.id);
  check("وُلدت زيارة مخطَّطة لجلسات البند", planned.length === 1 && planned[0].durationMinutes === 90,
    `${planned.length} زيارة`);

  const sessions = await pool.query(
    `SELECT s.sequence, s.status FROM treatment_sessions s
       JOIN plan_items i ON i.id = s.plan_item_id WHERE i.plan_id = $1 ORDER BY s.sequence`,
    [created.planId],
  );
  check("ثلاث جلسات مخطَّطة للبند", sessions.rows.length === 3);
  check("جلسة رابعة مستحيلة — العدّد مقفول بالبنية", sessions.rows.every((row) => row.sequence <= 3));

  // ── الجلسة ١: من الزيارة المخطَّطة، الإجراء مربوط بالبند، والسعر من الخطة ──
  const started1 = await startVisitFromPlannedVisit({ plannedVisitId: planned[0].id, actor: "فحص" });
  check("بدأت الزيارة من الجلسة المخطَّطة", Boolean(started1) && "id" in started1);

  // محاولة تغيير السعر من الطلب: الخادم يفرض سعر الجلسة من الخطة.
  const saved = await setVisitProcedures({
    visitId: started1.id,
    procedures: [{
      serviceId: rct.id, toothCode: 11, surfaces: null, quantity: 1,
      unitPriceMinor: 999999, // سعر متلاعَب به — يجب أن يُتجاهل.
      doctorId: null, note: null, planItemId: await firstItemId(created.planId),
    }],
  });
  check("حُفظ الإجراء المرتبط بالبند", saved);

  const before1 = await getClinicalVisit(started1.id);
  check("السعر جاء من الخطة وفق قاعدة «لكل جلسة» لا من الطلب",
    before1.procedures[0].unitPriceMinor === 10000,
    `السعر ${before1.procedures[0].unitPriceMinor}`);

  await saveClinicalNotes({
    visitId: started1.id, chiefComplaint: "ألم", examination: null,
    diagnosis: "التهاب لب", treatmentDone: "فتح اللب", nextPlan: "تنظيف",
  });
  const signed1 = await signVisit(started1.id);
  check("وُقِّعت الجلسة الأولى وأصدرت فاتورة 10,000",
    signed1.reason === null && signed1.duesMinor === 10000 && signed1.invoiceId !== null);

  const item1 = await pool.query(
    `SELECT status FROM plan_items WHERE plan_id = $1`,
    [created.planId],
  );
  check("البند «قيد التنفيذ» لا «منفَّذ» — جلستان بقيتا", item1.rows[0].status === "in_progress");

  // ── الجلستان ٢ و٣: زيارتان مستقلتان من الإجراءات المتبقّية ──
  const planned2 = await listPatientPlannedVisits(patient.id);
  check("اقتُرحت الزيارة المخطَّطة التالية تلقائيًا", planned2.length >= 1, planned2[0]?.title ?? "");

  // الجلسة ٢: زيارةٌ حرّة بإجراءٍ مرتبطٍ بالبند نفسه.
  const visit2 = await pool.query(
    `INSERT INTO visits (patient_name, patient_phone, patient_id) VALUES ($1, $2, $3) RETURNING id`,
    [patient.fullName, patient.phone, patient.id],
  );
  const itemId = await firstItemId(created.planId);
  await setVisitProcedures({
    visitId: visit2.rows[0].id,
    procedures: [{
      serviceId: rct.id, toothCode: 11, surfaces: null, quantity: 1,
      unitPriceMinor: 0, doctorId: null, note: null, planItemId: itemId,
    }],
  });
  await saveClinicalNotes({
    visitId: visit2.rows[0].id, chiefComplaint: null, examination: null,
    diagnosis: "استكمال", treatmentDone: "تنظيف وتشكيل", nextPlan: "حشو",
  });
  const signed2 = await signVisit(visit2.rows[0].id);
  check("الجلسة الثانية فُوترت 10,000 — لا أكثر ولا أقل", signed2.duesMinor === 10000);

  const visit3 = await pool.query(
    `INSERT INTO visits (patient_name, patient_phone, patient_id) VALUES ($1, $2, $3) RETURNING id`,
    [patient.fullName, patient.phone, patient.id],
  );
  await setVisitProcedures({
    visitId: visit3.rows[0].id,
    procedures: [{
      serviceId: rct.id, toothCode: 11, surfaces: null, quantity: 1,
      unitPriceMinor: 0, doctorId: null, note: null, planItemId: itemId,
    }],
  });
  await saveClinicalNotes({
    visitId: visit3.rows[0].id, chiefComplaint: null, examination: null,
    diagnosis: "استكمال", treatmentDone: "حشو الجذور", nextPlan: "تاج لاحقًا",
  });
  const signed3 = await signVisit(visit3.rows[0].id);
  check("الجلسة الثالثة (الإكمال) فُوترت 10,000 — الفرق محمَّل عليها", signed3.duesMinor === 10000);

  const finalItem = await pool.query(
    `SELECT status, done_at FROM plan_items WHERE plan_id = $1`, [created.planId],
  );
  check("البند «مكتمل» بعد جلساته الثلاث", finalItem.rows[0].status === "done");

  const finalPlan = await pool.query(
    `SELECT status FROM treatment_plans WHERE id = $1`, [created.planId],
  );
  check("الخطة اكتملت من نفسها — لا أحد يتذكّر إغلاقها", finalPlan.rows[0].status === "completed");

  /* ── الرحلة ٧: لا فوترة مزدوجة ── */
  console.log("\n── الرحلة ٧: لا فوترة مزدوجة ──");
  const resigned = await signVisit(visit3.rows[0].id);
  check("التوقيع الثاني يُرفض", resigned.reason === "already_signed");

  const invoiceItems = await pool.query(
    `SELECT COUNT(*)::int AS n, COUNT(source_type)::int AS sourced, COUNT(DISTINCT source_id)::int AS distinct_sources
       FROM invoice_items WHERE invoice_id IN (
         SELECT id FROM invoices WHERE patient_id = $1
       )`,
    [patient.id],
  );
  check("سطور الفاتورة كلها مربوطة بمصدرها",
    invoiceItems.rows[0].n === invoiceItems.rows[0].sourced,
    `${invoiceItems.rows[0].n}/${invoiceItems.rows[0].sourced}`);
  check("لا مصدر فوترة مكرَّر — الفهرس الفريد يضمنها",
    invoiceItems.rows[0].n === invoiceItems.rows[0].distinct_sources);

  const invoices = await pool.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(total_minor), 0)::int AS total
       FROM invoices WHERE patient_id = $1`,
    [patient.id],
  );
  check("فاتورة واحدة لكل جلسة — ثلاث لا أكثر", invoices.rows[0].n === 3, `عدد ${invoices.rows[0].n}`);
  check("النتيجة المالية الواحدة الصحيحة: 30,000 بالضبط", invoices.rows[0].total === 30000,
    `الإجمالي ${invoices.rows[0].total}`);

  /* ── الرحلة ٦: دفعة جزئية ── */
  console.log("\n── الرحلة ٦: دفعة جزئية — الفاتورة 30,000 والرصيد من الدفتر ──");
  const payment = await recordPayment({
    patientId: patient.id, invoiceId: null, kind: "payment",
    amountMinor: 20000, currency: BASE, baseCurrency: BASE,
    exchangeRate: 1, method: "cash", note: null, createdBy: "فحص",
  });
  check("قُبضت دفعة 20,000 من نقطةٍ واحدة", payment.payment !== null);

  const ledger = await patientLedger(patient.id);
  const invoiced = ledger.invoices.reduce((sum, invoice) => sum + invoice.totalMinor, 0);
  const paid = ledger.payments.reduce((sum, row) => sum + row.baseAmountMinor, 0);
  check("المديونية = مفوتر − مدفوع = 10,000", invoiced - paid === 10000,
    `${invoiced} − ${paid}`);

  const summary = await patientWorkflow(patient.id, TODAY);
  check("ملخص الرحلة يفصل باقي العلاج عن المديونية",
    summary.financial.remainingTreatmentMinor === 0 && summary.financial.balanceMinor === 10000,
    `باقي علاج ${summary.financial.remainingTreatmentMinor} · دين ${summary.financial.balanceMinor}`);
  check("الخطة المكتملة خرجت من «العلاج الحيّ» — لا يبقى بندٌ بلا خطة جارية",
    summary.financial.agreedMinor === 0 && summary.financial.treatmentDoneMinor === 0);

  return patient;
}

/* ═══════════ الرحلة ١: علاج بسيط + جدولة الجلسة القادمة (§١١) ═══════════ */

async function journeySimple() {
  console.log("\n── الرحلة ١: علاج بسيط — من الخطة إلى الموعد بلا إعادة إدخال ──");

  const patient = await createPatient({
    fullName: "مريض بسيط " + number(), phone: "77" + number(),
    altPhone: null, gender: "female", birthYear: 1985,
    address: null, medicalAlert: null, note: null,
  });
  const consult = await createService({ name: "كشف " + number(), category: "consultation", priceMinor: 5000 });
  const filling = await createService({ name: "حشوة " + number(), category: "filling", priceMinor: 25000 });

  const created = await createPlanV2({
    patientId: patient.id,
    title: "خطة ترميمية بسيطة",
    specialty: "علاج عام",
    primaryDoctorId: null,
    billingMode: "per_procedure",
    baseCurrency: BASE,
    startDate: TODAY,
    note: null,
    createdBy: "فحص",
    items: [
      { serviceId: consult.id, serviceName: consult.name, category: "consultation",
        toothCode: null, surfaces: null, quantity: 1, unitPriceMinor: 5000,
        billingRule: "on_completion", sessionCount: 1, note: null },
      { serviceId: filling.id, serviceName: filling.name, category: "filling",
        toothCode: 14, surfaces: "mo", quantity: 1, unitPriceMinor: 25000,
        billingRule: "on_completion", sessionCount: 1, note: null },
    ],
    installments: [],
  });
  check("أُنشئت خطة البندين", created.ok);
  await recordPlanConsent({ planId: created.planId, actor: "فحص", note: "ورقي" });

  const planned = await listPatientPlannedVisits(patient.id);
  check("زيارتان مخطَّطتان — واحدة لكل بند", planned.length === 2, `عدد ${planned.length}`);

  const started = await startVisitFromPlannedVisit({ plannedVisitId: planned[0].id, actor: "فحص" });
  const alreadyActive = await startVisitFromPlannedVisit({ plannedVisitId: planned[0].id, actor: "فحص" });
  check("بدء الزيارة الثانية لنفس الجلسة يُرفض",
    Boolean(alreadyActive) && "alreadyActive" in alreadyActive);

  const itemId = await firstItemId(created.planId);
  await setVisitProcedures({
    visitId: started.id,
    procedures: [{
      serviceId: consult.id, toothCode: null, surfaces: null, quantity: 1,
      unitPriceMinor: 5000, doctorId: null, note: null, planItemId: itemId,
    }],
  });
  await saveClinicalNotes({
    visitId: started.id, chiefComplaint: "فحص دوري", examination: null,
    diagnosis: "تسوّس 14", treatmentDone: "كشف", nextPlan: "حشوة 14",
  });
  const signed = await signVisit(started.id);
  check("وُقِّعت الزيارة وفُوتر الكشف 5,000", signed.reason === null && signed.duesMinor === 5000);

  const plannedVisitState = await pool.query(
    `SELECT status, visit_id FROM planned_visits WHERE id = $1`, [planned[0].id],
  );
  check("الزيارة المخطَّطة أُغلقت «منجزة» وربُطت بزيارتها",
    plannedVisitState.rows[0].status === "completed" &&
    plannedVisitState.rows[0].visit_id === started.id);

  const appointmentsBefore = await pool.query(
    `SELECT COUNT(*)::int AS n FROM appointments WHERE patient_id = $1`, [patient.id],
  );
  // تحويل الزيارة المخطَّطة الثانية إلى موعد — تاريخٌ ووقت فقط (AC-11).
  const scheduled = await schedulePlannedVisit({
    plannedVisitId: planned[1].id, date: "2030-01-15", time: "16:00", chairs: 2,
  });
  check("الجلسة التالية تحوّلت موعدًا بتاريخٍ ووقت فقط", scheduled.ok,
    scheduled.ok ? `موعد ${scheduled.appointmentId}` : JSON.stringify(scheduled).slice(0, 80));

  const appointment = await pool.query(
    `SELECT note, planned_visit_id FROM appointments WHERE patient_id = $1`,
    [patient.id],
  );
  check("الموعد حمل عنوان الخطة بلا إعادة إدخال",
    appointment.rows.length === appointmentsBefore.rows[0].n + 1 &&
    appointment.rows[0].note.includes("من خطة العلاج"));

  const plannedAfter = await listPatientPlannedVisits(patient.id);
  check("الزيارة المخطَّطة صارت «مجدولة»", plannedAfter[0]?.status === "scheduled");

  const summary = await patientWorkflow(patient.id, TODAY);
  check("الملخص يرى الموعد القادم والخطة الجارية معًا",
    summary.nextAppointment !== null && summary.activePlans.length === 1);
  check("الرصيد = 5,000 (الكشف المفوتر، والحشوة لم تُنفَّذ فليست دَينًا)",
    summary.financial.balanceMinor === 5000 &&
    summary.financial.remainingTreatmentMinor === 25000,
    `دين ${summary.financial.balanceMinor} · باقي علاج ${summary.financial.remainingTreatmentMinor}`);
}

async function firstItemId(planId) {
  const { rows } = await pool.query(
    `SELECT id FROM plan_items WHERE plan_id = $1 ORDER BY sort_order, id LIMIT 1`, [planId],
  );
  return rows[0].id;
}

try {
  await seed();
  await journeyMultiSession();
  await journeySimple();
  console.log(failed ? "\n✗ فشل فحصٌ واحد أو أكثر.\n" : "\n✓ رحلات V2 كلها صحيحة.\n");
  process.exit(failed ? 1 : 0);
} catch (error) {
  console.error("\n✗ عطل غير متوقع:", error);
  process.exit(1);
}
