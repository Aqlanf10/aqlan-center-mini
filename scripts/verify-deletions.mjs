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
 *   ٦ — إبطال سند الصرف: قيدٌ معاكس يبقي الأصل، والحذف ممنوع على مستوى القاعدة.
 *   ٧ — حذف ملف المريض: ذو الأثر المالي يُمنع كاملًا، والنظيف يذهب بكل سجلاته.
 *
 *   node --import tsx scripts/verify-deletions.mjs
 */
import "./use-pglite.mjs";

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
  deleteLabOrder,
  deletePatientCascade,
  deleteVisit,
  ensureSchema,
  getExpense,
  voidExpense,
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

/* ═══════════ ٦ — إبطال سند الصرف ═══════════ */

/*
 * لماذا لا «حذف» هنا وحده بين الرحلات السبع؟
 *
 * لأن سند الصرف حدثٌ ماليٌّ تاريخيّ، وقد صار الحذف ممنوعًا على مستوى القاعدة نفسها
 * (هجرة 0005 «حرّاس السجل المالي»: `expenses_no_delete`)، فلا يمرّ لا من الكود ولا
 * من psql ولا بتتالٍ. التصحيح مسارٌ صريح: `voidExpense` يكتب **قيدًا معاكسًا** يشير
 * إلى السند الأصيل، فيبقى الاثنان في الدفتر وتصافي التقاريرُ الصافيَ الصحيح.
 *
 * كانت هذه الفقرة تستدعي `deleteExpense` — دالةً لا وجود لها في الكود إطلاقًا — فكانت
 * الرحلة تسقط بـ TypeError عند كل تشغيل. لم يكن الحلّ إعادةَ الحذف إلى الإنتاج ليمرّ
 * فحصٌ قديم: الفحص هو الذي تخلّف عن النظام، فيُحدَّث ليثبت الحالَ الصحيح — والحارس
 * البنيويّ يُختبر بمحاولة حذفٍ مباشرة تُرفض.
 */

