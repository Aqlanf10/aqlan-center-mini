#!/usr/bin/env node
import "./load-env.mjs";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { validateOperationalVerificationEnvironment } from "../lib/verification-target-policy.mjs";

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

// Validate original source, aliases and runtime identities before rewriting the
// URL or constructing pg. A generated path cannot isolate a Railway runtime.
const source = validateOperationalVerificationEnvironment(process.env, { requireSource: true });
const withDatabase = (url, name) => {
  const parsed = new URL(url); parsed.pathname = `/${name}`; return parsed.toString();
};

const temporary = `ceph_check_${randomUUID().replaceAll("-", "")}`;
process.env.DATABASE_URL = withDatabase(source, temporary);
const admin = new Client({ connectionString: source, ssl: false });
let failed = false;
let databaseCreated = false;
let db;
const check = (label, ok, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = true;
};

// Same synthetic millimetric fixture as __tests__/ceph.test.ts: upper root is
// superior to its edge, LOWER root is inferior to its edge. Optional D/Co/ANS/PNS
// permit their actual measurements. EI_KIM_1996 awaits its lip landmarks here;
// a separate fully specified fixture below verifies its versioned snapshot.
// Operational synthetic test only: capture the state deliberately created by
// this script. Interactive completion must use the physician's reviewed state.
const calibrationState = (study) => ({ calibration: study.analysis.calibration, mmPerPixel: study.analysis.mmPerPixel });
const completionSnapshot = (study) => ({
  patientId: study.analysis.patientId, documentId: study.analysis.documentId, refSet: study.analysis.refSet,
  calibration: study.analysis.calibration, mmPerPixel: study.analysis.mmPerPixel,
  landmarks: study.landmarks.map(({ code, x, y, source }) => ({ code, x, y, source })),
  diagnosis: study.diagnosis ? { skeletal: study.diagnosis.skeletal, dental: study.diagnosis.dental,
    softTissue: study.diagnosis.softTissue, note: study.diagnosis.note, finalDx: study.diagnosis.finalDx } : null,
});

