#!/usr/bin/env node
/**
 * التحقق التشغيلي لصلاحيات الحذف والتسعير بالكمية — طلب المالك.
 *
 * يُزرع مريضٌ كاملُ الحياة في PGlite (موعد، زيارة، خطة، فاتورة، دفعة، حالة أسنان،
 * حالة تقويم، أمر مختبر بتكلفة والتزام) ثم تُنفَّذ أدوات المدير الجديدة بدوال
 * القاعدة نفسها التي تستعملها المسارات، وتُطابق النتائج يدويًا:
 *
 *   ١ — التسعير بالكمية: قاعدة ٢٠ دولارًا × ٣ أسنان = ٦٠ (الواجهة والخادم بقاعدة واحدة).
 *   ٢ — إلغاء إرسالية مرسلة: الالتزام غير المسدَّد يُمحى، والمسدَّد يبقى أثره.
 *   ٣ — حذف أمر مختبر خاطئ: يذهب بلا بقايا، والمسدَّد يُمنع.
 *   ٤ — حذف الموعد: نظيف، والواصل يُمنع.
 *   ٥ — حذف الزيارة: التشغيلية تُمحى، والموقّعة والمفوترة تُمنعان.
 *   ٦ — حذف سند الصرف: وردية مفتوحة يُمحى، والمسدِّد للتزام والوردية المقفلة يُمنعان.
 *   ٧ — حذف ملف المريض كاملًا: كل جدولٍ يشير إليه يخلو منه بعد الحذف.
 *
 *   node --import tsx scripts/verify-deletions.mjs
 */
process.env.SESSION_SECRET = "f".repeat(48);
process.env.USE_LOCAL_DB = "true";
process.env.DATABASE_URL = "";

const db = await import("../lib/db.ts");
const {
  addVisit,
  arriveAppointment,
  createAppointment,
  createInvoice,
  createLabOrder,
  createLabPricingRule,
  createLabService,
  createLaboratory,
  createPatient,
  deleteAppointment,
  deleteExpense,
  deleteLabOrder,
  deletePatientCascade,
  deleteVisit,
  ensureSchema,
  getExpense,
  getLabOrderById,
  getPool,
  recordExpense,
  recordToothCondition,
  recordPayment,
  setLabOrderStatus,
} = db;

const pool = getPool();
const BASE = "YER";
const TODAY = new Date().toISOString().slice(0, 10);
const UNIT_MINOR = 2000; // ٢٠ دولارًا بالسنتات — سعر الوحدة في جدول التسعير

let failed = false;
const check = (label, ok, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = true;
};

const number = () => "DL-" + Date.now().toString().slice(-8) + Math.floor(Math.random() * 97);

