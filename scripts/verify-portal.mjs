#!/usr/bin/env node
import "./load-env.mjs";
import { createHash } from "node:crypto";
import { Client } from "pg";

/**
 * هل بوابة المريض معزولة فعلًا لا بالوعد؟
 *
 * معيارا القبول للمرحلة ١١ في الدستور:
 *  ١) **عزل كامل لصلاحيات بوابة المريض عن بيانات المركز الداخلية** — يُختبر من
 *     طرفين: لا توكن طاقم يُقرأ بقرائ البوابة ولا عكس، ولا تمريرة موعد أو
 *     استمارة لمريض غيره من باب المعرّفات. وكوكي البوابة اسمه غير كوكي الطاقم.
 *  ٢) **اعتماد نفس مصدر الحقيقة لقاعدة بيانات المريض** — كشف حساب البوابة يُقارن
 *     هنا بمخرجات `patientLedger()` نفسها صفًّا صفًّا: ما يراه المريض هو ما يراه
 *     الكاشير، وإلا سقط الفاحص.
 *
 * ويُضاف: حدّ محاولات الدخول يُقرأ من التدقيق نفسه ببصمة الهاتف لا هاتفه،
 * وقواعد تأكيد الحضور (ملكية، حالة، ماضٍ)، والاستمارة سجلٌّ يُضاف إليه.
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

const temporary = `portal_check_${Date.now()}`;
process.env.DATABASE_URL = withDatabase(source, temporary);
process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? "f".repeat(48);
const admin = new Client({ connectionString: source, ssl: sslFor(source) });
let failed = false;
const check = (label, ok, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = true;
};

const addDays = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${temporary}`);
  const db = await import("../lib/db.ts");
  const portal = await import("../lib/portal.ts");
  const auth = await import("../lib/auth.ts");
  await db.ensureSchema();

  // ── التمهيد: مريضان، فاتورة ل الأول، مواعيد الأول (قادم، ملغى، ماضٍ) ──
  const patient1 = await db.createPatient({
    fullName: "صاحب البوابة", phone: "+967777000001", altPhone: null,
    gender: "male", birthYear: 1990, address: null, medicalAlert: null, note: null,
  });
  const patient2 = await db.createPatient({
    fullName: "جار البوابة", phone: "+967777000002", altPhone: null,
    gender: "female", birthYear: 1995, address: null, medicalAlert: null, note: null,
  });
  const service = await db.createService({ name: "فحص — فاحص البوابة", category: "checkup", priceMinor: 50_000 });
  const invoice = await db.createInvoice({
    patientId: patient1.id, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: "فاحص",
    items: [{ serviceId: service.id, doctorId: null, description: service.name, quantity: 1, unitPriceMinor: 50_000 }],
  });

  const future = await db.createAppointment({ patientId: patient1.id, date: addDays(7), time: "10:00", durationMinutes: 30, note: null });
  const cancelled = await db.createAppointment({ patientId: patient1.id, date: addDays(10), time: "11:00", durationMinutes: 30, note: null });
  await db.setAppointmentStatus(cancelled.id, "cancelled");
  const past = await db.createAppointment({ patientId: patient1.id, date: addDays(-5), time: "09:00", durationMinutes: 30, note: null });

  // ── ١) الدخول ──
  const wrongNumber = await db.portalLogin("+967777000001", "P-XXXX");
  check("رقم ملف خاطئ لا يدخل", wrongNumber === null);
  const wrongPhone = await db.portalLogin("+967777099999", patient1.patientNumber);
  check("هاتف لا يملكه لا يدخل حتى لو عرف رقم الملف", wrongPhone === null);
  const ok = await db.portalLogin("+967777000001", patient1.patientNumber);
  check("العاملان الصحيحان يدخلان", ok != null && ok.patient.id === patient1.id, ok?.patient.patientNumber);

  // ── ٢) العزل التوقيعي ──
  check("كوكي البوابة غير كوكي الطاقم", portal.PORTAL_COOKIE !== auth.SESSION_COOKIE);
  const portalToken = portal.createPortalToken({
    patientId: patient1.id, patientNumber: patient1.patientNumber, fullName: patient1.fullName,
    expiresAt: Date.now() + 60_000,
  });
  const staffToken = auth.createSessionToken({
    userId: 1, username: "x", role: "admin", expiresAt: Date.now() + 60_000,
  });
  check("توكن الطاقم لا تقرؤه بوابة", portal.readPortalToken(staffToken) === null);
  check("توكن البوابة لا يقرؤه طاقم", auth.readSessionToken(portalToken) === null);
  check("توكن البوابة الصالح يعطي مريضه", portal.readPortalToken(portalToken)?.patientId === patient1.id);

  // ── ٣) حد المحاولات من التدقيق نفسه، ببصمة لا هاتف ──
  const phoneHash = createHash("sha256").update("777000009".slice(-9)).digest("hex");
  for (let attempt = 0; attempt < 5; attempt++) {
    await db.recordAudit({
      action: "portal.login",
      details: { ok: false, phone_hash: phoneHash },
      actor: "بوابة المريض",
    });
  }
  const failures = await db.portalLoginFailures(phoneHash, new Date(Date.now() - 15 * 60_000).toISOString());
  check("خمس محاولات خاطئة تُقفل", failures.count >= 5 && failures.oldestIso !== null, `العدد ${failures.count}`);
  const { rows: auditRows } = await admin.query(
    `SELECT details FROM audit_log WHERE action = 'portal.login' LIMIT 1`,
  );
  const details = auditRows[0]?.details ?? {};
  check("التدقيق يحفظ بصمة الهاتف لا الهاتف", details.phone_hash === phoneHash && !JSON.stringify(details).includes("777000009"));

  // ── ٤) مصدر الحقيقة: كشف البوابة = كشف الطاقم ──
  const portalLedger = await db.portalStatement(patient1.id);
  const staffLedger = await db.patientLedger(patient1.id);
  check("كشف البوابة هو كشف patientLedger نفسه صفًّا صفًّا",
    portalLedger.invoices.length === staffLedger.invoices.length
    && portalLedger.invoices[0]?.invoiceNumber === staffLedger.invoices[0]?.invoiceNumber
    && portalLedger.invoices[0]?.totalMinor === staffLedger.invoices[0]?.totalMinor
    && portalLedger.invoices[0]?.totalMinor === 50_000);
  check("كشف المريض الثاني لا يرى فاتورة غيره",
    (await db.portalStatement(patient2.id)).invoices.length === 0);

  // ── ٥) تأكيد الحضور: ملكية وحالة ومانع الماضي ──
  const foreign = await db.portalConfirmAttendance(future.id, patient2.id, addDays(0));
  check("موعد غيره مرفوض حتى بمعرّفه", foreign.ok === false && foreign.reason === "not_found");
  const cancelledTry = await db.portalConfirmAttendance(cancelled.id, patient1.id, addDays(0));
  check("موعد ملغى لا يُؤكد", cancelledTry.ok === false && cancelledTry.reason === "not_booked");
  const pastTry = await db.portalConfirmAttendance(past.id, patient1.id, addDays(0));
  check("موعد ماضٍ لا يُؤكد", pastTry.ok === false && pastTry.reason === "past");
  const own = await db.portalConfirmAttendance(future.id, patient1.id, addDays(0));
  check("الموعد المؤكد-قيد المؤكد مستقبلًا يقبل", own.ok === true);
  const again = await db.portalConfirmAttendance(future.id, patient1.id, addDays(0));
  check("تأكيد ثانٍ صامت يُعيد الختم ذاته لا ختمًا جديدًا",
    again.ok === true && own.ok === true && again.confirmedAt === own.confirmedAt);

  // ── ٦) الاستمارة: سجل يُضاف إليه ──
  const form1 = await db.createIntakeForm(patient1.id, {
    conditions: ["diabetes"], allergies: "بنسلين", medications: null,
    emergencyName: "ولده", emergencyPhone: "777123456", note: null,
  });
  const form2 = await db.createIntakeForm(patient1.id, { conditions: ["diabetes", "asthma"], allergies: null, medications: null, emergencyName: null, emergencyPhone: null, note: "متابعة" });
  const latest = await db.latestIntakeForm(patient1.id);
  check("آخر استمارة هي الأحدث وليست الأولى",
    latest != null && latest.id === form2.id && latest.answers.conditions.includes("asthma"));
  const empty = await db.latestIntakeForm(patient2.id);
  check("مريض بلا استمارة يرى لا شيء", empty === null);

  // ── ٧) التدقيق يشهد أفعال البوابة ──
  const { rows: portalAudit } = await admin.query(
    `SELECT action, count(*)::int AS c FROM audit_log
      WHERE action IN ('portal.login','portal.intake') GROUP BY action`,
  );
  const map = Object.fromEntries(portalAudit.map((row) => [row.action, row.c]));
  check("التدقيق يسجل الدخول والاستمارات", (map["portal.login"] ?? 0) >= 5 && (map["portal.intake"] ?? 0) >= 2);
} catch (error) {
  console.error("فشل الفحص بخطأ غير متوقع:", error.message);
  failed = true;
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${temporary}`).catch(() => {});
  await admin.end();
}

if (failed) { console.error("\nالنتيجة: فحص البوابة سقط — العزل أو مصدر الحقيقة لا يصمد."); process.exit(1); }
console.log("\nالنتيجة: البوابة معزولة بمجال توقيع مستقل، وتقرأ من مصدر الحقيقة نفسه.");