async function journeyVoidExpense() {
  console.log("\n── ٦: إبطال سند الصرف — قيدٌ معاكس لا حذف، والمقفلة والمسدِّدة تُمنعان ──");

  const voucher = await recordExpense({
    category: "other", partyId: null, payeeText: "صرف خاطئ",
    amountMinor: 4000, currency: "YER", baseCurrency: BASE,
    exchangeRate: 1, payableId: null, note: "سند إبطال", createdBy: "فحص",
  });
  check("السند سُجّل في وردية مفتوحة", voucher.expense !== null && voucher.reason === null);
  const original = voucher.expense;

  /* الإبطال بلا سبب مرفوض: «أُبطل ولا أحد يعرف لماذا» ثغرةٌ في المراجعة لا ميزة. */
  const noReason = await voidExpense(original.id, { actor: "المدير", actorRole: "admin", reason: "   " });
  check("الإبطال بلا سبب يُرفض", noReason.ok === false && noReason.reason === "missing_reason");

  const voided = await voidExpense(original.id, {
    actor: "المدير", actorRole: "admin", reason: "سُجّل على التصنيف الخطأ",
  });
  check("سند الوردية المفتوحة يُبطَل بقيد معاكس", voided.ok === true);
  check("القيد المعاكس يحمل رقم سندٍ خاصًّا به", typeof voided.voidedVoucherNumber === "string"
    && voided.voidedVoucherNumber.startsWith("X-"), voided.voidedVoucherNumber);

  /* الأصل **يبقى**: هذا هو الفرق كلّه بين الإبطال والحذف. */
  const stillThere = await getExpense(original.id);
  check("الأصل باقٍ في الدفاتر كما كان", stillThere != null
    && stillThere.amountMinor === 4000, `${stillThere?.amountMinor ?? "غائب"}`);

  const { rows: pair } = await pool.query(
    `SELECT id, amount_minor::int AS amount, base_amount_minor::int AS base, category,
            shift_id, currency, reversal_of_id
       FROM expenses WHERE id = $1 OR reversal_of_id = $1 ORDER BY id`,
    [original.id],
  );
  check("الدفتر يحمل صفّين: الأصل وإبطاله", pair.length === 2, `${pair.length} صفًّا`);
  const reversal = pair.find((r) => r.reversal_of_id === original.id);
  check("القيد المعاكس يشير إلى سنده الأصيل", reversal != null && reversal.id === voided.voidedId);
  check("القيد المعاكس بمبلغٍ معاكسٍ تمامًا", reversal?.amount === -4000 && reversal?.base === -4000,
    `${reversal?.amount} / ${reversal?.base}`);
  check("وبنفس التصنيف والوردية والعملة — فتصافي التقارير من تلقائها",
    reversal?.category === pair[0].category && reversal?.shift_id === pair[0].shift_id
    && reversal?.currency === pair[0].currency);
  const net = pair.reduce((sum, row) => sum + row.base, 0);
  check("صافي الاثنين صفر — كأنّ الصرف لم يقع، وأثرُه محفوظ", net === 0, `${net}`);

  /* لا إبطال للإبطال، ولا إبطالٌ مرّتين: كلاهما يُعقّد الحساب بلا فائدة. */
  const twice = await voidExpense(original.id, { actor: "المدير", actorRole: "admin", reason: "مرة ثانية" });
  check("السند المُبطَل لا يُبطَل ثانيةً", twice.ok === false && twice.reason === "already_voided");
  const reverseTheReversal = await voidExpense(voided.voidedId, {
    actor: "المدير", actorRole: "admin", reason: "إبطال الإبطال",
  });
  check("والقيد المعاكس نفسه لا يُبطَل", reverseTheReversal.ok === false
    && reverseTheReversal.reason === "already_voided");

  const missing = await voidExpense(9_999_999, { actor: "المدير", actorRole: "admin", reason: "غير موجود" });
  check("إبطال سندٍ غير موجود يُرد بلباقة", missing.ok === false && missing.reason === "not_found");

  /* الإبطال مُوثَّق باسم صاحبه وبرقم القيد المعاكس — لا تصحيح صامت. */
  const { rows: audits } = await pool.query(
    `SELECT actor, details FROM audit_log
      WHERE action = 'expense.void' AND entity_id = $1`, [original.id],
  );
  check("الإبطال مسجَّل في سجل التدقيق باسم من أبطله", audits.length === 1
    && audits[0].actor === "المدير");
  check("والسجل يحمل سبب الإبطال ورقم القيد المعاكس",
    audits[0]?.details?.reason === "سُجّل على التصنيف الخطأ"
    && audits[0]?.details?.["قيد_معاكس"] === voided.voidedVoucherNumber);

  /* سند يسدّد التزامًا: جزء من التسوية — لا يُبطَل من هنا. */
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
  const blocked = await voidExpense(settling.expense.id, {
    actor: "المدير", actorRole: "admin", reason: "محاولة على المسدِّد",
  });
  check("السند المسدِّد للتزام يُمنع", blocked.ok === false && blocked.reason === "settles_payable");
  check("ولم يُكتب له قيدٌ معاكس", (await pool.query(
    `SELECT COUNT(*)::int AS n FROM expenses WHERE reversal_of_id = $1`, [settling.expense.id],
  )).rows[0].n === 0);

  /* وردية مقفلة: دخلت جردًا اعتُمد عليه — التصحيح في الفترة المفتوحة لا فيها. */
  const inClosed = await recordExpense({
    category: "other", partyId: null, payeeText: "صرف في وردية ستُقفل",
    amountMinor: 1500, currency: "YER", baseCurrency: BASE,
    exchangeRate: 1, payableId: null, note: null, createdBy: "فحص",
  });
  const openShiftRow = await db.getOpenShift();
  await db.closeShift({
    id: openShiftRow.id, closedBy: "المدير",
    counted: { YER: 0, SAR: 0, USD: 0 }, note: "قفل للفحص",
  });
  const afterClose = await voidExpense(inClosed.expense.id, {
    actor: "المدير", actorRole: "admin", reason: "محاولة بعد القفل",
  });
  check("سند الوردية المقفلة يُمنع", afterClose.ok === false && afterClose.reason === "closed_shift");
  await db.openShift({ openedBy: "فحص", opening: { YER: 0, SAR: 0, USD: 0 } });

  /* الحارس البنيويّ: الحذف المباشر — كما لو من psql — تردّه القاعدة نفسها. */
  let refusedByDatabase = "";
  try {
    await pool.query(`DELETE FROM expenses WHERE id = $1`, [original.id]);
  } catch (error) {
    refusedByDatabase = String(error.message ?? "");
  }
  check("الحذف المباشر من القاعدة مرفوض بحارسٍ بنيويّ", refusedByDatabase.includes("append-only"),
    refusedByDatabase.slice(0, 60) || "لم يُرفض!");
  check("والسند ما يزال قائمًا بعد المحاولة", (await getExpense(original.id)) != null);
}

/* ═══════════ ٧ — حذف ملف المريض ═══════════ */

/*
 * حارس الأثر المالي (P1-FINAL-1) غيّر معنى «الحذف الشامل»: الملف الذي دخل أو خرج
 * بسببه مالٌ — دفعةً أو فاتورةً ولو غير مدفوعة أو رصيدًا افتتاحيًّا أو أمر معملٍ
 * بتكلفة — لم يعد يُمحى أصلًا، لأن محوه محوُ شاهدٍ على مال. وكانت هذه الفقرة تزرع
 * فاتورةً ودفعةً وأمرَ معملٍ بتكلفة ثم تتوقّع نجاح المحو: فحصٌ يطلب من النظام أن
 * يخرق حارسَه. ولم يظهر تخلّفها لأن الرحلة كانت تموت قبلها في الفقرة السادسة.
 *
 * فتُثبَت الحالتان معًا: ملفٌ ذو أثرٍ ماليّ يُرفض ولا تُمسّ منه شعرة، وملفٌ نظيف
 * (مواعيد وزيارات ومخطط أسنان وحالة تقويم — بلا مال) يذهب هو وكل ما يشير إليه.
 */