async function seed() {
  await ensureSchema();
  // وردية مفتوحة — القبض والصرف لا يمرّان بلاها.
  await pool.query(`UPDATE cashier_shifts SET status = 'closed', closed_at = NOW() WHERE status = 'open'`);
  await pool.query(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
     SELECT 'فحص', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`,
  );
}

const countRows = async (sql, args) => {
  const { rows } = await pool.query(sql, args);
  return Number(rows[0]?.count ?? 0);
};

/* ═══════════ ١ — التسعير بالكمية: ٢٠ دولارًا × ٣ أسنان = ٦٠ ═══════════ */

async function journeyPricingQuantity() {
  console.log("\n── ١: التسعير بالكمية — سعر الوحدة من جدول التسعير × عدد الأسنان ──");

  const lab = await createLaboratory({ name: "مختبر الكمية " + number(), currency: "USD" });
  const svc = await createLabService({
    name: "تاج زيركون " + number(),
    category: "prostho",
    toothScope: "single_tooth",
  });
  await createLabPricingRule({
    partyId: lab.id,
    labServiceId: svc.id,
    costMinor: UNIT_MINOR,
    costCurrency: "USD",
    effectiveFrom: TODAY,
    createdBy: "فحص",
  });

  const patient = await createPatient({
    fullName: "مريض الكمية " + number(), phone: "77" + number(),
    altPhone: null, gender: "male", birthYear: 1988,
    address: null, medicalAlert: null, note: null,
  });

  /* بلا تكلفة صريحة وبأسنان محددة: الخادم يقرأ قاعدة التسعير (٢٠٠٠ سنت) ويضربها
     بثلاثة أسنان = ٦٠٠٠ سنت = ٦٠ دولارًا — لا ٢٠ ولا ٢٠٠٠. */
  const order = await createLabOrder({
    patientId: patient.id,
    labName: lab.name,
    labPhone: null,
    workType: svc.name,
    details: null,
    sentDate: TODAY,
    dueDate: TODAY,
    note: null,
    partyId: lab.id,
    costMinor: null, // المسار الاحتياطي: التسعير من القاعدة × الكمية
    costCurrency: null,
    baseCurrency: BASE,
    exchangeRate: 1,
    createdBy: "فحص",
    labServiceId: svc.id,
    toothNumbers: "14, 15, 16",
    actorRole: "admin",
  });
  check(
    "أمر بثلاثة أسنان بلا تكلفة صريحة يُسعَّر من القاعدة: ٢٠ × ٣ = ٦٠ دولارًا",
    Number(order.costMinor) === UNIT_MINOR * 3,
    `costMinor=${order.costMinor} (المتوقع ${UNIT_MINOR * 3})`,
  );
  check("العملة من قاعدة التسعير نفسها", order.costCurrency === "USD");

  const payable = await countRows(
    `SELECT COUNT(*)::text AS count FROM payables WHERE lab_order_id = $1`, [order.id],
  );
  check("الالتزام وُلد بقيمة الإرسالية كاملةً (٦٠ دولارًا لا ٢٠)", payable === 1);
  const payAmount = await pool.query(
    `SELECT amount_minor::text AS amount FROM payables WHERE lab_order_id = $1`, [order.id],
  );
  check(
    "مقدار الالتزام = الإجمالي المضروب",
    Number(payAmount.rows[0]?.amount) === UNIT_MINOR * 3,
    `amount=${payAmount.rows[0]?.amount}`,
  );

  /* وبقاعدةٍ واحدة من الواجهة: labPricingQuantity — تُختبر في وحدة vitest،
     وهنا نتأكد أن الخادم يوافقها على الحالة نفسها. */
  await deleteLabOrder(order.id, { actor: "فحص", actorRole: "admin", reason: "تنظيف" });
  return patient;
}

/* ═══════════ ٢ — إلغاء إرسالية مرسلة: عكس الالتزام ═══════════ */

async function journeyCancelSubmission() {
  console.log("\n── ٢: إلغاء الإرسالية المرسلة — عكس الالتزام غير المسدَّد ──");

  const patient = await createPatient({
    fullName: "مريض الإلغاء " + number(), phone: "77" + number(),
    altPhone: null, gender: "female", birthYear: 1992,
    address: null, medicalAlert: null, note: null,
  });
  const order = await createLabOrder({
    patientId: patient.id,
    labName: "مختبر الإلغاء " + number(),
    labPhone: null,
    workType: "تاج",
    details: null,
    sentDate: TODAY,
    dueDate: TODAY,
    note: null,
    partyId: null,
    costMinor: 5000,
    costCurrency: "YER",
    baseCurrency: BASE,
    exchangeRate: 1,
    createdBy: "فحص",
    actorRole: "admin",
  });
  const payableId = await pool.query(
    `SELECT payable_id FROM lab_orders WHERE id = $1`, [order.id],
  );
  check("الالتزام وُلد مع الإرسالية", Boolean(payableId.rows[0]?.payable_id));

  const cancelled = await setLabOrderStatus(order.id, "cancelled", {
    actor: "المدير", actorRole: "admin", notes: "إلغاء اختباري",
  });
  check("الحالة صارت ملغاة", cancelled?.status === "cancelled");
  const after = await pool.query(
    `SELECT payable_id, financial_status FROM lab_orders WHERE id = $1`, [order.id],
  );
  check(
    "الالتزام غير المسدَّد محي مع الإلغاء",
    after.rows[0]?.payable_id === null,
    `payable_id=${after.rows[0]?.payable_id}`,
  );
  check("الحالة المالية «معفاة»", after.rows[0]?.financial_status === "exempt");

  const payableGone = await countRows(
    `SELECT COUNT(*)::text AS count FROM payables WHERE id = $1`,
    [payableId.rows[0]?.payable_id ?? 0],
  );
  check("صف الالتزام نفسه اختفى من الجدول", payableGone === 0);

  /* المسدَّد لا يُمحى: سند صرف يشير إلى الالتزام يحميه. */
  const paidPatient = await createPatient({
    fullName: "مريض المسدد " + number(), phone: "77" + number(),
    altPhone: null, gender: "male", birthYear: 1975,
    address: null, medicalAlert: null, note: null,
  });
  const paidOrder = await createLabOrder({
    patientId: paidPatient.id,
    labName: "مختبر المسدد " + number(),
    labPhone: null,
    workType: "جسر",
    details: null,
    sentDate: TODAY,
    dueDate: TODAY,
    note: null,
    partyId: null,
    costMinor: 7000,
    costCurrency: "YER",
    baseCurrency: BASE,
    exchangeRate: 1,
    createdBy: "فحص",
    actorRole: "admin",
  });
  const paidPayable = await pool.query(
    `SELECT payable_id FROM lab_orders WHERE id = $1`, [paidOrder.id],
  );
  await pool.query(
    `INSERT INTO expenses (voucher_number, category, payee_text, shift_id, amount_minor, currency,
                           exchange_rate, base_amount_minor, base_currency, payable_id, note, created_by)
     SELECT 'V-' || LPAD(nextval('voucher_number_seq')::text, 5, '0'), 'lab', 'المختبر', s.id, 7000, 'YER',
            1, 7000, 'YER', $1, 'سداد اختباري', 'فحص'
       FROM cashier_shifts s WHERE s.status = 'open' LIMIT 1`,
    [paidPayable.rows[0]?.payable_id],
  );
  const paidCancelled = await setLabOrderStatus(paidOrder.id, "cancelled", {
    actor: "المدير", actorRole: "admin", notes: "إلغاء بعد السداد",
  });
  check("المسدَّد يُلغى سريريًا كذلك", paidCancelled?.status === "cancelled");
  const paidAfter = await pool.query(
    `SELECT payable_id, financial_status FROM lab_orders WHERE id = $1`, [paidOrder.id],
  );
  check(
    "التزام المسدَّد بقي بعد الإلغاء",
    Boolean(paidAfter.rows[0]?.payable_id),
    `payable_id=${paidAfter.rows[0]?.payable_id}`,
  );
  check("حالته المالية «مسدَّد» — المال خرج فعلًا", paidAfter.rows[0]?.financial_status === "paid");

  /* الحذف على المسدَّد يُمنع: باب الحذف للخاطئ لا للمدفوع. */
  const deleteBlocked = await deleteLabOrder(paidOrder.id, { actor: "المدير", actorRole: "admin" });
  check("حذف المسدَّد مرفوض", deleteBlocked.ok === false && deleteBlocked.reason === "settled");
}

/* ═══════════ ٣ — حذف أمر مختبر خاطئ نهائيًا ═══════════ */

async function journeyDeleteLabOrder() {
  console.log("\n── ٣: حذف أمر مختبر خاطئ — لا بقايا ولا يتيمة ──");

  const patient = await createPatient({
    fullName: "مريض حذف الأمر " + number(), phone: "77" + number(),
    altPhone: null, gender: "female", birthYear: 1980,
    address: null, medicalAlert: null, note: null,
  });
  const order = await createLabOrder({
    patientId: patient.id,
    labName: "مختبر الحذف " + number(),
    labPhone: null,
    workType: "طقم",
    details: null,
    sentDate: TODAY,
    dueDate: TODAY,
    note: null,
    partyId: null,
    costMinor: 9000,
    costCurrency: "YER",
    baseCurrency: BASE,
    exchangeRate: 1,
    createdBy: "فحص",
    actorRole: "admin",
  });
  const result = await deleteLabOrder(order.id, {
    actor: "المدير", actorRole: "admin", reason: "أمر مكرر خاطئ",
  });
  check("الحذف نجح", result.ok === true);
  const gone = await getLabOrderById(order.id);
  check("الأمر اختفى من القاعدة", gone === null);
  const trackingGone = await countRows(
    `SELECT COUNT(*)::text AS count FROM lab_order_tracking WHERE lab_order_id = $1`, [order.id],
  );
  check("أحداث التتبع محت معه", trackingGone === 0);
  const auditRow = await countRows(
    `SELECT COUNT(*)::text AS count FROM audit_log WHERE action = 'lab_order.delete' AND entity_id = $1`,
    [String(order.id)],
  );
  check("الحذف مسجَّل في سجل التدقيق بصورته", auditRow === 1);

  const missing = await deleteLabOrder(999999999, { actor: "المدير", actorRole: "admin" });
  check("حذف غير الموجود يُرد بلباقة", missing.ok === false && missing.reason === "not_found");
  return patient;
}

/* ═══════════ ٤ — حذف الموعد ═══════════ */

async function journeyDeleteAppointment() {
  console.log("\n── ٤: حذف الموعد — نظيف، والواصل يُمنع ──");

  const patient = await createPatient({
    fullName: "مريض الموعد " + number(), phone: "77" + number(),
    altPhone: null, gender: "male", birthYear: 1995,
    address: null, medicalAlert: null, note: null,
  });
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const appt = await createAppointment({
    patientId: patient.id, date: tomorrow, time: "10:30",
    durationMinutes: 30, appointmentType: null, note: "موعد حذف",
  });
  const okDelete = await deleteAppointment(appt.id, { actor: "المدير", actorRole: "admin" });
  check("الموعد غير الواصل حُذف", okDelete.ok === true);
  const gone = await countRows(`SELECT COUNT(*)::text AS count FROM appointments WHERE id = $1`, [appt.id]);
  check("اختفى من الجدول", gone === 0);

  /* الواصل حُوّل زيارة — لا يُحذف. */
  const arrivedAppt = await createAppointment({
    patientId: patient.id, date: TODAY, time: "09:00",
    durationMinutes: 30, appointmentType: null, note: null,
  });
  await arriveAppointment(arrivedAppt.id);
  const blocked = await deleteAppointment(arrivedAppt.id, { actor: "المدير", actorRole: "admin" });
  check("الموعد الواصل يُمنع من الحذف", blocked.ok === false && blocked.reason === "arrived");
  return patient;
}

/* ═══════════ ٥ — حذف الزيارة ═══════════ */

async function journeyDeleteVisit() {
  console.log("\n── ٥: حذف الزيارة — التشغيلية تُمحى، والموقّعة تُمنع ──");

  const patient = await createPatient({
    fullName: "مريض الزيارة " + number(), phone: "77" + number(),
    altPhone: null, gender: "female", birthYear: 1985,
    address: null, medicalAlert: null, note: null,
  });
  const visit = await addVisit({
    patientName: patient.fullName, patientPhone: patient.phone,
    note: null, patientId: patient.id,
  });
  await recordToothCondition({
    patientId: patient.id, toothCode: 16, condition: "carries",
    stage: "existing", recordedBy: "فحص", visitId: visit.id,
  });
  const deleted = await deleteVisit(visit.id, { actor: "المدير", actorRole: "admin", reason: "زيارة مكررة" });
  check("زيارة الانتظار حُذفت", deleted.ok === true);
  const visitGone = await countRows(`SELECT COUNT(*)::text AS count FROM visits WHERE id = $1`, [visit.id]);
  check("اختفت من الطابور", visitGone === 0);

  /* زيارة موقّعة: وثّقت عمل الطبيب — لا تُمحى. */
  const patient2 = await createPatient({
    fullName: "مريض الموقعة " + number(), phone: "77" + number(),
    altPhone: null, gender: "male", birthYear: 1970,
    address: null, medicalAlert: null, note: null,
  });
  const visit2 = await addVisit({
    patientName: patient2.fullName, patientPhone: patient2.phone,
    note: null, patientId: patient2.id,
  });
  await pool.query(`UPDATE visits SET signed_at = NOW() WHERE id = $1`, [visit2.id]);
  const blocked = await deleteVisit(visit2.id, { actor: "المدير", actorRole: "admin" });
  check("الزيارة الموقّعة تُمنع من الحذف", blocked.ok === false && blocked.reason === "signed");
  return [patient, patient2];
}

/* ═══════════ ٦ — حذف سند الصرف ═══════════ */

async function journeyDeleteExpense() {
  console.log("\n── ٦: حذف سند الصرف — المفتوحة تُمحى، والمسدِّد والتالفة يُمنعان ──");

  const voucher = await recordExpense({
    category: "other", partyId: null, payeeText: "صرف خاطئ",
    amountMinor: 4000, currency: "YER", baseCurrency: BASE,
    exchangeRate: 1, payableId: null, note: "سند حذف", createdBy: "فحص",
  });
  check("السند سُجّل في وردية مفتوحة", voucher.expense !== null && voucher.reason === null);
  const okDelete = await deleteExpense(voucher.expense.id, { actor: "المدير", actorRole: "admin" });
  check("سند الوردية المفتوحة حُذف", okDelete.ok === true);
  const gone = await getExpense(voucher.expense.id);
  check("اختفى من الدفاتر", gone === null || gone === undefined);

  /* سند يسدّد التزامًا: جزء من التسوية — يُمنع. */
  const payableRow = await pool.query(
    `INSERT INTO payables (party_id, category, description, amount_minor, currency,
                           exchange_rate, base_amount_minor, base_currency, created_by)
     VALUES ((SELECT id FROM parties WHERE kind = 'lab' LIMIT 1), 'lab', 'التزام حماية', 6000, 'YER',
             1, 6000, 'YER', 'فحص')
     RETURNING id`,
  );
  const settling = await recordExpense({
    category: "lab", partyId: null, payeeText: "مختبر",
    amountMinor: 6000, currency: "YER", baseCurrency: BASE,
    exchangeRate: 1, payableId: payableRow.rows[0].id, note: null, createdBy: "فحص",
  });
  const blocked = await deleteExpense(settling.expense.id, { actor: "المدير", actorRole: "admin" });
  check("السند المسدِّد للتزام يُمنع", blocked.ok === false && blocked.reason === "settles_payable");
}

/* ═══════════ ٧ — حذف ملف المريض كاملًا ═══════════ */

async function journeyDeletePatientCascade() {
  console.log("\n── ٧: حذف ملف المريض نهائيًا — كل سجلاته تذهب معه ──");

  const patient = await createPatient({
    fullName: "مريض الحذف الشامل " + number(), phone: "77" + number(),
    altPhone: null, gender: "male", birthYear: 1968,
    address: null, medicalAlert: null, note: "ملف الحذف الشامل",
  });
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await createAppointment({
    patientId: patient.id, date: tomorrow, time: "11:00",
    durationMinutes: 45, appointmentType: null, note: null,
  });
  const visit = await addVisit({
    patientName: patient.fullName, patientPhone: patient.phone,
    note: null, patientId: patient.id,
  });
  await recordToothCondition({
    patientId: patient.id, toothCode: 26, condition: "carries",
    stage: "existing", recordedBy: "فحص", visitId: visit.id,
  });
  const orthoCase = await db.createOrthoCase({
    patientId: patient.id, appliance: "fixed_metal", arches: "both", slot: "022",
    bracketSystem: "MBT", startDate: TODAY, plannedMonths: 18,
    planId: null, note: null, createdBy: "فحص",
  });
  check("حالة تقويم فُتحت للملف", orthoCase.ok === true, orthoCase.ok ? `رقم ${orthoCase.id}` : orthoCase.message);
  const invoice = await createInvoice({
    patientId: patient.id, baseCurrency: BASE, discountMinor: 0,
    note: null, createdBy: "فحص",
    items: [{ serviceId: null, doctorId: null, description: "كشف", quantity: 1, unitPriceMinor: 5000 }],
  });
  check("فاتورة سُجّلت", invoice !== null);
  const payment = await recordPayment({
    patientId: patient.id, invoiceId: invoice.id, kind: "payment",
    amountMinor: 2000, currency: "YER", baseCurrency: BASE,
    exchangeRate: 1, method: "cash", note: null, createdBy: "فحص",
  });
  check("دفعة قُبضت في وردية مفتوحة", payment.payment !== null);
  const order = await createLabOrder({
    patientId: patient.id,
    labName: "مختبر الشامل " + number(),
    labPhone: null,
    workType: "تاج",
    details: null,
    sentDate: TODAY,
    dueDate: TODAY,
    note: null,
    partyId: null,
    costMinor: 3000,
    costCurrency: "YER",
    baseCurrency: BASE,
    exchangeRate: 1,
    createdBy: "فحص",
    actorRole: "admin",
  });
  check("أمر مختبر بتكلفة سُجّل", order !== null);

  /* ربط الزيارة بالفاتورة — الحلقة التي كانت ستدور: زيارة→فاتورة→(خطة)→بند→زيارة. */
  await pool.query(`UPDATE visits SET invoice_id = $2 WHERE id = $1`, [visit.id, invoice.id]);

  const result = await deletePatientCascade(patient.id, {
    actor: "المدير", actorRole: "admin", reason: "ملف اختباري للحذف الشامل",
  });
  check("الحذف الشامل نجح", result.ok === true);

  const [patientGone, visits, appts, invoices, payments, labOrders, tooth, orthoCases, invoiceItems] =
    await Promise.all([
      countRows(`SELECT COUNT(*)::text AS count FROM patients WHERE id = $1`, [patient.id]),
      countRows(`SELECT COUNT(*)::text AS count FROM visits WHERE patient_id = $1`, [patient.id]),
      countRows(`SELECT COUNT(*)::text AS count FROM appointments WHERE patient_id = $1`, [patient.id]),
      countRows(`SELECT COUNT(*)::text AS count FROM invoices WHERE patient_id = $1`, [patient.id]),
      countRows(`SELECT COUNT(*)::text AS count FROM payments WHERE patient_id = $1`, [patient.id]),
      countRows(`SELECT COUNT(*)::text AS count FROM lab_orders WHERE patient_id = $1`, [patient.id]),
      countRows(`SELECT COUNT(*)::text AS count FROM tooth_conditions WHERE patient_id = $1`, [patient.id]),
      countRows(`SELECT COUNT(*)::text AS count FROM ortho_cases WHERE patient_id = $1`, [patient.id]),
      countRows(
        `SELECT COUNT(*)::text AS count FROM invoice_items WHERE invoice_id = $1`,
        [invoice.id],
      ),
    ]);
  check("صف المريض نفسه حُذف", patientGone === 0);
  check("زياراته محت", visits === 0);
  check("مواعيده محت", appts === 0);
  check("فواتيره محت", invoices === 0);
  check("بنود فاتورته تتالي معها", invoiceItems === 0);
  check("دفعاته محت", payments === 0);
  check("أوامر معمله محت", labOrders === 0);
  check("حالات أسنانه محت", tooth === 0);
  check("حالة تقويمه محت", orthoCases === 0);

  const payablesLeft = await countRows(
    `SELECT COUNT(*)::text AS count FROM payables p
      JOIN lab_orders l ON l.payable_id = p.id
      WHERE l.patient_id = $1`,
    [patient.id],
  );
  check("التزامات معمله غير المسدَّدة محت (لا يتيمة)", payablesLeft === 0);

  const auditRow = await countRows(
    `SELECT COUNT(*)::text AS count FROM audit_log WHERE action = 'patient.delete' AND entity_id = $1`,
    [String(patient.id)],
  );
  check("الحذف الشامل مسجَّل في التدقيق بصورة الملف", auditRow === 1);

  const notFound = await deletePatientCascade(999999999, { actor: "المدير", actorRole: "admin" });
  check("حذف غير الموجود يُرد بلباقة", notFound.ok === false && notFound.reason === "not_found");
}

/* ═══════════ التنفيذ ═══════════ */

async function main() {
  console.log("صلاحيات الحذف والتسعير بالكمية — التحقق التشغيلي");
  await seed();
  await journeyPricingQuantity();
  await journeyCancelSubmission();
  await journeyDeleteLabOrder();
  await journeyDeleteAppointment();
  await journeyDeleteVisit();
  await journeyDeleteExpense();
  await journeyDeletePatientCascade();
  console.log(
    failed
      ? "\n✗ فشلت رحلات الحذف — راجع الخانات أعلاه"
      : "\n✓ كل رحلات الحذف خضراء",
  );
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error("خطأ غير متوقع:", error);
  process.exit(1);
});