const pt = { S: [0, 0], N: [69, -8], A: [67.57, 51.98], B: [63.84, 79.85],
  Pog: [64.03, 86.87], Me: [60, 105], Gn: [61.5, 95.5], Go: [-17.03, 69.08],
  Or: [60, 25], Po: [0, 25], U1A: [60, 34], U1: [74.08, 71.44],
  L1A: [49.0, 99.2], L1: [68, 64], OcclA: [70, 48], OcclP: [0, 35.3],
  D: [62, 95], Co: [-45, 38], ANS: [78, 44], PNS: [-5, 36] };

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${temporary}"`);
  databaseCreated = true;
  db = await import("../lib/db.ts");
  await db.ensureSchema();

  // A new active synthetic account belongs only to this fresh owned database.
  // Never borrow seeded or production identities for completion authorization.
  process.env.SESSION_SECRET ||= `${randomUUID()}${randomUUID()}`;
  const { hashPassword, sessionCredentialVersion } = await import("../lib/auth.ts");
  const doctor = "د. عقلان";
  const passwordHash = await hashPassword(randomUUID());
  const { rows: actors } = await db.getPool().query(
    `INSERT INTO users(username,display_name,password_hash,role,is_active)
     VALUES($1,$1,$2,'admin',true) RETURNING id`, [doctor, passwordHash]);
  const session = { userId: actors[0].id, username: doctor, role: "admin",
    expiresAt: Date.now() + 3_600_000, credentialVersion: sessionCredentialVersion(passwordHash) };

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
     VALUES ($1, 'imaging', 'سيفالو جانبي', 'image/jpeg', 1024, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'check/does-not-exist.jpg', 'فاحص')
     RETURNING id`,
    [patient.id],
  );
  const documentId = docs[0].id;
  // ١) الاعتماد المبكر يُرفض: بلا معايرة، وبلا معالم.
  const created = await db.createCephAnalysis({
    patientId: patient.id, documentId, createdBy: doctor,
    phase: "during", xrayDate: "2026-08-20", device: "جهاز الفحص",
  });
  check("فتح مسودة على شععة المريض نفسه", created.ok);
  const id = Number(created.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid synthetic analysis identity");
  const early = await db.getCephStudy(id);
  if (early?.completionSources?.state !== "available") throw new Error("Synthetic completion sources unavailable");
  const reviewedSources = early.completionSources.identity;
  check("بيانات الدراسة تُحفظ وتُقرأ (المرحلة وتاريخ الشععة والجهاز)",
    early?.analysis.phase === "during" && early?.analysis.xrayDate === "2026-08-20"
    && early?.analysis.device === "جهاز الفحص");

  // المجموعة المرجعية المدمجة مزروعة بقيم كل التعريفات.
  const refSets = await db.listCephReferenceSets();
  const builtin = refSets.find((s) => s.key === "builtin_default");
  const definitions = (await import("../lib/ceph.ts")).MEASUREMENTS;
  const referenceDefinitions = definitions.filter((definition) => !definition.descriptiveOnly
    && Number.isFinite(definition.mean) && Number.isFinite(definition.tol));
  const referenceCodes = new Set(referenceDefinitions.map((definition) => definition.code));
  check("المجموعة المرجعية كاملة دون تحويل المؤشر الوصفي إلى معيار علاجي", builtin != null
    && Object.keys(builtin.values).length === referenceCodes.size
    && Object.keys(builtin.values).every((code) => referenceCodes.has(code)),
    `${builtin ? Object.keys(builtin.values).length : 0}/${referenceCodes.size} قيمة مرجعية`);

  const earlyComplete = await db.completeCephAnalysis(id, doctor, completionSnapshot(await db.getCephStudy(id)), session, reviewedSources);
  check("الاعتماد بلا معايرة يُرفض", earlyComplete.ok === false);
  // مقياس ١:١ — بكسل واحد = مليمتر واحد، كما إحداثيات pt أعلاه (كما في اختبار
  // الوحدة __tests__/ceph.test.ts: SCALE = 1). ١٠٠ بكسل بين نقطتي المعايرة تعادل
  // ١٠٠ مم فعلًا، لا ١٠ — وإلا قِسنا كل بعدٍ خطّي بعُشر قيمته الحقيقية.
  await db.updateCephCalibration(id, { x1: 10, y1: 10, x2: 110, y2: 10, mm: 100 }, doctor, calibrationState(await db.getCephStudy(id)));
  const stillEarly = await db.completeCephAnalysis(id, doctor, completionSnapshot(await db.getCephStudy(id)), session, reviewedSources);
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
  }, doctor, (await db.getCephStudy(id)).diagnosis);
  check("التشخيص المنظم يُكتب على المسودة", dxWritten.ok);
  const dxEmpty = await db.updateCephDiagnosis(id, { finalDx: "   " }, doctor, (await db.getCephStudy(id)).diagnosis);
  check("الاستنتاج الفارغ يُرفض", dxEmpty.ok === false);
  /* القيم الحيّة قبل الاعتماد — من الدوالّ نفسها التي ترسم للطبيب على الشاشة.
     تُحسب هنا لتُقارَن بعد الاعتماد بما خُتم، فالسؤال الذي تجيب عنه هذه الفقرة
     ليس «هل الأرقام صحيحة؟» وحده بل «هل المختوم هو ما رآه الطبيب؟». */
  const ceph = await import("../lib/ceph.ts");
  const beforeStamp = await db.getCephStudy(id);
  const mmPerPixel = ceph.computeMmPerPixel({ x: 10, y: 10 }, { x: 110, y: 10 }, 100);
  const L = Object.fromEntries(beforeStamp.landmarks.map((m) => [m.code, { x: m.x, y: m.y }]));
  const computed = ceph.computeAll(L, mmPerPixel);

  const done = await db.completeCephAnalysis(id, doctor, completionSnapshot(beforeStamp), session, reviewedSources);
  check("الاعتماد بعد المعايرة والمعالم يمرّ", done.ok, done.message);
  const stamped = await db.getCephStampedValues(id);
  const val = (code) => stamped?.find((m) => m.code === code)?.value ?? null;

  /*
   * المعالم الموضوعة في هذه الحالة التركيبية عشرون، ومنها يُحسب ما يُحسب. سبعةُ
   * قياساتٍ تحتاج معالمَ لم تُوضع (Ar للزوايا القحفية، وملامح الأنف والشفتين
   * للقياسات اللينة) فلا تُحسب ولا تُختم — وهذا صحيح لا نقص. ومؤشر EI_KIM_1996
   * يحتاج معالم الشفتين وخط E أيضًا. EXT_INDEX القديم لا يعود قياسًا صالحًا.
   *
   * كان الفحص قبل هذا يقارن العدد بثابتٍ (٣٣) فسقط حين نما دليل القياسات إلى ٤٩
   * تعريفًا — بلا أن يكون في الهندسة ولا في الختم عيب. والعدد الثابت فحصٌ هشّ من
   * الجهتين: يحمرّ عند إضافة قياسٍ صحيح، ويبقى أخضر لو توقّف قياسٌ عن العمل وحلّ
   * محلّه آخر. فالمُثبَت هنا العلاقةُ لا العدد: كل ما يُحسب يُختم، وكل مختومٍ
   * يساوي الحيَّ **تمامًا**، وما لا يُحسب يُسمّى معلَمُه الناقص بالاسم. ويُفحص
   * غياب EXT_INDEX التاريخي من النتائج الجديدة والتخزين الخام دون استثناء عام.
   */
  const PENDING_LANDMARKS = {
    SADDLE: "Ar", ARTICULAR: "Ar", GONIAL: "Ar", BJORK_SUM: "Ar",
    E_LINE_UL: "Prn,PogS,Ls", E_LINE_LL: "Prn,PogS,Li", NASOLABIAL: "Prn,Sn,Ls",
    EI_KIM_1996: "Prn,PogS,Ls,Li",
  };
  // Read actual storage too: getCephStampedValues intentionally hides historical
  // quarantined values, so that getter alone cannot prove no new EXT_INDEX stamp.
  const { rows: quarantinedStamps } = await db.getPool().query(
    `SELECT code FROM ceph_measurements WHERE analysis_id = $1 AND code = $2`,
    [id, "EXT_INDEX"],
  );
  const stampedMap = new Map((stamped ?? []).map((m) => [m.code, Number(m.value)]));
  check("EXT_INDEX التاريخي لا يُحسب ولا يظهر ولا يُختم مجددًا",
    computed.every((row) => row.code !== "EXT_INDEX")
    && Number.isNaN(ceph.measure("EXT_INDEX", L, mmPerPixel))
    && !stampedMap.has("EXT_INDEX") && quarantinedStamps.length === 0
    && Array.isArray(done.measurements)
    && done.measurements.every((row) => row.code !== "EXT_INDEX"));
  const descriptiveIndex = computed.find((row) => row.code === "EI_KIM_1996");
  check("EI_KIM_1996 الناقص يبقى غير متاح مع مدخلات صريحة، لا قيمة صفرية",
    descriptiveIndex?.value === null && descriptiveIndex?.status === null
    && descriptiveIndex?.display === "—" && descriptiveIndex?.severityStars === ""
    && descriptiveIndex?.mean === null && descriptiveIndex?.tol === null
    && descriptiveIndex?.requiresCalibration === true && descriptiveIndex?.descriptiveOnly === true
    && descriptiveIndex?.calculationVersion === "kim-ei-shin-chang-1996-nose-tip-v1"
    && typeof descriptiveIndex?.note === "string" && /معايرة/.test(descriptiveIndex.note)
    && ceph.missingFor("EI_KIM_1996", L).join(",") === PENDING_LANDMARKS.EI_KIM_1996);
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
    ["FMA", 25], ["IMPA", 93.4], ["FMIA", 61.6], ["INTER", 131], ["SNGOGN", 25.2],
    ["U1SN", 104], ["U1NA_A", 22],
    ["L1NB_A", 25], ["L1NB_D", 3.2], ["MAX_LEN", 113.4], ["MM_DIFF", 7.6],
    ["LAFH", 56.1], ["A_NPERP", -1.4], ["CONV_ANGLE", 4.4], ["AB_PLANE", -4.6],
    ["L1OP", 18.1],
  ];
  for (const [code, expected] of KNOWN) {
    const actual = val(code);
    check(`${code} = ${expected}`, actual != null && Math.abs(actual - expected) <= 0.3,
      actual == null ? "غير مختوم" : `${actual}`);
  }

  // ٤) المعتمد يقفل: كتابةُ معالم ومعايرة وتشخيص تُرفض؛ إعادة الطلب نفسه قرائية.
  const afterEdit = await db.updateCephLandmarks(id, [{ code: "S", x: 5, y: 5 }], "متعديل");
  const afterCal = await db.updateCephCalibration(id, { x1: 0, y1: 0, x2: 10, y2: 0, mm: 5 }, "متعديل", calibrationState(await db.getCephStudy(id)));
  const afterDx = await db.updateCephDiagnosis(id, { finalDx: "محاولة تعديل بعد الاعتماد" }, "متعديل", (await db.getCephStudy(id)).diagnosis);
  // BEGIN READONLY COMPLETION REPLAY
  const readSealState = async () => (await db.getPool().query(
    `SELECT jsonb_build_object('analysis',(SELECT to_jsonb(a) FROM ceph_analyses a WHERE id=$1),
      'witness',(SELECT to_jsonb(p) FROM ceph_completion_provenance p WHERE analysis_id=$1),
      'measurements',(SELECT jsonb_agg(to_jsonb(m) ORDER BY code) FROM ceph_measurements m WHERE analysis_id=$1),
      'audit',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM audit_log l WHERE entity='ceph_analysis' AND entity_id=$1::text)) AS state`, [id])).rows[0].state;
  const beforeReplay = JSON.stringify(await readSealState());
  const again = await db.completeCephAnalysis(id, doctor, completionSnapshot(await db.getCephStudy(id)), session, reviewedSources);
  check("المعتمد لا تُلمس معالمه", afterEdit.ok === false);
  check("المعتمد لا يُعاد تمعيره", afterCal.ok === false);
  check("التشخيص المُختم لا يُعدّل", afterDx.ok === false);
  check("إعادة طلب الاعتماد نفسه قرائية بلا توقيع أو أثر تدقيق جديد", again.ok === true
    && JSON.stringify(await readSealState()) === beforeReplay);
  // END READONLY COMPLETION REPLAY
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
  // BEGIN VERSIONED EI SCENARIO: independent synthetic inputs, no patient data.
  // FH/PP horizontal, AB vertical, MP24° => CF156. Incisor axes +65°/−65°
  // => INTER130. The tilted E-line gives perpendicular UL2/LL3 mm.
  // EI = 156 + (130−130)/5 − 2 − 3 = 151, not an extraction decision.
  const rad = (degrees) => degrees * Math.PI / 180;
  const EI_POINTS = {
    S: [0, 0], N: [100, 0], Po: [0, 20], Or: [100, 20],
    PNS: [0, 40], ANS: [100, 40], A: [80, 60], B: [80, 120],
    Go: [0, 130], Me: [100 * Math.cos(rad(24)), 130 + 100 * Math.sin(rad(24))],
    U1A: [60, 60], U1: [60 + 20 * Math.cos(rad(65)), 60 + 20 * Math.sin(rad(65))],
    L1A: [60, 150], L1: [60 + 20 * Math.cos(rad(-65)), 150 + 20 * Math.sin(rad(-65))],
    Prn: [100, 20], PogS: [40, 100], Ls: [77.6, 53.2], Li: [54.4, 85.8],
    Pog: [90, 160], Gn: [90, 165], OcclP: [0, 100], OcclA: [100, 100],
  };
  const eiPoints = Object.fromEntries(Object.entries(EI_POINTS).map(([code, [x, y]]) => [code, { x, y }]));
  check("معيار EI التركيبي مستقل: CF156 وINTER130 وUL2 وLL3 دون Sn",
    [["CF", 156], ["INTER", 130], ["E_LINE_UL", 2], ["E_LINE_LL", 3], ["EI_KIM_1996", 151]]
      .every(([code, expected]) => Math.abs(ceph.measure(code, eiPoints, 1) - expected) < 1e-9)
    && ceph.missingFor("EI_KIM_1996", eiPoints).length === 0);
  const eiCreated = await db.createCephAnalysis({ patientId: patient.id, documentId, createdBy: doctor });
  check("مسودة مستقلة لاختبار لقطة EI ذات الإصدار", eiCreated.ok);
  if (eiCreated.ok) {
    const eiId = Number(eiCreated.id);
    if (!Number.isSafeInteger(eiId) || eiId <= 0) throw new Error("Invalid synthetic EI identity");
    const eiCalibration = await db.updateCephCalibration(eiId,
      { x1: 10, y1: 10, x2: 110, y2: 10, mm: 100 }, doctor, calibrationState(await db.getCephStudy(eiId)));
    const eiLandmarks = await db.updateCephLandmarks(eiId,
      Object.entries(EI_POINTS).map(([code, [x, y]]) => ({ code, x, y })), doctor);
    check("مدخلات EI الكاملة ومعايرته تُحفظ", eiCalibration.ok && eiLandmarks.ok);
    const eiReviewed = await db.getCephStudy(eiId);
    if (eiReviewed?.completionSources?.state !== "available") throw new Error("Synthetic EI completion sources unavailable");
    const eiApproved = await db.completeCephAnalysis(eiId, doctor, completionSnapshot(eiReviewed), session, eiReviewed.completionSources.identity);
    check("اعتماد EI الوصفي بمدخلاته الكاملة يمرّ", eiApproved.ok);
    const eiReopened = await db.getCephStudy(eiId);
    const eiVisible = await db.getCephStampedValues(eiId);
    const { rows: eiRaw } = await db.getPool().query(
      `SELECT code, value FROM ceph_measurements WHERE analysis_id = $1`, [eiId],
    );
    check("EI_KIM_1996=151 محفوظ تحت رمزه ذي الإصدار بعد إعادة الفتح دون EXT_INDEX",
      [eiApproved.measurements, eiReopened?.measurements, eiVisible, eiRaw].every((rows) =>
        Array.isArray(rows) && rows.filter((row) => row.code === "EI_KIM_1996").length === 1
        && rows.find((row) => row.code === "EI_KIM_1996")?.value === 151
        && rows.every((row) => row.code !== "EXT_INDEX")));
  }
  // END VERSIONED EI SCENARIO
} catch (error) {
  console.error("فشل الفحص بخطأ غير متوقع:", error.message);
  failed = true;
} finally {
  // Close only this journey's runtime pool before removing its own database.
  // Failed CREATE (including a collision) never grants permission to DROP.
  if (db) {
    try { await db.getPool().end(); }
    catch { failed = true; console.error("CEPH_CLEANUP_FAILED: runtime pool shutdown failed."); }
  }
  if (databaseCreated) {
    try { await admin.query(`DROP DATABASE "${temporary}"`); }
    catch { failed = true; console.error("CEPH_CLEANUP_FAILED: owned temporary database cleanup failed."); }
  }
  try { await admin.end(); }
  catch { failed = true; console.error("CEPH_CLEANUP_FAILED: admin shutdown failed."); }
}

if (failed) { console.error("\nالنتيجة: فحص السيفالو سقط — راجع البنود أعلاه."); process.exit(1); }
console.log("\nالنتيجة: التحليل السيفالومتري سجلٌّ يُعتمد عليه.");