async function journeyDeletePatientWithMoney() {
  console.log("\n── ٧أ: ملف بأثرٍ ماليّ — يُمنع محوه، ولا يُمسّ منه شيء ──");

  const patient = await createPatient({
    fullName: "مريض بأثر مالي " + number(), phone: "77" + number(),
    altPhone: null, gender: "male", birthYear: 1968,
    address: null, medicalAlert: null, note: "ملف بأثر مالي",
  });
  const visit = await addVisit({
    patientName: patient.fullName, patientPhone: patient.phone,
    note: null, patientId: patient.id,
  });
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
  await pool.query(`UPDATE visits SET invoice_id = $2 WHERE id = $1`, [visit.id, invoice.id]);

  const refused = await deletePatientCascade(patient.id, {
    actor: "المدير", actorRole: "admin", reason: "محاولة محو ملفٍ دخل بسببه مال",
  });
  check("المحو مرفوض بحارس الأثر المالي", refused.ok === false
    && refused.reason === "has_financial_history", refused.reason ?? "");

  const [stillPatient, stillInvoices, stillPayments, stillVisits] = await Promise.all([
    countRows(`SELECT COUNT(*)::text AS count FROM patients WHERE id = $1`, [patient.id]),
    countRows(`SELECT COUNT(*)::text AS count FROM invoices WHERE patient_id = $1`, [patient.id]),
    countRows(`SELECT COUNT(*)::text AS count FROM payments WHERE patient_id = $1`, [patient.id]),
    countRows(`SELECT COUNT(*)::text AS count FROM visits WHERE patient_id = $1`, [patient.id]),
  ]);
  check("الملف قائم كما كان", stillPatient === 1);
  check("وفاتورته ودفعته وزيارته لم تُمسّ — لا محوَ جزئيّ",
    stillInvoices === 1 && stillPayments === 1 && stillVisits === 1,
    `فواتير ${stillInvoices} · دفعات ${stillPayments} · زيارات ${stillVisits}`);
  check("ولا سجلّ محوٍ في التدقيق لمحاولةٍ لم تقع", await countRows(
    `SELECT COUNT(*)::text AS count FROM audit_log WHERE action = 'patient.delete' AND entity_id = $1`,
    [String(patient.id)],
  ) === 0);
}

async function journeyDeleteCleanPatient() {
  console.log("\n── ٧ب: ملف نظيف بلا مال — يذهب هو وكل ما يشير إليه ──");

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

  /* أمر معملٍ **بلا تكلفة مسجَّلة** (cost_minor = NULL): عملٌ سريريّ لم يُسعَّر بعد،
     فلا أثر ماليّ له. تكلفةُ صفرٍ ليست «بلا تكلفة» — إنها تسعيرٌ قيمتُه صفر،
     وحارس الأثر الماليّ يعدّها مالًا بحقّ: `cost_minor IS NOT NULL`. */
  const order = await createLabOrder({
    patientId: patient.id, labName: "مختبر الشامل " + number(), labPhone: null,
    workType: "تاج", details: null, sentDate: TODAY, dueDate: TODAY, note: null,
    partyId: null, costMinor: null, costCurrency: null, baseCurrency: BASE,
    exchangeRate: 1, createdBy: "فحص", actorRole: "admin",
  });
  check("أمر مختبر بلا تكلفة مسجَّلة سُجّل", order !== null);

  const result = await deletePatientCascade(patient.id, {
    actor: "المدير", actorRole: "admin", reason: "ملف اختباري للحذف الشامل",
  });
  check("الحذف الشامل نجح", result.ok === true, result.ok ? "" : (result.reason ?? ""));

  const [patientGone, visits, appts, labOrders, tooth, orthoCases] =
    await Promise.all([
      countRows(`SELECT COUNT(*)::text AS count FROM patients WHERE id = $1`, [patient.id]),
      countRows(`SELECT COUNT(*)::text AS count FROM visits WHERE patient_id = $1`, [patient.id]),
      countRows(`SELECT COUNT(*)::text AS count FROM appointments WHERE patient_id = $1`, [patient.id]),
      countRows(`SELECT COUNT(*)::text AS count FROM lab_orders WHERE patient_id = $1`, [patient.id]),
      countRows(`SELECT COUNT(*)::text AS count FROM tooth_conditions WHERE patient_id = $1`, [patient.id]),
      countRows(`SELECT COUNT(*)::text AS count FROM ortho_cases WHERE patient_id = $1`, [patient.id]),
    ]);
  check("صف المريض نفسه حُذف", patientGone === 0);
  check("زياراته محت", visits === 0);
  check("مواعيده محت", appts === 0);
  check("أوامر معمله محت", labOrders === 0);
  check("حالات أسنانه محت", tooth === 0);
  check("حالة تقويمه محت", orthoCases === 0);

  const payablesLeft = await countRows(
    `SELECT COUNT(*)::text AS count FROM payables p
      JOIN lab_orders l ON l.payable_id = p.id
      WHERE l.patient_id = $1`,
    [patient.id],
  );
  check("لا التزامات يتيمة خلفه", payablesLeft === 0);

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
  await journeyVoidExpense();
  await journeyDeletePatientWithMoney();
  await journeyDeleteCleanPatient();
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
