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
  /* القيم الحيّة قبل الاعتماد — من الدوالّ نفسها التي ترسم للطبيب على الشاشة.
     تُحسب هنا لتُقارَن بعد الاعتماد بما خُتم، فالسؤال الذي تجيب عنه هذه الفقرة
     ليس «هل الأرقام صحيحة؟» وحده بل «هل المختوم هو ما رآه الطبيب؟». */
  const ceph = await import("../lib/ceph.ts");
  const beforeStamp = await db.getCephStudy(id);
  const mmPerPixel = ceph.computeMmPerPixel({ x: 10, y: 10 }, { x: 110, y: 10 }, 100);
  const L = Object.fromEntries(beforeStamp.landmarks.map((m) => [m.code, { x: m.x, y: m.y }]));
  const computed = ceph.computeAll(L, mmPerPixel);

  const done = await db.completeCephAnalysis(id, doctor);
  check("الاعتماد بعد المعايرة والمعالم يمرّ", done.ok, done.message);
  const stamped = await db.getCephStampedValues(id);
  const val = (code) => stamped?.find((m) => m.code === code)?.value ?? null;

  /*
   * المعالم الموضوعة في هذه الحالة التركيبية عشرون، ومنها يُحسب ما يُحسب. سبعةُ
   * قياساتٍ تحتاج معالمَ لم تُوضع (Ar للزوايا القحفية، وملامح الأنف والشفتين
   * للقياسات اللينة) فلا تُحسب ولا تُختم — وهذا صحيح لا نقص.
   *
   * كان الفحص قبل هذا يقارن العدد بثابتٍ (٣٣) فسقط حين نما دليل القياسات إلى ٤٩
   * تعريفًا — بلا أن يكون في الهندسة ولا في الختم عيب. والعدد الثابت فحصٌ هشّ من
   * الجهتين: يحمرّ عند إضافة قياسٍ صحيح، ويبقى أخضر لو توقّف قياسٌ عن العمل وحلّ
   * محلّه آخر. فالمُثبَت هنا العلاقةُ لا العدد: كل ما يُحسب يُختم، وكل مختومٍ
   * يساوي الحيَّ **تمامًا**، وما لا يُحسب يُسمّى معلَمُه الناقص بالاسم.
   */
  const PENDING_LANDMARKS = {
    SADDLE: "Ar", ARTICULAR: "Ar", GONIAL: "Ar", BJORK_SUM: "Ar",
    E_LINE_UL: "Prn,PogS,Ls", E_LINE_LL: "Prn,PogS,Li", NASOLABIAL: "Prn,Sn,Ls",
  };
  const stampedMap = new Map((stamped ?? []).map((m) => [m.code, Number(m.value)]));
  const divergent = [];
  const notStamped = [];
  const stampedButNotComputed = [];
  const wrongPending = [];
  for (const row of computed) {
    const live = row.value == null ? null : Number(row.value);
    const seal = stampedMap.has(row.code) ? stampedMap.get(row.code) : null;
    if (live == null) {
      if (seal != null) stampedButNotComputed.push(`${row.code}=${seal}`);
      const missing = ceph.missingFor(row.code, L).join(",");
      if (PENDING_LANDMARKS[row.code] !== missing) {
        wrongPending.push(`${row.code}: ينقصه ${missing || "لا شيء!"}`);
      }
      continue;
    }
    if (seal == null) { notStamped.push(row.code); continue; }
    if (live !== seal) divergent.push(`${row.code}: حيّ ${live} · مختوم ${seal} · فرق ${(live - seal).toFixed(4)}`);
  }
  for (const code of stampedMap.keys()) {
    if (!computed.some((row) => row.code === code)) stampedButNotComputed.push(`${code} (بلا تعريف)`);
  }
  const computable = computed.filter((row) => row.value != null).map((row) => row.code);

  check("كل قياسٍ يُحسب من المعالم الموضوعة صار مختومًا", notStamped.length === 0,
    notStamped.join("، ") || `${computable.length} قياسًا`);
  check("ولا قياسَ مختومًا بلا قيمةٍ حيّة تقابله", stampedButNotComputed.length === 0,
    stampedButNotComputed.join("، "));
  check("المختوم يساوي الحيَّ تمامًا — لا فرقَ ولا تقريبَ في الختم", divergent.length === 0,
    divergent.join(" | "));
  check("وما لم يُحسب فلنقص معلَمٍ مسمّى لا لعطب",
    wrongPending.length === 0 && computable.length + Object.keys(PENDING_LANDMARKS).length === computed.length,
    wrongPending.join(" | ") || `${computable.length} محسوبًا · ${Object.keys(PENDING_LANDMARKS).length} ينتظر معالمه`);
  check("ولقطة الاعتماد المُعادة هي نفسها المختومة في القاعدة",
    Array.isArray(done.measurements)
    && done.measurements.length === stampedMap.size
    && done.measurements.every((m) => stampedMap.get(m.code) === Number(m.value)));

  /* والقيم الثابتة للحالة التركيبية المعروفة — كلٌّ في خانته باسمه، فالساقط منها
     يُعرف بعينه لا بعبارة «القياسات كلها». وهي القيم نفسها في __tests__/ceph.test.ts. */
  const KNOWN = [
    ["SNA", 82], ["SNB", 80], ["ANB", 2], ["SND", 79.5], ["WITS", -1.3],
    ["FMA", 25], ["IMPA", 86.6], ["U1SN", 104], ["U1NA_A", 22],
    ["L1NB_A", 25], ["L1NB_D", -13.7], ["MAX_LEN", 113.4], ["MM_DIFF", 7.6],
    ["LAFH", 56.1], ["A_NPERP", -1.4], ["CONV_ANGLE", 4.4], ["AB_PLANE", -4.6],
    ["L1OP", 18.1],
  ];
  for (const [code, expected] of KNOWN) {
    const actual = val(code);
    check(`${code} = ${expected}`, actual != null && Math.abs(actual - expected) <= 0.3,
      actual == null ? "غير مختوم" : `${actual}`);
  }

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
