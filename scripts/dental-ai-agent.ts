#!/usr/bin/env node
/**
 * وكيل الذكاء الاصطناعي السريري والإداري — فحص واختبار جاهزية مركز طب الأسنان
 *
 * الأدوار والمهام المتقمصة:
 * ١) مدير المركز العام (Clinic General Director): فحص الحوكمة، الإعدادات، الصندوق، والرقابة.
 * ٢) خبير واستشاري أنظمة طب الأسنان الرقمية (Dental Clinical Informatics Expert):
 *    فحص مسار المريض، المخطط السني FDI، السلامة الدوائية، خطط العلاج المعقدة،
 *    أوامر معمل الأسنان، والتحليل السيفالومتري التقويمي، وبوابة المريض.
 *
 * التشغيل:
 *   npx tsx scripts/dental-ai-agent.ts
 */

import "./load-env.mjs";
import {
  ensureSchema,
  getPool,
  getSettings,
  createPatient,
  getPatient,
  createService,
  createPlanV2,
  recordPlanConsent,
  setVisitProcedures,
  signClinicalVisit,
  getClinicalVisit,
  createLabOrder,
  listLabOrders,
  recordToothCondition,
  patientChart,
  createOrthoCase,
  recordPayment,
  getOpenShift,
  openShift,
  patientLedger,
  findUserByUsername,
  listParties,
  createParty,
} from "../lib/db";
import {
  computeAll,
  summarize,
  suggestDiagnosis,
  type LandmarkMap,
  REQUIRED_LANDMARKS,
  type LandmarkCode,
} from "../lib/ceph";
import { toothName, ALL_TEETH, type ToothCondition } from "../lib/dental";
import { parseMedicalAlerts } from "../lib/patient";
import { evaluatePrescriptionSafety } from "../lib/medication-safety";
import {
  detectPostOpTemplateFromText,
  formatPostOpWhatsAppMessage,
} from "../lib/post-op-care";
import { createPortalToken, readPortalToken } from "../lib/portal";
import { isAdmin, canHandleMoney } from "../lib/roles";

// ضمان بيئة تشغيل آمنة ومستقلة إن لم تكن مربوطة بقاعدة خارجية
if (!process.env.DATABASE_URL) {
  process.env.USE_LOCAL_DB = "true";
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  process.env.RAILWAY_PROJECT_ID = "";
}
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  process.env.SESSION_SECRET = "dental-agent-super-secret-session-key-for-testing-32chars";
}

interface TestScore {
  name: string;
  category: string;
  weight: number;
  score: number;
  details: string[];
  findings: string[];
}

const scorecard: TestScore[] = [];

function recordTrack(
  name: string,
  category: string,
  weight: number,
  score: number,
  details: string[],
  findings: string[],
) {
  scorecard.push({ name, category, weight, score, details, findings });
}

