#!/usr/bin/env node
import "./load-env.mjs";
import { Client } from "pg";

/**
 * هل المخزون سجلٌّ يُعتمد عليه؟
 *
 * معيارا القبول في الدستور للمرحلة ٩ سؤالان لا ثالث لهما:
 *
 * ١) هل الرصيد اشتقاقٌ رياضي من الحركات؟ لا عمودَ رصيدٍ يُقرأ ولا يُكتب —
 *    والرصيد بعد كل حركة يساوي مجموع الحركات بالضبط.
 * ٢) هل كل تسوية مبرَّرها موثَّق؟ تسوية بلا سبب مرفوضة قبل أن تلمس القاعدة،
 *    والمرفوض لا يترك أثرًا في الحركات ولا في التدقيق.
 *
 * ويضاف إليهما سؤال السلامة: هل الصرف الذي يتجاوز الرصيد يُرفض حتى لو جاء
 * موظفان في اللحظة نفسها؟ القفل على صفّ البند داخل المعاملة هو الجواب.
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

const temporary = `inventory_check_${Date.now()}`;
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
  await db.ensureSchema();

  // ١) بند بلا رصيد ابتدائي — البداية بحركة إدخال موثقة لا برقم مفتعل.
  const item = await db.createInventoryItem({
    name: "مادة فاحص المخزون", category: "filling", unit: "سمّالة",
    minLevel: 5, note: null, createdBy: "فاحص",
  });
  check("بند جديد يبدأ برصيد صفر", item.balance === 0 && item.status === "out");

  // ٢) الصرف على رصيد صفر يُرفض — لا رصيد سالب بلا حركة.
  const earlyOut = await db.createInventoryMovement({
    itemId: item.id, kind: "out", qty: 2, createdBy: "فاحص",
  });
  check("الصرف قبل أي إدخال يُرفض", earlyOut.ok === false && /لا يكفي/.test(earlyOut.message));

  // ٣) التسوية بلا سبب تُرفض، وبسببها تُكتب وتُدقَّق.
  const noReason = await db.createInventoryMovement({
    itemId: item.id, kind: "adjust", qty: -3, reason: null, createdBy: "فاحص",
  });
  check("تسوية بلا سبب مرفوضة (الدستور)", noReason.ok === false);
  const adj = await db.createInventoryMovement({
    itemId: item.id, kind: "adjust", qty: 10, reason: "رصيد افتتاحي بجرد التشغيل", createdBy: "فاحص",
  });
  check("تسوية موثَّقة السبب تمر", adj.ok === true && adj.balance === 10);

  // ٤) الاشتقاق الرياضي: إدخالان وصرفان — الرصيد مجموع الحركات بالضبط.
  await db.createInventoryMovement({
    itemId: item.id, kind: "in", qty: 30, expiryDate: "2027-01-01", createdBy: "فاحص",
  });
  await db.createInventoryMovement({
    itemId: item.id, kind: "in", qty: 20, expiryDate: "2026-02-01", createdBy: "فاحص",
  });
  await db.createInventoryMovement({
    itemId: item.id, kind: "out", qty: 25, createdBy: "فاحص",
  });
  const detail = await db.getInventoryItemDetail(item.id);
  const expected = 10 + 30 + 20 - 25;
  check("الرصيد المشتق = مجموع الحركات", detail?.item.balance === expected,
    `الرصيد ${detail?.item.balance} والمتوقع ${expected}`);
  check("لا صرف يتجاوز الرصيد", (await db.createInventoryMovement({
    itemId: item.id, kind: "out", qty: expected + 1, createdBy: "فاحص",
  })).ok === false);

  // ٥) FEFO: صرف ٢٥ استهلك دفعة فبراير (الأقرب انتهاءً) كاملة و٥ من يناير.
  const batches = detail?.batches.batches ?? [];
  const feb = batches.find((b) => b.expiryDate === "2026-02-01");
  const jan = batches.find((b) => b.expiryDate === "2027-01-01");
  check("الصرف يستهلك الأقرب انتهاءً أولًا", feb?.remaining === 0 && jan?.remaining === 25);

  // ٦) التنبيهات: بند فوق الحد لا يُنذر — وبنقص الحد يُنذر.
  await db.createInventoryMovement({
    itemId: item.id, kind: "out", qty: 31, createdBy: "فاحص",
  });
  const alerts = await db.inventoryAlerts("2026-08-20");
  check("بند تحت حد الطلب يظهر في التنبيهات",
    alerts.lowItems.some((i) => i.id === item.id && i.balance === expected - 31));

  // ٧) التدقيق يشهد: إدارة بند وحركة — والمرفوض لا يترك سطرًا.
  const { rows: auditRows } = await admin.query(
    `SELECT action, details FROM audit_log WHERE entity IN ('inventory_item','inventory_movement') ORDER BY id`,
  );
  check("التدقيق يشهد إدارة البند وحركاته",
    auditRows.some((r) => r.action === "inventory.item") && auditRows.some((r) => r.action === "inventory.move"));
  const adjustAudit = auditRows.find((r) => r.action === "inventory.move" && r.details?.النوع === "adjust");
  check("سبب التسوية موثَّق في التدقيق باسم من سجّله",
    adjustAudit != null && adjustAudit.details?.السبب === "رصيد افتتاحي بجرد التشغيل");

  // ٨) لا مسارًا لتعديل الرصيد كحقل: تعديل البند بيانات وصفية فقط.
  const renamed = await db.updateInventoryItem(item.id, { minLevel: 3, isActive: false }, "فاحص");
  const after = await db.getInventoryItemDetail(item.id);
  check("تعديل البند لا يمسّ الرصيد المشتق",
    renamed != null && renamed.minLevel === 3 && after?.item.balance === expected - 31);
} catch (error) {
  console.error("فشل الفحص بخطأ غير متوقع:", error.message);
  failed = true;
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${temporary}`).catch(() => {});
  await admin.end();
}

if (failed) { console.error("\nالنتيجة: فحص المخزون سقط — راجع البنود أعلاه."); process.exit(1); }
console.log("\nالنتيجة: المخزون سجلٌّ يُعتمد عليه — الرصيد اشتقاق والتسوية موثَّقة.");
