#!/usr/bin/env node
import "./load-env.mjs";
import { Client } from "pg";

/**
 * هل لوحة القيادة تحكي الدفاتر نفسها؟
 *
 * معيار قبول المرحلة العاشرة في الدستور جملة واحدة: **مطابقة أرقام لوحة القيادة
 * مع دفاتر الحسابات الرسمية بنسبة 100%**.
 *
 * لا يُختبر هذا بقراءة الكود — يُختبر بحساب مستقل: سيناريو مبذور على قاعدة نظيفة
 * (فاتورة بخصم، تحصيل، سند صرف، زيارة كاملة على كرسي)، ثم يُجمع كل رقم من
 * المستندات مباشرة بـ SQL خام، ويُقارن بما تُخرجه المؤشرات. إن افترق رقم واحد
 * فالفاحص يسقط — فالمؤشرات إذًا تحسب في مكان آخر غير الدفاتر، وهذه هي
 * البذرة التي يأتي منها تضارب الشاشات.
 *
 * ويُضاف إليه مركز التقارير الموحّد: ملف CSV المصدَّر من الكائن نفسه الذي تقرأه
 * الشاشة، فيحمل الأرقام ذاتها حرفيًا.
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

  // ── السيناريو: مريضان، خدمة، زيارة كاملة على كرسي، وردية، فاتورة بخصم، تحصيل، صرف ──
  const service = await db.createService({ name: "تنظيف — فاحص القيادة", category: "cleaning", priceMinor: 100_000 });
  const patient1 = await db.createPatient({
    fullName: "مريض فاحص القيادة الأول", phone: "777000001", altPhone: null,
    gender: "male", birthYear: 1990, address: null, medicalAlert: null, note: null,
  });
  await db.createPatient({
    fullName: "مريض فاحص القيادة الثاني", phone: "777000002", altPhone: null,
    gender: "female", birthYear: 1995, address: null, medicalAlert: null, note: null,
  });

  const visit = await db.addVisit({ patientName: "مريض فاحص القيادة الأول", patientPhone: null, note: null, patientId: patient1.id });
  await db.seatVisit(visit.id, 1);
  await db.finishVisit(visit.id);

  await db.openShift({ openedBy: "فاحص", opening: { YER: 0, SAR: 0, USD: 0 } });

  const invoice = await db.createInvoice({
    patientId: patient1.id, baseCurrency: "YER", discountMinor: 20_000, note: null,
    createdBy: "فاحص",
    items: [{ serviceId: service.id, doctorId: null, description: service.name, quantity: 1, unitPriceMinor: 100_000 }],
  });
  check("الفاتورة أُنشئت", invoice != null);

  const payment = await db.recordPayment({
    patientId: patient1.id, invoiceId: invoice?.id ?? null, kind: "payment",
    amountMinor: 30_000, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
    method: "cash", note: null, createdBy: "فاحص",
  });
  check("التحصيل سُجّل", payment.payment != null);

  const expense = await db.recordExpense({
    category: "materials", partyId: null, payeeText: "مورد فاحص",
    amountMinor: 10_000, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
    payableId: null, note: null, createdBy: "فاحص",
  });
  check("سند الصرف سُجّل", expense.expense != null);

  // ── المؤشرات ──
  const kpis = await db.executiveKpis(day, day);

  // ── الحساب المستقل: كل رقم من المستندات بـ SQL خام ──
  const agg = async (sql) => (await admin.query(sql)).rows[0];
  const invoicesAgg = await agg(
    `SELECT COALESCE(SUM(total_minor),0)::bigint AS total, COALESCE(SUM(discount_minor),0)::bigint AS discount
       FROM invoices WHERE status <> 'cancelled'`,
  );
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

  // معيار القبول: مطابقة 100% — لوحة القيادة = الدفاتر.
  check("الإيراد في اللوحة = مجموع الفواتير",
    kpis.income.revenueMinor === Number(invoicesAgg.total), `${kpis.income.revenueMinor} = ${invoicesAgg.total}`);
  check("الخصم في اللوحة = مجموع الخصومات",
    kpis.income.discountMinor === Number(invoicesAgg.discount), `${kpis.income.discountMinor} = ${invoicesAgg.discount}`);
  check("صافي الإيراد = الإيراد − الخصم",
    kpis.income.netRevenueMinor === kpis.income.revenueMinor - kpis.income.discountMinor);
  check("المصروفات في اللوحة = مجموع سندات الصرف",
    kpis.income.totalExpensesMinor === Number(expensesAgg.base), `${kpis.income.totalExpensesMinor} = ${expensesAgg.base}`);
  check("صافي الربح = صافي الإيراد − المصروفات",
    kpis.income.netProfitMinor === kpis.income.netRevenueMinor - kpis.income.totalExpensesMinor,
    `${kpis.income.netProfitMinor}`);
  const yer = kpis.collections.find((row) => row.currency === "YER");
  check("التحصيل في اللوحة = مجموع سندات القبض",
    yer.collectedMinor === Number(paymentsAgg.base), `${yer.collectedMinor} = ${paymentsAgg.base}`);
  check("خروج الصندوق = سندات الصرف", yer.paidOutMinor === Number(expensesAgg.base));
  check("ذمم المرضى = الفواتير الصافية − المحصّل",
    kpis.receivableMinor === Number(invoicesAgg.total) - Number(invoicesAgg.discount) - Number(paymentsAgg.base),
    `${kpis.receivableMinor}`);
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
    kpis.income.revenueMinor, kpis.income.discountMinor, kpis.income.netRevenueMinor,
    kpis.income.totalExpensesMinor, kpis.income.netProfitMinor,
    kpis.receivableMinor, kpis.payableMinor,
    yer.collectedMinor, yer.paidOutMinor,
  ];
  check("ملف CSV يحمل كل الأرقام المالية حرفيًا",
    financialNumbers.every((value) => csv.includes(`,${value}`)));

  // ── قيد يدوي متوازن يدخل الدفاتر وتقرأه اللوحة ──
  // (والقيد غير المتوازن يُصفّى عند القراءة في journalEntries — لا يصل إلى الميزان.)
  const manual = await db.createManualEntry({
    date: day, description: "قيد فاحص — متوازن",
    lines: [
      { accountCode: "1101", amountMinor: 1_000, side: "debit" },
      { accountCode: "5901", amountMinor: 1_000, side: "credit" },
    ],
    createdBy: "فاحص",
  });
  const kpisAfter = await db.executiveKpis(day, day);
  check("قيد يدوي متوازن يدخل الدفاتر وتقرأه اللوحة",
    manual != null && kpisAfter.income.expenses.some((row) => row.code === "5901" && row.amountMinor === 1_000));
} catch (error) {
  console.error("فشل الفحص بخطأ غير متوقع:", error.message);
  failed = true;
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${temporary}`).catch(() => {});
  await admin.end();
}

if (failed) { console.error("\nالنتيجة: فحص غرفة القيادة سقط — اللوحة لا تطابق الدفاتر."); process.exit(1); }
console.log("\nالنتيجة: لوحة القيادة تطابق الدفاتر الرسمية 100% — والتصدير من الكائن نفسه.");
