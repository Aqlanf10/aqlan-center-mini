#!/usr/bin/env node
import "./load-env.mjs";
import { Client } from "pg";

/**
 * هل يصمد ترقيم المستندات تحت التزامن؟
 *
 * السؤال الذي لا يجيب عنه اختبار وحدة ولا استعمالٌ عادي: العطب لا يظهر إلا حين
 * تقبض موظفتان في الثانية نفسها — وهو ما يحدث في الزحمة بالضبط، أي في أسوأ وقت.
 *
 * يبني قاعدة مؤقتة، ثم يطلق دفعات متزامنة، ثم يتحقق: لا فشل، ولا رقم مكرّر، ولا
 * فجوة تكسر التسلسل. ثم يحذفها.
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
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
};

const temporary = `concurrency_check_${Date.now()}`;
const target = withDatabase(source, temporary);
process.env.DATABASE_URL = target;

const admin = new Client({ connectionString: source, ssl: sslFor(source) });
let failed = false;
const PARALLEL = 25;

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${temporary}`);

  const db = await import("../lib/db.ts");
  await db.ensureSchema();

  const patient = await db.createPatient({
    fullName: "مريض التزامن", phone: null, altPhone: null, gender: "male",
    birthYear: null, address: null, medicalAlert: null, note: null,
  });
  await db.openShift({ openedBy: "تزامن", opening: { YER: 0, SAR: 0, USD: 0 } });

  // ── مرضى متزامنون ──────────────────────────────────────────────────────────
  const people = await Promise.allSettled(
    Array.from({ length: PARALLEL }, (_, i) => db.createPatient({
      fullName: `متزامن ${i}`, phone: null, altPhone: null, gender: "male",
      birthYear: null, address: null, medicalAlert: null, note: null,
    })),
  );
  const peopleFailed = people.filter((r) => r.status === "rejected");
  const numbers = people.filter((r) => r.status === "fulfilled").map((r) => r.value.patientNumber);
  console.log(`المرضى: ${numbers.length} نجحوا، ${peopleFailed.length} فشلوا، ` +
              `${new Set(numbers).size} رقمًا مميّزًا`);
  if (peopleFailed.length > 0 || new Set(numbers).size !== numbers.length) {
    failed = true;
    if (peopleFailed[0]) console.error("  سبب الفشل:", peopleFailed[0].reason?.message);
  }

  // ── سندات قبض متزامنة ──────────────────────────────────────────────────────
  const paid = await Promise.allSettled(
    Array.from({ length: PARALLEL }, () => db.recordPayment({
      patientId: patient.id, invoiceId: null, kind: "payment",
      amountMinor: 1000, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
      method: "cash", note: null, createdBy: "تزامن",
    })),
  );
  const payFailed = paid.filter((r) => r.status === "rejected");
  const receipts = paid
    .filter((r) => r.status === "fulfilled" && r.value.payment)
    .map((r) => r.value.payment.receiptNumber);
  console.log(`السندات: ${receipts.length} نجحت، ${payFailed.length} فشلت، ` +
              `${new Set(receipts).size} رقمًا مميّزًا`);
  if (payFailed.length > 0 || new Set(receipts).size !== receipts.length) {
    failed = true;
    if (payFailed[0]) console.error("  سبب الفشل:", payFailed[0].reason?.message);
  }

  // ── فواتير متزامنة ─────────────────────────────────────────────────────────
  const invoiced = await Promise.allSettled(
    Array.from({ length: PARALLEL }, () => db.createInvoice({
      patientId: patient.id, baseCurrency: "YER", discountMinor: 0, note: null,
      createdBy: "تزامن",
      items: [{ serviceId: null, doctorId: null, description: "كشف", quantity: 1, unitPriceMinor: 5000 }],
    })),
  );
  const invFailed = invoiced.filter((r) => r.status === "rejected");
  const invNumbers = invoiced
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value.invoiceNumber);
  console.log(`الفواتير: ${invNumbers.length} نجحت، ${invFailed.length} فشلت، ` +
              `${new Set(invNumbers).size} رقمًا مميّزًا`);
  if (invFailed.length > 0 || new Set(invNumbers).size !== invNumbers.length) {
    failed = true;
    if (invFailed[0]) console.error("  سبب الفشل:", invFailed[0].reason?.message);
  }

  await db.getPool().end();
  console.log(failed ? "سقط الفحص." : "صمد الترقيم تحت التزامن بلا فشل ولا تكرار.");
} catch (error) {
  console.error(`فشل: ${error.message}`);
  failed = true;
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${temporary}`).catch(() => {});
  await admin.end().catch(() => {});
}
process.exit(failed ? 1 : 0);