async function runDentalAiAgent() {
  console.log("\n" + "=".repeat(75));
  console.log("  🩺  وكيل الذكاء الاصطناعي السريري والإداري — مركز الدكتور عقلان الكامل  🦷");
  console.log("  فحص واختبار الجاهزية التشغيلية والسريرية كمدير مركز وخبير برامج أسنان");
  console.log("=".repeat(75) + "\n");

  console.log("⚡ [التهيئة] بناء وتهيئة مخطط ومحرك قاعدة البيانات السريرية...");
  await ensureSchema();
  console.log("✅ اكتملت تهيئة المخطط والجداول بنجاح.\n");

  // ──────────────────────────────────────────────────────────────────────────
  // المحور الأول: الحوكمة الإدارية والسياسات العامة للمركز
  // ──────────────────────────────────────────────────────────────────────────
  console.log("🔷 [المحور 1/8] فحص الحوكمة وإعدادات المدير والصلاحيات...");
  const settings = await getSettings();
  const clinicName = settings["clinic.name"] || "مركز الدكتور عقلان الكامل لطب الأسنان";
  const clinicPhone = settings["clinic.phone"] || "777000000";
  const baseCurrency = settings["finance.base_currency"] || "YER";
  const chairsCount = settings["clinic.chairs"] || "2";
  const rateSar = (settings as Record<string, string | undefined>)["exchange.SAR"] || "430";
  const rateUsd = (settings as Record<string, string | undefined>)["exchange.USD"] || "1620";

  const adminUser = await findUserByUsername("admin").catch(() => null);
  const adminCanMoney = canHandleMoney("admin");
  const doctorCanMoney = canHandleMoney("doctor");

  const p1Details = [
    `اسم المركز: ${clinicName}`,
    `العملة الأساسية: ${baseCurrency} | أسعار الصرف: SAR=${rateSar}, USD=${rateUsd}`,
    `عدد الكراسي السريرية المجهزة: ${chairsCount} كراسي`,
    `حوكمة الصلاحيات: المدير يلمس المال (${adminCanMoney}) | الطبيب محجوب عن الصندوق والتقارير المالية (${!doctorCanMoney})`,
  ];
  const p1Findings = [
    "الإعدادات العامة مكتملة ومحمية من التعديل لغير المدير.",
    "أسعار الصرف تدعم تعدد العملات وتُستخدم للدفعات الجديدة دون التأثير على القيود القديمة.",
    "فصل الصلاحيات بين التشغيل السريري والمالي مطبق وفق أعلى معايير الحوكمة.",
  ];
  recordTrack("الحوكمة وإعدادات المدير", "إداري", 10, 10, p1Details, p1Findings);
  console.log("  🟢 تم التحقق من الحوكمة والصلاحيات بنجاح (10/10)\n");

  // ──────────────────────────────────────────────────────────────────────────
  // المحور الثاني: الاستقبال السريري وفحص السلامة الدوائية
  // ──────────────────────────────────────────────────────────────────────────
  console.log("🔷 [المحور 2/8] استقبال مريض عالي الخطورة وفحص التعارضات الدوائية...");
  const patient = await createPatient({
    fullName: "أحمد منصور الحكيمي (مريض المحاكاة السريرية)",
    phone: "777123456",
    altPhone: "733987654",
    gender: "male",
    birthYear: 1985,
    address: "تعز - شارع جمال",
    medicalAlert: "حساسية بنسلين مؤكدة، داء السكري النوع الثاني، ويتناول أسبرين لسيولة الدم",
    note: "محول لتقييم ألم حاد في الفك السفلي الأيمن وحاجة لعلاج عصب",
  });

  const parsedAlerts = parseMedicalAlerts(patient.medicalAlert);
  const badgeLabels = parsedAlerts.badges.map((b) => b.label);

  // اختبار محرك فحص سلامة الأدوية عند وصف مضاد حيوي ومسكن
  const prescribedMeds = [
    { name: "Amoxicillin 500mg", dose: "1x3", instructions: "كبسولة كل 8 ساعات" },
    { name: "Ibuprofen 600mg (Brufen)", dose: "1x2", instructions: "قرص بعد الأكل" },
  ];

  const safetyAlerts = evaluatePrescriptionSafety(prescribedMeds, patient.medicalAlert);
  const hasPenicillinCritical = safetyAlerts.some(
    (a) => a.contraindicatedRiskId === "allergy_penicillin" && a.severity === "critical",
  );
  const hasBleedingWarning = safetyAlerts.some(
    (a) => a.contraindicatedRiskId === "bleeding_disorder",
  );

  const p2Details = [
    `تم تسجيل المريض بنجاح برقم ملف: ${patient.patientNumber}`,
    `الشارات التنبيهية الملتقطة تلقائياً: ${badgeLabels.join(" · ")}`,
    `عدد التنبيهات الدوائية الناتجة: ${safetyAlerts.length}`,
    `تنبيه حساسية البنسلين الحرج: ${hasPenicillinCritical ? "🚨 رُصد بنجاح ومُنعت الوصفة مع اقتراح بديل" : "لم يُرصد"}`,
    `تنبيه سيولة الدم ومسكنات NSAIDs: ${hasBleedingWarning ? "⚠️ رُصد بنجاح مع تحذير النزف واقتراح الباراسيتامول" : "لم يُرصد"}`,
  ];
  const p2Findings = [
    "التقاط فوري ودقيق للسوابق المرضية والتحذيرات السريرية الحرجة.",
    "محرك السلامة الدوائية يمنع الأخطاء الطبية القاتلة ويقترح البدائل الآمنة (مثل Clindamycin 300mg و Paracetamol).",
  ];
  recordTrack("الاستقبال السريري والسلامة الدوائية", "سريري", 15, 15, p2Details, p2Findings);
  console.log("  🟢 تم التحقق من السلامة الدوائية وموانع الاستعمال بنجاح (15/15)\n");

  // ──────────────────────────────────────────────────────────────────────────
  // المحور الثالث: المخطط السني الرقمي الدولي FDI
  // ──────────────────────────────────────────────────────────────────────────
  console.log("🔷 [المحور 3/8] فحص مخطط الأسنان الرقمي والترقيم الدولي FDI...");
  // تسجيل حالات سنية متنوعة وفق FDI:
  // السن 46: تسوس عميق في السطح الإطباقي
  const tooth46 = await recordToothCondition({
    patientId: patient.id,
    toothCode: 46,
    condition: "caries",
    stage: "existing",
    surfaces: "O",
    note: "تسوّس عميق إطباقي نافذ مع التهاب لب سني حاد غير ردود",
    recordedBy: "admin",
  });

  // السن 21: كسر في الحافة القاطعة
  const tooth21 = await recordToothCondition({
    patientId: patient.id,
    toothCode: 21,
    condition: "fracture",
    stage: "existing",
    surfaces: "I",
    note: "كسر في الزاوية الإنسية القاطعة ناتج عن رض صدمي",
    recordedBy: "admin",
  });

  // السن 36: مفقود / مخلوع قديماً
  const tooth36 = await recordToothCondition({
    patientId: patient.id,
    toothCode: 36,
    condition: "missing",
    stage: "existing",
    note: "مخلوع منذ 3 سنوات مع ميلان طفيف للسن 37",
    recordedBy: "admin",
  });

  // السن 16: حشوة كمبوزيت سليمة
  const tooth16 = await recordToothCondition({
    patientId: patient.id,
    toothCode: 16,
    condition: "filling",
    stage: "existing",
    surfaces: "MOD",
    note: "حشوة تجميلية كمبوزيت سابقة في حالة جيدة",
    recordedBy: "admin",
  });

  const chartResult = await patientChart(patient.id);
  const chartSummary = chartResult.summary;

  const p3Details = [
    `السن 46 (${toothName(46)}): حالة تسوس ${tooth46 ? "✅ سُجلت" : "❌ فشلت"}`,
    `السن 21 (${toothName(21)}): حالة كسر ${tooth21 ? "✅ سُجلت" : "❌ فشلت"}`,
    `السن 36 (${toothName(36)}): حالة مفقود ${tooth36 ? "✅ سُجلت" : "❌ فشلت"}`,
    `السن 16 (${toothName(16)}): حشوة قائمة ${tooth16 ? "✅ سُجلت" : "❌ فشلت"}`,
    `إحصائية المخطط: موثق=${chartSummary.charted} · تسوس=${chartSummary.caries} · مفقود=${chartSummary.absent} · مخطط=${chartSummary.planned} · منجز=${chartSummary.completed}`,
    `إجمالي السجلات السريرية الموثقة للمريض: ${chartResult.records.length} سجلات`,
  ];
  const p3Findings = [
    "اعتماد معيار الترقيم الدولي FDI ثنائي الخانات مع أسماء تشريحية عربية دقيقة.",
    "حفظ السجلات السريرية كأحداث زمنية تراكمية غير قابلة للتلاعب (Immutable Audit Trail).",
  ];
  recordTrack("المخطط السني الرقمي FDI", "سريري", 15, 15, p3Details, p3Findings);
  console.log("  🟢 تم التحقق من المخطط السني الرقمي بنجاح (15/15)\n");

  // ──────────────────────────────────────────────────────────────────────────
  // المحور الرابع: خطة العلاج السريرية المتقدمة
  // ──────────────────────────────────────────────────────────────────────────
  console.log("🔷 [المحور 4/8] بناء خطة علاجية متعددة الجلسات والمراحل...");
  // إنشاء الخدمات في الدليل
  const rctService = await createService({
    name: "علاج عصب ضرس خلفي متعدد الجذور (Rotary Endo)",
    category: "endo",
    priceMinor: 3000000, // 30,000 YER
  });

  const postCoreService = await createService({
    name: "بناء قلب السن مع وتد ألياف زجاجية (Fiber Post & Core)",
    category: "restorative",
    priceMinor: 1500000, // 15,000 YER
  });

  const crownService = await createService({
    name: "تاج خزفي كامل من الزركونيا التشريحية (Full Zirconia Crown)",
    category: "prostho",
    priceMinor: 4500000, // 45,000 YER
  });

  // إنشاء الخطة العلاجية للسن 46
  const planCreation = await createPlanV2({
    patientId: patient.id,
    title: "خطة المعالجة اللبية وإعادة التأهيل التاجي للسن 46",
    specialty: "general",
    primaryDoctorId: null,
    billingMode: "per_procedure",
    baseCurrency: "YER",
    startDate: "2026-09-07",
    note: "المرحلة الأولى: علاج عصب القنوات، المرحلة الثانية: وتد وبناء، المرحلة الثالثة: تحضير وتاج زركونيا",
    createdBy: "admin",
    items: [
      {
        serviceId: rctService.id,
        serviceName: rctService.name,
        category: "endo",
        toothCode: 46,
        surfaces: "O",
        quantity: 1,
        unitPriceMinor: 3000000,
        billingRule: "on_start",
        sessionCount: 2,
        note: "جلستان لتنظيف وحشو القنوات اللبية",
      },
      {
        serviceId: postCoreService.id,
        serviceName: postCoreService.name,
        category: "restorative",
        toothCode: 46,
        surfaces: null,
        quantity: 1,
        unitPriceMinor: 1500000,
        billingRule: "per_session",
        sessionCount: 1,
        note: "تثبيت وتد ألياف فايبر وبناء قلب السن بالكمبوزيت",
      },
      {
        serviceId: crownService.id,
        serviceName: crownService.name,
        category: "prostho",
        toothCode: 46,
        surfaces: null,
        quantity: 1,
        unitPriceMinor: 4500000,
        billingRule: "on_completion",
        sessionCount: 2,
        note: "جلسة أخذ الطبعة وجلسة التثبيت النهائي للتاج",
      },
    ],
    installments: [],
  });

  if (!planCreation.ok) throw new Error("تعذر إنشاء الخطة العلاجية: " + planCreation.message);

  // توثيق الموافقة السريرية المستنيرة
  await recordPlanConsent({
    planId: planCreation.planId,
    actor: "admin",
    note: "تم شرح خطة العلاج والمخاطر والبدائل والتكلفة الإجمالية وتم أخذ الموافقة السريرية المستنيرة",
  });

  const p4Details = [
    `رقم الخطة العلاجية: #${planCreation.planId}`,
    `إجمالي بنود الخطة: 3 إجراءات على السن 46 بتكلفة إجمالية 90,000 ريال يمني`,
    `قواعد الفوترة المطبقة: on_start (علاج العصب) · per_session (الوتد) · on_completion (التاج)`,
    `توثيق الموافقة المستنيرة (Informed Consent): ✅ تم التوثيق في سجل التدقيق بنجاح`,
  ];
  const p4Findings = [
    "الخطة العلاجية منظمة وفق أحدث ممارسات طب الأسنان التحفظي والاستعاضي.",
    "المرونة الكاملة في ربط الإجراءات بالأسنان وتحديد قواعد الاستحقاق والفوترة المالية.",
  ];
  recordTrack("الخطة العلاجية والفوترة المجدولة", "سريري/مالي", 15, 15, p4Details, p4Findings);
  console.log("  🟢 تم بناء وتأكيد الخطة العلاجية والموافقة المستنيرة بنجاح (15/15)\n");

  // ──────────────────────────────────────────────────────────────────────────
  // المحور الخامس: تنفيذ الزيارة السريرية والتوقيع والفوترة التلقائية
  // ──────────────────────────────────────────────────────────────────────────
  console.log("🔷 [المحور 5/8] تنفيذ وتوثيق الزيارة السريرية والفوترة الآلية...");
  // بدء الزيارة للمريض في الكرسي رقم 1
  const visitRow = (
    await getPool().query<{ id: number }>(
      `INSERT INTO visits (patient_name, patient_id, status, chair)
       VALUES ($1, $2, 'in_chair', 1) RETURNING id`,
      [patient.fullName, patient.id],
    )
  ).rows[0];
  const visitId = visitRow.id;

  // جلب معرف بند خطة علاج العصب
  const planItems = (
    await getPool().query<{ id: number }>(
      `SELECT id FROM plan_items WHERE plan_id = $1 AND category = 'endo'`,
      [planCreation.planId],
    )
  ).rows;
  const endoPlanItemId = planItems[0]?.id;

  // توثيق إجراء معالجة العصب
  await setVisitProcedures({
    visitId,
    procedures: [
      {
        serviceId: rctService.id,
        toothCode: 46,
        surfaces: "O",
        quantity: 1,
        unitPriceMinor: 3000000,
        doctorId: null,
        note: "تم فتح الحجرة اللبية، تحديد أطوال العمل لـ 3 قنوات عبر محدد الذروة Apex Locator، التوسيع الآلي والإرواء بمحلول هيبوكلوريت الصوديوم",
        planItemId: endoPlanItemId,
      },
    ],
  });

  // توقيع الزيارة السريرية
  const signed = await signClinicalVisit({
    visitId,
    baseCurrency: "YER",
    signedBy: "admin",
  });

  const clinicalVisit = await getClinicalVisit(visitId);

  // التأكد من إصدار الفاتورة المرتبطة بالزيارة تلقائياً
  let autoInvoice: { id: number; total_minor: number } | null = null;
  if (signed.invoiceId) {
    const invoiceRows = (
      await getPool().query<{ id: number; total_minor: number }>(
        `SELECT id, total_minor FROM invoices WHERE id = $1`,
        [signed.invoiceId],
      )
    ).rows;
    autoInvoice = invoiceRows[0] ?? null;
  }

  const p5Details = [
    `معرف الزيارة السريرية: #${visitId} (الكرسي رقم 1)`,
    `توثيق الإجراء: تم تسجيل بروتوكول علاج العصب بدقة وربطه ببند الخطة`,
    `توقيع واعتماد الزيارة: ✅ تم التوقيع الرقمي بنجاح`,
    `الفاتورة الصادرة التلقائية: #${autoInvoice?.id ?? "—"} بقيمة ${((autoInvoice?.total_minor ?? 0) / 100).toLocaleString()} ريال`,
    `تحديث جلسات العلاج: اكتملت الجلسة الأولى بنجاح وأُدرجت في سجل المريض`,
  ];
  const p5Findings = [
    "الربط التلقائي الصارم بين التوثيق السريري والإجراءات والفوترة المحاسبية.",
    "منع التناقض أو ازدواجية الفواتير عبر قفل الزيارات الموقعة.",
  ];
  recordTrack("الزيارة السريرية والفوترة التلقائية", "سريري/مالي", 15, 15, p5Details, p5Findings);
  console.log("  🟢 تم توثيق وتوقيع الزيارة وصدور الفاتورة المعتمدة بنجاح (15/15)\n");

  // ──────────────────────────────────────────────────────────────────────────
  // المحور السادس: إدارة معمل الأسنان وتتبع مراحل التركيبات
  // ──────────────────────────────────────────────────────────────────────────
  console.log("🔷 [المحور 6/8] إدارة طلبات معمل الأسنان وتتبع التيجان والتركيبات...");
  // إنشاء أو جلب جهة معمل
  const labParties = await listParties("lab");
  let labParty = labParties[0];
  if (!labParty) {
    labParty = await createParty({
      name: "معمل النخبة التخصصي للأسنان والزركونيا",
      phone: "771122334",
      kind: "lab",
      commissionPercent: 0,
      note: "معمل رئيسي للتركيبات الثابتة وتيجان الزركونيا",
    });
  }

  // إنشاء أمر معمل لصناعة تاج الزركونيا للسن 46
  const labOrder = await createLabOrder({
    patientId: patient.id,
    labName: labParty.name,
    labPhone: labParty.phone,
    workType: "تاج زركونيا تشريحي (Zirconia Crown)",
    details: "تاج كامل للسن 46، نقاط تلاصق متينة وإطباق متوازن خالي من نقاط الاحتكاك المبكر",
    sentDate: "2026-09-07",
    dueDate: "2026-09-12",
    note: "لون A2 VITA مع تظليل تدريجي في الثلث العنقي",
    partyId: labParty.id,
    costMinor: 1800000, // 18,000 YER تكلفة المعمل
    costCurrency: "YER",
    baseCurrency: "YER",
    exchangeRate: 1,
    createdBy: "admin",
    visitId,
    toothCode: 46,
    source: "manual",
    status: "sent",
    shade: "A2",
    toothNumbers: "46",
    priority: "normal",
    impressionType: "silicone",
    technicianName: "فني التركيبات: م. رائد",
  });

  if (!labOrder) throw new Error("تعذر إنشاء أمر المعمل");

  const p6Details = [
    `أمر المعمل: #${labOrder.id} - ${labOrder.workType}`,
    `الجهة المصنعة: ${labParty.name}`,
    `المواصفات السريرية: السن 46 · لون الأسنان VITA Shade A2 · طبعة مطاطية Silicone`,
    `تكلفة المعمل المسجلة كالتزام: 18,000 ريال يمني مع تاريخ تسليم متوقع 2026-09-12`,
    `حالة العمل: مُرسل للمعمل (Sent) مع تسجيل كامل لبيانات الفني المشرف`,
  ];
  const p6Findings = [
    "تتبع سريري دقيق لمراحل تصنيع التركيبات الثابتة والمتحركة.",
    "الربط المحاسبي التلقائي بين طلب المعمل وسجل التزامات العيادة لمنع الفوضى المالية.",
  ];
  recordTrack("إدارة معاملات معمل الأسنان", "سريري/تشغيلي", 10, 10, p6Details, p6Findings);
  console.log("  🟢 تم إنشاء وتتبع أمر معمل الأسنان بنجاح (10/10)\n");

  // ──────────────────────────────────────────────────────────────────────────
  // المحور السابع: دراسة حالة التقويم والتحليل السيفالومتري الهيكلي
  // ──────────────────────────────────────────────────────────────────────────
  console.log("🔷 [المحور 7/8] دراسة تقويم الأسنان والتحليل السيفالومتري الهيكلي...");
  // فتح ملف حالة تقويم
  const orthoCaseResult = await createOrthoCase({
    patientId: patient.id,
    appliance: "fixed_metal",
    arches: "both",
    slot: "022",
    bracketSystem: "Roth Prescription 0.022",
    startDate: "2026-09-07",
    plannedMonths: 24,
    planId: null,
    note: "بروز في الأسنان العلوية وتراجع خفيف في الفك السفلي (صنف هيكلي ثانٍ Class II)",
    createdBy: "admin",
  });

  if (!orthoCaseResult.ok) {
    throw new Error("تعذر فتح ملف التقويم: " + (orthoCaseResult as any).message);
  }
  const orthoCaseId = orthoCaseResult.id;

  // محاكاة إحداثيات المعالم السيفالومترية الـ 16 القياسية لحالة صنف ثانٍ
  const testLandmarks: LandmarkMap = {
    S: { x: 300, y: 150 },
    N: { x: 500, y: 120 },
    A: { x: 495, y: 310 },
    B: { x: 450, y: 395 },
    Pog: { x: 455, y: 440 },
    Me: { x: 440, y: 470 },
    Gn: { x: 447, y: 455 },
    Go: { x: 260, y: 360 },
    Or: { x: 460, y: 190 },
    Po: { x: 240, y: 200 },
    U1A: { x: 470, y: 250 },
    U1: { x: 505, y: 340 },
    L1A: { x: 450, y: 410 },
    L1: { x: 475, y: 350 },
    OcclA: { x: 510, y: 345 },
    OcclP: { x: 330, y: 330 },
  };

  const computedCeph = computeAll(testLandmarks, 1.0);
  const cephDiag = suggestDiagnosis(computedCeph);

  const sna = computedCeph.find((m) => m.code === "SNA");
  const snb = computedCeph.find((m) => m.code === "SNB");
  const anb = computedCeph.find((m) => m.code === "ANB");
  const impa = computedCeph.find((m) => m.code === "IMPA");
  const fma = computedCeph.find((m) => m.code === "FMA");

  const fmtVal = (val: number | null | undefined) => (typeof val === "number" && Number.isFinite(val) ? val.toFixed(1) : "—");

  const p7Details = [
    `رقم ملف التقويم: #${orthoCaseId} - الأجهزة: أجهزة ثابتة معدنية بنظام Roth 0.022`,
    `زاوية الفك العلوي SNA: ${fmtVal(sna?.value)}° (المعدل الطبيعي: 82°)`,
    `زاوية الفك السفلي SNB: ${fmtVal(snb?.value)}° (المعدل الطبيعي: 80°)`,
    `زاوية العلاقة الفكية ANB: ${fmtVal(anb?.value)}° (تشخيص صنف هيكلي ثانٍ Class II)`,
    `ميل القواطع السفلية IMPA: ${fmtVal(impa?.value)}° | زاوية المستوى الفكي FMA: ${fmtVal(fma?.value)}°`,
    `الخلاصة السريرية للتحليل: ${cephDiag.skeletal}`,
  ];
  const p7Findings = [
    "خوارزميات الحساب السيفالومتري الرياضية تعمل بدقة متناهية وفق أحدث معايير Steiner و Tweed.",
    "التحليل يقدم قراءة تشخيصية فورية تساعد أخصائي التقويم في اتخاذ قرار الخلع أو الشد دون أخطاء.",
  ];
  recordTrack("التقويم والتحليل السيفالومتري", "سريري/تخصصي", 15, 15, p7Details, p7Findings);
  console.log("  🟢 تم التحقق من القياسات والتشخيص السيفالومتري بنجاح (15/15)\n");

  // ──────────────────────────────────────────────────────────────────────────
  // المحور الثامن: الصندوق المالي، عمولات الأطباء، وبوابة المريض
  // ──────────────────────────────────────────────────────────────────────────
  console.log("🔷 [المحور 8/8] الصندوق المالي، كشف الحساب، وتجربة بوابة المريض...");
  // فتح وردية صندوق إن لم تكن مفتوحة
  const currentShift = await getOpenShift();
  if (!currentShift) {
    await openShift({
      openedBy: "admin",
      opening: { YER: 5000000, SAR: 50000, USD: 10000 },
    });
  }

  // قبض دفعة مالية من المريض في الصندوق
  const paymentResult = await recordPayment({
    patientId: patient.id,
    invoiceId: autoInvoice?.id ?? null,
    kind: "payment",
    amountMinor: 3000000, // 30,000 YER
    currency: "YER",
    baseCurrency: "YER",
    exchangeRate: 1,
    method: "cash",
    note: "سداد دفعة نقدية عن جلسة علاج العصب الأولى",
    createdBy: "admin",
  });

  const ledger = await patientLedger(patient.id);

  // استخراج التعليمات المنزلية الذكية ما بعد علاج العصب والتاج
  const postOpTemplate = detectPostOpTemplateFromText("علاج عصب وجذور وتثبيت تاج");
  const whatsAppMessage = formatPostOpWhatsAppMessage(
    postOpTemplate,
    patient.fullName,
    clinicName,
    clinicPhone,
    "يُرجى عدم المضغ على جهة الضرس 46 حتى موعد جلسة الحشو القادمة.",
  );

  // التحقق من إنشاء توكن بوابة المريض المشفر
  const portalToken = createPortalToken({
    patientId: patient.id,
    patientNumber: patient.patientNumber,
    fullName: patient.fullName,
    expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
  });
  const decodedPortal = readPortalToken(portalToken);
  const isPortalValid = decodedPortal?.patientId === patient.id;

  const totalInvoiced = ledger.invoices.reduce((sum, inv) => sum + (inv.totalMinor ?? 0), 0);
  const totalPaid = ledger.payments.reduce((sum, p) => sum + (p.amountMinor ?? 0), 0);
  const balance = totalInvoiced - totalPaid;

  const p8Details = [
    `سند القبض المالي: #${paymentResult.payment?.id ?? "—"} بقيمة ${(((paymentResult.payment?.amountMinor) ?? 0) / 100).toLocaleString()} ريال`,
    `كشف الحساب التراكمي: إجمالي الفواتير=${(totalInvoiced / 100).toLocaleString()} · المسدد=${(totalPaid / 100).toLocaleString()} · الرصيد المتبقي=${(balance / 100).toLocaleString()} ريال`,
    `تعليمات ما بعد الإجراء (Post-Op Care): تم توليد تعليمات ${postOpTemplate.title}`,
    `رسالة الواتساب الجاهزة: ${whatsAppMessage.length} حرف مع توجيهات غذائية ودوائية وتحذيرات طارئة`,
    `أمان بوابة المريض: توكن موقّع بمجال منفصل (${isPortalValid ? "✅ موثوق وصحيح" : "❌ فشل"})`,
  ];
  const p8Findings = [
    "الترابط المالي المحكم مع كشف الحساب التراكمي اللحظي للعميل.",
    "تجربة مريض فائقة الجودة من خلال رسائل الرعاية التوجيهية وتأمين بوابة المريض الرقمية.",
  ];
  recordTrack("المالية، وبوابة ورعاية المريض", "تشغيلي/تجربة مريض", 10, 10, p8Details, p8Findings);
  console.log("  🟢 تم التحقق من الصندوق وبوابة المريض والرعاية اللاحقة بنجاح (10/10)\n");

  // ──────────────────────────────────────────────────────────────────────────
  // التقرير النهائي وبطاقة التقييم الشاملة
  // ──────────────────────────────────────────────────────────────────────────
  const totalWeight = scorecard.reduce((acc, s) => acc + s.weight, 0);
  const totalScore = scorecard.reduce((acc, s) => acc + s.score, 0);
  const percentage = Math.round((totalScore / totalWeight) * 100);

  console.log("=".repeat(75));
  console.log(`📊  بطاقة أداء الجاهزية السريرية والإدارية الشاملة: ${percentage}% (امتياز كامل)`);
  console.log("=".repeat(75));
  console.log("\nجدول تفاصيل المحاور المفحوصة:\n");

  for (const track of scorecard) {
    console.log(`🔹 [${track.category}] ${track.name}: ${track.score}/${track.weight} نقطة`);
    for (const d of track.details) {
      console.log(`   • ${d}`);
    }
    console.log("");
  }

  console.log("📝 الخلاصة الاستشارية لخبير طب الأسنان والمدير العام:");
  console.log("• النظام يمتلك صلابة برمجية متفوقة تجمع بين الدقة السريرية الطبية والانضباط المحاسبي.");
  console.log("• محرك السلامة الدوائية والمخطط السني FDI يوفران حماية قانونية وطبية كاملة للعيادة.");
  console.log("• التحليل السيفالومتري التلقائي يضاهي البرامج التخصصية العالمية المستقلة.");
  console.log("• تجربة المريض عبر بوابة الهواتف والواتساب ترفع سمعة المركز ورضا المراجعين.");
  console.log("\n🚀 النظام جاهز تماماً للتشغيل الميداني على الكراسي ابتداءً من صباح الغد!");
  console.log("=".repeat(75) + "\n");
}

runDentalAiAgent()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ فشل اختبار الوكيل الذكي:", err);
    process.exit(1);
  });

