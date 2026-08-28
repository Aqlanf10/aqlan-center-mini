#!/usr/bin/env node
import "./load-env.mjs";
import { Client } from "pg";

/**
 * هل ملفّ التقويم سجلٌّ يُعتمد عليه؟
 *
 * الأسئلة التي تقرّر ذلك، ولا يجيب عنها اختبار وحدة لأنها كلها عن حال القاعدة:
 *
 * ١) هل يمنع البرنامج حالتين مفتوحتين لفمٍ واحد؟ سجلَّا أسلاكٍ لمريضٍ واحد يعنيان
 *    أن الطبيب لا يعرف أيّهما الحقيقي.
 * ٢) هل يبقى «السلك الحالي» متّفقًا مع سجل الشدّات؟ الشاشة تقرأ الأول والطبيب يبني
 *    عليه، فافتراقهما خطأٌ سريري لا عرضي.
 * ٣) هل يُغلق الإكمال بلا مثبّت؟ الارتداد يُضيع نتيجة سنتين.
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

const temporary = `ortho_check_${Date.now()}`;
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
  const ortho = await import("../lib/ortho.ts");
  await db.ensureSchema();

  const today = "2026-09-01";
  const patient = await db.createPatient({
    fullName: "مريض التقويم", phone: "770556677", altPhone: null, gender: "female",
    birthYear: 2008, address: null, medicalAlert: null, note: null,
  });

  console.log("\n  ── حالةٌ مفتوحة واحدة لفمٍ واحد ──");

  const opened = await db.createOrthoCase({
    patientId: patient.id, appliance: "fixed_metal", arches: "both", slot: "022",
    bracketSystem: "MBT", startDate: "2026-01-01", plannedMonths: 18,
    planId: null, note: null, createdBy: "فحص",
  });
  check("فُتحت الحالة", opened.ok, opened.ok ? `رقم ${opened.id}` : opened.message);

  const second = await db.createOrthoCase({
    patientId: patient.id, appliance: "aligners", arches: "upper", slot: "022",
    bracketSystem: null, startDate: today, plannedMonths: 12,
    planId: null, note: null, createdBy: "فحص",
  });
  check("حالةٌ ثانية مفتوحة مرفوضة", !second.ok, second.ok ? "" : second.message);

  console.log("\n  ── السلك الحالي والسجل لا يفترقان ──");

  const fresh = await db.getOrthoCase(opened.id, today);
  check("تبدأ بلا سلك", fresh.upperWire === null && fresh.lowerWire === null);
  check("والمقترح أوّل التسلسل", ortho.nextWire("022", null).code === "012 NiTi");

  await db.recordAdjustment({
    caseId: opened.id, visitId: null, doneOn: "2026-01-05", phase: "aligning",
    upperWire: "014 NiTi", lowerWire: "014 NiTi", elastics: "none",
    elasticNote: null, done: "تركيب وربط", nextWeeks: 4, note: null, recordedBy: "فحص",
  });
  const afterFirst = await db.getOrthoCase(opened.id, today);
  check("الشدّة حدّثت سلك الحالة", afterFirst.upperWire === "014 NiTi", String(afterFirst.upperWire));
  check("والسجل يحمل الشدّة", afterFirst.adjustments.length === 1);

  // الفكّ العلوي وحده يتبدّل — والسفلي يبقى كما هو لا يُمحى.
  await db.recordAdjustment({
    caseId: opened.id, visitId: null, doneOn: "2026-02-05", phase: null,
    upperWire: "016 NiTi", lowerWire: null, elastics: "class_ii",
    elasticNote: "3/16 خفيفة ليلًا", done: "تبديل السلك العلوي", nextWeeks: 4,
    note: null, recordedBy: "فحص",
  });
  const afterSecond = await db.getOrthoCase(opened.id, today);
  check("سلكٌ لم يُذكر يبقى كما هو",
    afterSecond.upperWire === "016 NiTi" && afterSecond.lowerWire === "014 NiTi",
    `${afterSecond.upperWire} / ${afterSecond.lowerWire}`);
  check("والسجل يوافق الحالة",
    afterSecond.adjustments[0].upperWire === afterSecond.upperWire);
  check("والمطاطات محفوظة", afterSecond.adjustments[0].elastics === "class_ii");

  console.log("\n  ── التقدّم والتأخّر ──");

  check("ما مضى ثمانية أشهر", Math.round(afterSecond.progress.monthsElapsed) === 8,
    String(afterSecond.progress.monthsElapsed));
  check("وعدد الشدّات اثنتان", afterSecond.progress.adjustments === 2);
  check("وآخر شدّة مذكورة", afterSecond.progress.lastAdjustment === "2026-02-05");
  check("والمريضة متأخّرة عن الشدّ",
    ortho.isOverdueForAdjustment({
      lastAdjustmentDate: afterSecond.progress.lastAdjustment,
      startDate: afterSecond.startDate, today,
    }));

  console.log("\n  ── الإغلاق يشترط المثبّت ──");

  const early = await db.closeOrthoCase({
    id: opened.id, status: "completed", actor: "فحص", note: null,
  });
  check("لا إكمال بلا مثبّت", !early.ok, early.ok ? "" : early.message);

  await db.setRetainer({ id: opened.id, retainer: "essix", deliveredOn: "2026-08-20" });
  const inRetention = await db.getOrthoCase(opened.id, today);
  check("تسجيل المثبّت ينقلها إلى التثبيت", inRetention.status === "retention", inRetention.status);
  check("والمثبّت محفوظ بتاريخه",
    inRetention.retainer === "essix" && inRetention.retainerOn === "2026-08-20");

  const closed = await db.closeOrthoCase({
    id: opened.id, status: "completed", actor: "فحص", note: "نتيجة جيدة",
  });
  check("وبعده تُكمل", closed.ok);

  const done = await db.getOrthoCase(opened.id, today);
  check("وصارت مكتملة باسم من أغلقها", done.status === "completed" && done.closedBy === "فحص");

  const late = await db.recordAdjustment({
    caseId: opened.id, visitId: null, doneOn: today, phase: null,
    upperWire: "019×025 SS", lowerWire: null, elastics: "none",
    elasticNote: null, done: null, nextWeeks: 4, note: null, recordedBy: "فحص",
  });
  check("ولا شدّة على حالةٍ مغلقة", !late.ok, late.ok ? "" : late.message);

  console.log("\n  ── وبعد الإغلاق تُفتح حالةٌ جديدة ──");

  const again = await db.createOrthoCase({
    patientId: patient.id, appliance: "removable", arches: "upper", slot: "022",
    bracketSystem: null, startDate: today, plannedMonths: 6,
    planId: null, note: "تصحيح ارتداد", createdBy: "فحص",
  });
  check("فُتحت بعد إغلاق الأولى", again.ok, again.ok ? "" : again.message);
  const open = await db.openOrthoCaseFor(patient.id, today);
  check("والمفتوحة هي الجديدة", open.id === (again.ok ? again.id : 0));
  check("والقديمة باقية في السجل",
    (await db.listPatientOrthoCases(patient.id, today)).length === 2);

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
  : "\nملفّ التقويم متماسك: حالةٌ واحدة مفتوحة، وسلكٌ لا يفارق سجلّه، ولا إكمال بلا مثبّت.");
process.exit(failed ? 1 : 0);
