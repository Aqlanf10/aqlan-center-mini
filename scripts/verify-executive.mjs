#!/usr/bin/env node
import "./load-env.mjs";
import { Client } from "pg";

/**
 * هل لوحة القيادة تحكي مراجعها المصرَّح بها نفسها؟
 *
 * معيار القبول جملة واحدة: **مطابقة أرقام لوحة القيادة مع مصادرها بنسبة 100%**
 * (P-01 owner review — تصحيح ١): الفواتير والذمم من المراجع القانونية **لكل
 * عملة على حدة**، والصندوق والمصروفات والذمم الدائنة من الدفاتر (قيودها
 * أساسية خالصة). ولا يظهر في اللوحة أي عددٌ واحدٌ ممزوج لليمني والسعودي
 * والدولار — فذلك تزويرٌ محاسبي هو أصل P0-1.
 *
 * لا يُختبر هذا بقراءة الكود — يُختبر بحساب مستقل: سيناريو مبذور على قاعدة
 * نظيفة (فاتورة يمنية بخصم + فاتورتان سعودية ودولارية، تحصيلات، سند صرف،
 * زيارة كاملة على كرسي، قيد يدوي متوازن)، ثم يُجمع كل رقم من المستندات
 * مباشرة بـ SQL خام، ويُقارن بما تُخرجه المؤشرات. إن افترق رقم واحد فالفاحص
 * يسقط — فالمؤشرات إذًا تحسب في مكانٍ آخر غير مراجعها.
 *
 * ويُضاف إليه مركز التقارير الموحّد: ملف CSV المصدَّر من الكائن نفسه الذي
 * تقرأه الشاشة، فيحمل الأرقام ذاتها حرفيًا.
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

const temporary = `executive_check_${Date.now()}`;
process.env.DATABASE_URL = withDatabase(source, temporary);
const admin = new Client({ connectionString: source, ssl: sslFor(source) });
let failed = false;
const check = (label, ok, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = true;
};

const today = () => {
  // تاريخ العيادة بتوقيتها لا الخادم — نفس حساب الشاشات.
  const local = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Aden" }));
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
};

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${temporary}`);
  const db = await import("../lib/db.ts");
  const { executiveCsv } = await import("../lib/executive.ts");
  await db.ensureSchema();

  const day = today();

  // ── السيناريو: مريضان، خدمة، زيارة كاملة على كرسي، وردية، فواتير بثلاث
  //    عملات (يمنية بخصم + سعودية + دولارية)، تحصيلات، صرف، وقيد يدوي ──
  const service = await db.createService({ name: "تنظيف — فاحص القيادة", category: "cleaning", priceMinor: 100_000 });
  const patient1 = await db.createPatient({
    fullName: "مريض فاحص القيادة الأول", phone: "777000001", altPhone: null,
    gender: "male", birthYear: 1990, address: null, medicalAlert: null, note: null,
  });
  const patient2 = await db.createPatient({
    fullName: "مريض فاحص القيادة الثاني", phone: "777000002", altPhone: null,
    gender: "female", birthYear: 1995, address: null, medicalAlert: null, note: null,
  });

  const visit = await db.addVisit({ patientName: "مريض فاحص القيادة الأول", patientPhone: null, note: null, patientId: patient1.id });
  await db.seatVisit(visit.id, 1);
  // تُنحّى seated_at عشرين دقيقة للخلف: الجلوس والانتهاء بلا فارق زمني فعلي
  // (استدعاءان متتاليان في السكربت) يمنحان صفر دقيقة إشغال، فيسقط فحص الإشغال
  // بلا صلة بأي خلل — الزيارة الحقيقية تستغرق وقتًا، لا الاختبار السريع.
  await db.getPool().query(
    `UPDATE visits SET seated_at = seated_at - interval '20 minutes' WHERE id = $1`,
    [visit.id],
  );
  await db.finishVisit(visit.id);

  await db.openShift({ openedBy: "فاحص", opening: { YER: 0, SAR: 0, USD: 0 } });

  const invoice = await db.createInvoice({
    patientId: patient1.id, baseCurrency: "YER", discountMinor: 20_000, note: null,
    createdBy: "فاحص",
    items: [{ serviceId: service.id, doctorId: null, description: service.name, quantity: 1, unitPriceMinor: 100_000 }],
  });
  check("الفاتورة أُنشئت", invoice != null);

  // (تصحيح ١) فاتورتان أجنبيتان لمريضٍ ثانٍ: سعودي 2,000.00 ودولار 300.00.
  const sarInvoice = await db.createInvoice({
    patientId: patient2.id, baseCurrency: "SAR", discountMinor: 0, note: null,
    createdBy: "فاحص",
    items: [{ serviceId: service.id, doctorId: null, description: service.name, quantity: 1, unitPriceMinor: 200_000 }],
  });
  const usdInvoice = await db.createInvoice({
    patientId: patient2.id, baseCurrency: "USD", discountMinor: 0, note: null,
    createdBy: "فاحص",
    items: [{ serviceId: service.id, doctorId: null, description: service.name, quantity: 1, unitPriceMinor: 30_000 }],
  });
  check("الفاتورتان الأجنبيتان أُنشئتا", sarInvoice != null && usdInvoice != null);

  const payment = await db.recordPayment({
    patientId: patient1.id, invoiceId: invoice?.id ?? null, kind: "payment",
    amountMinor: 30_000, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
    method: "cash", note: null, createdBy: "فاحص",
  });
  check("التحصيل سُجّل", payment.payment != null);

  // (تصحيح ١) تحصيلٌ بعملة كل فاتورة أجنبية: سعودي 1,500.00 ودولار 120.00.
  const sarPayment = await db.recordPayment({
    patientId: patient2.id, invoiceId: sarInvoice?.id ?? null, kind: "payment",
    amountMinor: 150_000, currency: "SAR", baseCurrency: "YER", exchangeRate: 130,
    method: "cash", note: null, createdBy: "فاحص",
  });
  const usdPayment = await db.recordPayment({
    patientId: patient2.id, invoiceId: usdInvoice?.id ?? null, kind: "payment",
    amountMinor: 12_000, currency: "USD", baseCurrency: "YER", exchangeRate: 530,
    method: "cash", note: null, createdBy: "فاحص",
  });
  check("تحصيل الأجنبيتين سُجّل", sarPayment.payment != null && usdPayment.payment != null);

  const expense = await db.recordExpense({
    category: "materials", partyId: null, payeeText: "مورد فاحص",
    amountMinor: 10_000, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
    payableId: null, note: null, createdBy: "فاحص",
  });
  check("سند الصرف سُجّل", expense.expense != null);

  // ── المؤشرات ──
  const kpis = await db.executiveKpis(day, day);

  // ── الحساب المستقل: كل رقم من المستندات بـ SQL خام ──
  // `admin` متصل بقاعدة `source` الأصلية لا بالقاعدة المؤقتة التي بُذر فيها
  // السيناريو أعلاه، فيُستعمل تجمّع db (المتصل بالقاعدة المؤقتة) للحساب المستقل.
  const agg = async (sql) => (await db.getPool().query(sql)).rows[0];
  const invoicesByCurrency = await (async () => {
    const { rows } = await db.getPool().query(
      `SELECT base_currency,
              COALESCE(SUM(total_minor), 0)::bigint AS total,
              COALESCE(SUM(discount_minor), 0)::bigint AS discount
       FROM invoices WHERE status <> 'cancelled' GROUP BY base_currency`,
    );
    return Object.fromEntries(rows.map((row) => [row.base_currency, { total: Number(row.total), discount: Number(row.discount) }]));
  })();
  const paymentsAgg = await agg(
    `SELECT COALESCE(SUM(base_amount_minor),0)::bigint AS base FROM payments WHERE kind = 'payment' AND currency = 'YER'`,
  );
  const expensesAgg = await agg(
    `SELECT COALESCE(SUM(base_amount_minor),0)::bigint AS base FROM expenses WHERE currency = 'YER'`,
  );
  const visitsAgg = await agg(
    `SELECT COUNT(*)::int AS arrived,
            COUNT(*) FILTER (WHERE status = 'done')::int AS done,
            COUNT(DISTINCT (arrived_at AT TIME ZONE 'Asia/Aden')::date)::int AS days
       FROM visits`,
  );
  const patientsAgg = await agg(`SELECT COUNT(*)::int AS c FROM patients`);

  /* معيار القبول (تصحيح ١): فواتير الفترة من الفواتير نفسها بعملتها — فاتورة
   * يمنية 100,000 بخصم 20,000، وسعودية 2,000.00 (200,000 هللة)، ودولارية
   * 300.00 (30,000 سنت) — ثلاثة أرقام لا رقمًا واحدًا. */
  const billing = (currency) => kpis.billingByCurrency.find((row) => row.currency === currency);
  check("الفاتورة اليمنية بمجموعها وخصمها — من الفواتير لا الدفاتر",
    billing("YER")?.grossMinor === invoicesByCurrency.YER.total
    && billing("YER")?.discountMinor === invoicesByCurrency.YER.discount
    && billing("YER")?.netMinor === invoicesByCurrency.YER.total - invoicesByCurrency.YER.discount,
    `${billing("YER")?.grossMinor} = ${invoicesByCurrency.YER.total}`);
  check("الفاتورة السعودية بدلوها — لا تُجمع مع اليمني",
    billing("SAR")?.grossMinor === invoicesByCurrency.SAR.total
    && billing("SAR")?.netMinor === invoicesByCurrency.SAR.total,
    `${billing("SAR")?.netMinor} = ${invoicesByCurrency.SAR.total}`);
  check("الفاتورة الدولارية بدلوها — لا تُجمع مع اليمني",
    billing("USD")?.grossMinor === invoicesByCurrency.USD.total
    && billing("USD")?.netMinor === invoicesByCurrency.USD.total,
    `${billing("USD")?.netMinor} = ${invoicesByCurrency.USD.total}`);
  check("لا عدد مالي واحد ممزوج في العقد — حقول المزج حُذفت كليًا",
    !("income" in kpis) && !("receivableMinor" in kpis) && !("netProfitMinor" in kpis));

  /* الذمم لكل عملة من مستنداتها: يمني = 80,000 − 30,000 = 50,000؛ سعودي =
   * 200,000 − 150,000 = 50,000 هللة؛ دولار = 30,000 − 12,000 = 18,000 سنت. */
  const receivable = (currency) => kpis.receivableByCurrency.find((row) => row.currency === currency);
  check("ذمم اليمني من المستندات — لا من دفترٍ ممزوج",
    receivable("YER")?.dueMinor === 100_000 - 20_000 - 30_000,
    `${receivable("YER")?.dueMinor}`);
  check("ذمم السعودي بدلوها وحده",
    receivable("SAR")?.dueMinor === 200_000 - 150_000,
    `${receivable("SAR")?.dueMinor}`);
  check("ذمم الدولار بدلوها وحده",
    receivable("USD")?.dueMinor === 30_000 - 12_000,
    `${receivable("USD")?.dueMinor}`);

  /* المصروفات بالأساس من الدفاتر (قيود أساسية خالصة) والتحصيل والذمم الدائنة
   * كذلك — كما كانت بلا أي تغيير. */
  check("المصروفات في اللوحة = مجموع سندات الصرف (بالأساس)",
    kpis.totalExpensesMinor === Number(expensesAgg.base), `${kpis.totalExpensesMinor} = ${expensesAgg.base}`);
  const yer = kpis.collections.find((row) => row.currency === "YER");
  check("التحصيل في اللوحة = مجموع سندات القبض (مكافئ أساس)",
    yer.collectedMinor === Number(paymentsAgg.base), `${yer.collectedMinor} = ${paymentsAgg.base}`);
  check("خروج الصندوق = سندات الصرف", yer.paidOutMinor === Number(expensesAgg.base));
  check("زيارات اللوحة = زيارات القاعدة",
    kpis.operational.arrived === visitsAgg.arrived
    && kpis.operational.done === visitsAgg.done
    && kpis.operational.newPatients === patientsAgg.c,
    `وصل ${kpis.operational.arrived}/${visitsAgg.arrived} · منتهٍ ${kpis.operational.done}/${visitsAgg.done} · جدد ${kpis.operational.newPatients}/${patientsAgg.c}`);
  check("الإشغال يحسب الزيارة الجالسة على أيام عمل فعلية",
    kpis.occupancy.occupiedMinutes > 0 && kpis.occupancy.activeDays === visitsAgg.days,
    `${kpis.occupancy.occupiedMinutes} دقيقة على ${kpis.occupancy.activeDays} يوم`);

  // ── مركز التقارير الموحّد: الملف المصدَّر من الكائن نفسه ──
  const csv = executiveCsv(kpis);
  const financialNumbers = [
    ...kpis.billingByCurrency.flatMap((row) => [row.grossMinor, row.discountMinor, row.netMinor]),
    ...kpis.receivableByCurrency.map((row) => row.dueMinor),
    kpis.totalExpensesMinor, kpis.payableMinor,
    yer.collectedMinor, yer.paidOutMinor,
  ];
  check("ملف CSV يحمل كل الأرقام المالية حرفيًا — كلٌّ بعملته المصرَّحة",
    financialNumbers.every((value) => csv.includes(`,${value}`))
    && kpis.billingByCurrency.every((row) => csv.includes(`${row.currency},${row.netMinor}`))
    && kpis.receivableByCurrency.every((row) => csv.includes(`${row.currency},${row.dueMinor}`)));

  // ── قيد يدوي متوازن يدخل الدفاتر وتقرأه اللوحة ──
  // (والقيد غير المتوازن يُصفّى عند القراءة في journalEntries — لا يصل إلى الميزان.)
  // مصروفٌ نقدي: 5901 مدينة (المصروف حسابٌ مدين طبيعي، فتزيد قيمته بالمدين)
  // و1101 دائنة (الصندوق ينقص) — لا العكس، وإلا ظهر المصروف رصيدًا سالبًا لا موجبًا.
  const manual = await db.createManualEntry({
    date: day, description: "قيد فاحص — متوازن",
    lines: [
      { accountCode: "5901", amountMinor: 1_000, side: "debit" },
      { accountCode: "1101", amountMinor: 1_000, side: "credit" },
    ],
    createdBy: "فاحص",
  });
  const kpisAfter = await db.executiveKpis(day, day);
  check("قيد يدوي متوازن يدخل الدفاتر وتقرأه اللوحة",
    manual != null && kpisAfter.expenses.some((row) => row.code === "5901" && row.amountMinor === 1_000));
} catch (error) {
  console.error("فشل الفحص بخطأ غير متوقع:", error.message);
  failed = true;
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${temporary}`).catch(() => {});
  await admin.end();
}

if (failed) { console.error("\nالنتيجة: فحص غرفة القيادة سقط — اللوحة لا تطابق مراجعها."); process.exit(1); }
console.log("\nالنتيجة: لوحة القيادة تحكي مراجعها — بعملة كل اتفاق، وبلا رقمٍ ممزوج.");
