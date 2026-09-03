#!/usr/bin/env node
import "./load-env.mjs";
import { Client } from "pg";

/**
 * هل التحليل السيفالومتري سجلٌّ يُعتمد عليه؟
 *
 * الأسئلة التي تقرّر ذلك ولا يجيب عنها اختبار وحدة لأنها كلها عن حال القاعدة:
 *
 * ١) هل يُمنع الاعتماد بلا معايرة وبلا معالم كاملة؟ اعتمادٌ بأرقامٍ ناقصة وهمٌ
 *    سريري: الطبيب يظن أن الأرقام قياسٌ وقد هي كسر.
 * ٢) هل تُختم القياسات كما رآها الطبيع على الشاشة؟ الحيّ والمعتمد من دوالّ واحدة،
 *    واللقطة تُكتب في معاملة القفل نفسها.
 * ٣) هل يقف التعديل عند الاعتماد؟ المعتمد الذي يُعدَّل يشهد لمن عدّله لا لمن عاين.
 * ٤) هل النسخةُ للتصحيح والرفضُ موثَّق؟ لا حذف صامت ولا استبدال لما اعتُمد.
 * ٥) هل يشهد سجل التدقيق؟ فتحٌ وتحديثٌ واعتمادٌ ورفضٌ بأسماء أصحابها.
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

const temporary = `ceph_check_${Date.now()}`;
process.env.DATABASE_URL = withDatabase(source, temporary);
const admin = new Client({ connectionString: source, ssl: sslFor(source) });
let failed = false;
const check = (label, ok, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = true;
};

// الحالة التركيبية نفسها من اختبار الوحدة — إحداثيات مليمترية مشتقة يدويًا،
// والقواطع بتشريحها الصحيح: قمة الجذر فوق حافة القاطع (كما على أي شععة)،
// ومع الاختيارية (D/Co/ANS/PNS) لتُختم القياسات الـ٣٣ كلها.
const pt = { S: [0, 0], N: [69, -8], A: [67.57, 51.98], B: [63.84, 79.85],
  Pog: [64.03, 86.87], Me: [60, 105], Gn: [61.5, 95.5], Go: [-17.03, 69.08],
  Or: [60, -25], Po: [0, -25], U1A: [60, 34], U1: [74.08, 71.44],
  L1A: [68, 64], L1: [49.0, 99.2], OcclA: [70, 48], OcclP: [0, 35.3],
  D: [62, 95], Co: [-45, 38], ANS: [78, 44], PNS: [-5, 36] };

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${temporary}`);
  const db = await import("../lib/db.ts");
  await db.ensureSchema();

  // مريض وشععة له — الصف مباشر لأن التحميل ليس موضوع الفحص.
  const patient = await db.createPatient({
    fullName: "مريض السيفالو", phone: "771445566", altPhone: null, gender: "male",
    birthYear: 2010, address: null, medicalAlert: null, note: null,
  });
  // `admin` متصل بقاعدة `source` الأصلية لا بالقاعدة المؤقتة التي فيها المريض،
  // فيُستعمل تجمّع db (المتصل بالقاعدة المؤقتة) لإدراج صفٍّ يشير إلى مريضها.
  const { rows: docs } = await db.getPool().query(
    `INSERT INTO patient_documents
       (patient_id, kind, title, mime_type, size_bytes, sha256, storage_key, uploaded_by)
     VALUES ($1, 'imaging', 'سيفالو جانبي', 'image/jpeg', 1024, 'deadbeef', 'check/does-not-exist.jpg', 'فاحص')
     RETURNING id`,
    [patient.id],
  );
  const documentId = docs[0].id;
  const doctor = "د. عقلان";

  // ١) الاعتماد المبكر يُرفض: بلا معايرة، وبلا معالم.
  const created = await db.createCephAnalysis({
    patientId: patient.id, documentId, createdBy: doctor,
    phase: "during", xrayDate: "2026-08-20", device: "جهاز الفحص",
  });
  check("فتح مسودة على شععة المريض نفسه", created.ok);
  const id = created.id;
  const early = await db.getCephStudy(id);
  check("بيانات الدراسة تُحفظ وتُقرأ (المرحلة وتاريخ الشععة والجهاز)",
    early?.analysis.phase === "during" && early?.analysis.xrayDate === "2026-08-20"
    && early?.analysis.device === "جهاز الفحص");

  // المجموعة المرجعية المدمجة مزروعة بقيم كل التعريفات.
  const refSets = await db.listCephReferenceSets();
  const builtin = refSets.find((s) => s.key === "builtin_default");
  const defCount = (await import("../lib/ceph.ts")).MEASUREMENTS.length;
  check("المجموعة المرجعية المدمجة مزروعة كاملة", builtin != null
    && Object.keys(builtin.values).length === defCount,
    `${builtin ? Object.keys(builtin.values).length : 0}/${defCount} قيمة`);

  const earlyComplete = await db.completeCephAnalysis(id, doctor);
  check("الاعتماد بلا معايرة يُرفض", earlyComplete.ok === false);
  // مقياس ١:١ — بكسل واحد = مليمتر واحد، كما إحداثيات pt أعلاه (كما في اختبار
  // الوحدة __tests__/ceph.test.ts: SCALE = 1). ١٠٠ بكسل بين نقطتي المعايرة تعادل
  // ١٠٠ مم فعلًا، لا ١٠ — وإلا قِسنا كل بعدٍ خطّي بعُشر قيمته الحقيقية.
  await db.updateCephCalibration(id, { x1: 10, y1: 10, x2: 110, y2: 10, mm: 100 }, doctor);
  const stillEarly = await db.completeCephAnalysis(id, doctor);
  check("الاعتماد بلا معالم كاملة يُرفض", stillEarly.ok === false && /ناقصة/.test(stillEarly.message));

  // ٢) التحليل على شععة غير المريض يُرفض.
  const stranger = await db.createPatient({
    fullName: "غير صاحب الشععة", phone: "771998877", altPhone: null, gender: "female",
    birthYear: 2005, address: null, medicalAlert: null, note: null,
  });
  const wrongDoc = await db.createCephAnalysis({ patientId: stranger.id, documentId, createdBy: doctor });
  check("شععة مريضٍ آخر لا تُرسم عليها", wrongDoc.ok === false);

  // ٣) المسودة تُكتب ثم يُعتمد فيُختم القياس لقطةً واحدة — والتشخيص المنظم معه.
  await db.updateCephLandmarks(id, Object.entries(pt).map(([code, [x, y]]) => ({ code, x, y })), doctor);
  const dxWritten = await db.updateCephDiagnosis(id, {
    skeletal: "علاقة صنف أول تقريبًا — نمو متوازن",
    dental: "قواطع داخل المدى تقريبًا",
    softTissue: null,
    note: "فحص قاعدة — لا قيمة سريرية",
    finalDx: "سيفالومتريًا: علاقة هيكلية صنف أول، نمو متوازن، قواطع مقبولة الموضع.",
  }, doctor);
  check("التشخيص المنظم يُكتب على المسودة", dxWritten.ok);
  const dxEmpty = await db.updateCephDiagnosis(id, { finalDx: "   " }, doctor);
  check("الاستنتاج الفارغ يُرفض", dxEmpty.ok === false);
  const done = await db.completeCephAnalysis(id, doctor);
  check("الاعتماد بعد المعايرة والمعالم يمرّ", done.ok, done.message);
  const stamped = await db.getCephStampedValues(id);
  const val = (code) => stamped?.find((m) => m.code === code)?.value ?? null;
  const near = (code, expected, tolerance = 0.3) =>
    val(code) != null && Math.abs(val(code) - expected) <= tolerance;
  check("اللقطة تحمل القيم المشتقة يدويًا — القياسات الثلاثة والثلاثون كلها", stamped?.length === 33
    && near("SNA", 82) && near("SNB", 80) && near("ANB", 2)
    && near("FMA", 25) && near("IMPA", 86.6, 0.3) && near("WITS", -1.3)
    && near("U1SN", 104, 0.3) && near("U1NA_A", 22, 0.3)
    && near("L1NB_A", 25, 0.3) && near("L1NB_D", -13.7, 0.3)
    && near("SND", 79.5, 0.3) && near("MAX_LEN", 113.4, 0.3)
    && near("MM_DIFF", 7.6, 0.3) && near("LAFH", 56.1, 0.3)
    && near("A_NPERP", -1.4, 0.3)
    && near("CONV_ANGLE", 4.4, 0.3) && near("AB_PLANE", -4.6, 0.3)
    && near("L1OP", 18.1, 0.3),
    `ANB=${val("ANB")} CONV_ANGLE=${val("CONV_ANGLE")} AB_PLANE=${val("AB_PLANE")} L1OP=${val("L1OP")}`);

  // ٤) المعتمد يقفل: كتابةُ معالم ومعايرة وتشخيص واعتماد ثانٍ — كلها تُرفض.
  const afterEdit = await db.updateCephLandmarks(id, [{ code: "S", x: 5, y: 5 }], "متعديل");
  const afterCal = await db.updateCephCalibration(id, { x1: 0, y1: 0, x2: 10, y2: 0, mm: 5 }, "متعديل");
  const afterDx = await db.updateCephDiagnosis(id, { finalDx: "محاولة تعديل بعد الاعتماد" }, "متعديل");
  const again = await db.completeCephAnalysis(id, doctor);
  check("المعتمد لا تُلمس معالمه", afterEdit.ok === false);
  check("المعتمد لا يُعاد تمعيره", afterCal.ok === false);
  check("التشخيص المُختم لا يُعدّل", afterDx.ok === false);
  check("لا اعتماد ثانٍ", again.ok === false);
  const sealed = await db.getCephStudy(id);
  check("التشخيص المعتمد يُقرأ كما كُتب", sealed?.diagnosis?.finalDx?.includes("صنف أول") === true
    && sealed?.diagnosis?.createdBy === doctor);

  // ٥) النسخة للتصحيح، والرفض موثَّق، والحذف الصامت مستحيل أصلًا.
  const dup = await db.duplicateCephAnalysis(id, doctor);
  check("نسخة تصحيح تُفتح عن المعتمد", dup.ok);
  if (dup.ok) {
    const copy = await db.getCephStudy(dup.id);
    check("النسخة تحمل المعالم المنسوخة", copy?.landmarks.length === Object.keys(pt).length);
    const discarded = await db.discardCephAnalysis(dup.id, doctor, "تدريب لا يُعتمد");
    check("رفض المسودة موثَّق باسم رافضها", discarded.ok);
  }
  const cannotDeleteCompleted = await db.discardCephAnalysis(id, doctor, null);
  check("المعتمد لا يُرفض ولا يُحذف", cannotDeleteCompleted.ok === false);

  // ٦) سجل التدقيق يشهد الدورة كاملة بأسماء أصحابها.
  const { rows: auditRows } = await db.getPool().query(
    `SELECT action, actor FROM audit_log WHERE entity = 'ceph_analysis' ORDER BY id`,
  );
  const actions = new Set(auditRows.map((r) => r.action));
  check("التدقيق يشهد: فتح وتحديث واعتماد ورفض",
    actions.has("ceph.create") && actions.has("ceph.update")
    && actions.has("ceph.complete") && actions.has("ceph.discard"),
    `${auditRows.length} سجلًا`);

  const wrongActor = auditRows.some((r) => r.actor === "متعديل");
  check("محاولة التعديل بعد الاعتماد لم تمرّ حتى في التدقيق", !wrongActor);
} catch (error) {
  console.error("فشل الفحص بخطأ غير متوقع:", error.message);
  failed = true;
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${temporary}`).catch(() => {});
  await admin.end();
}

if (failed) { console.error("\nالنتيجة: فحص السيفالو سقط — راجع البنود أعلاه."); process.exit(1); }
console.log("\nالنتيجة: التحليل السيفالومتري سجلٌّ يُعتمد عليه.");
