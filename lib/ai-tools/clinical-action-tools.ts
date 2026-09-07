/**
 * أدوات المساعد الذكي السريرية والتوجيهية المتقدمة (Clinical & Educational AI Action Tools)
 * لمركز الدكتور عقلان الكامل لطب وجراحة وتقويم الأسنان.
 *
 * تشمل:
 * 1. فحص وتوليد الروشتات مع الأمان الدوائي (recommend_prescription)
 * 2. إرشادات وتعليمات ما بعد العمليات السنية والواتساب (generate_post_op_care)
 * 3. الاستعلام الشامل عن أسعار وخدمات المركز الرسمية (get_service_pricing)
 */

import { getPatient, searchPatients, getSettings } from "../db";
import { evaluatePrescriptionSafety, type DrugInput } from "../medication-safety";
import { POST_OP_TEMPLATES, type PostOpTemplate, detectPostOpTemplateFromText } from "../post-op-care";
import { DEFAULT_SERVICES, CATEGORY_LABEL } from "../services-catalog";
import { formatMoney, isCurrency, type Currency } from "../money";
import { rateFromSettings } from "../settings";
import { toWhatsAppNumber } from "../reminders";
import type { AiToolContext, ToolExecutionResult, KpiCard, ActionButton, StructuredTable } from "./types";
import { verifyAiPatientAccess } from "./authorization";

// ─── 1. محرك دعم القرار السريري الدوائي (Doctor Clinical Decision Support) ───────

export async function recommendPrescriptionAction(
  params: {
    patientName?: string;
    patientId?: number;
    condition?: string;
    requestedDrugs?: string[];
    medicalAlert?: string;
    age?: number;
    weightKg?: number;
    isPregnant?: boolean;
    isLactating?: boolean;
    hasRenalDisease?: boolean;
    hasHepaticDisease?: boolean;
    hasBleedingDisorder?: boolean;
    activeMedications?: string[];
    confirmedDiagnosis?: string;
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  // P0-FIX-9: حصر الدعم السريري الدوائي على الطبيب المرخص فقط ومحظور على الاستقبال
  if (context.role !== "doctor") {
    return {
      success: false,
      textSummary: "🔒 **تنبيه أمني:** خدمة دعم القرار السريري الدوائي (CDS) مقتصرة حصراً على الطبيب المعالج المرخص، ومحظورة على موظفي الاستقبال أو الكادر غير الطبي.",
      warnings: ["محاولة استخدام أداة سريرية من غير طبيب"],
    };
  }

  // فحص عزل الأطباء وصلاحية الوصول لملف المريض (§39)
  const candidatePatient = params.patientId || params.patientName || context.currentPatientName;
  if (candidatePatient) {
    const accessCheck = await verifyAiPatientAccess(context, candidatePatient);
    if (!accessCheck.allowed) {
      return {
        success: false,
        textSummary: accessCheck.reason || "🔒 **تنبيه أمني (عزل الأطباء §39):** ليس لديك صلاحية للاطلاع على بيانات هذا المريض السريرية أو اقتراح أدوية له.",
        warnings: ["محاولة وصول دوائي لمريض غير مسند للطبيب"],
      };
    }
  }

  let patientName = params.patientName || context.currentPatientName || "المريض";
  let medicalAlert: string | null = params.medicalAlert || null;
  let patientId = params.patientId;

  const normCondition = (params.condition || "").toLowerCase().trim();
  if (!medicalAlert && (normCondition.includes("حساسية") || normCondition.includes("ضغط") || normCondition.includes("سكر") || normCondition.includes("حامل") || normCondition.includes("نزف"))) {
    medicalAlert = params.condition || null;
  }

  if (context.isDbConnected && (patientId || params.patientName || context.currentPatientName)) {
    let p = null;
    if (patientId) {
      p = await getPatient(patientId);
    } else {
      const queryName = params.patientName || context.currentPatientName || "";
      const matches = await searchPatients(queryName.trim(), 1);
      if (matches[0]) {
        // التحقق من صلاحية المريض المسترجع
        const access = await verifyAiPatientAccess(context, matches[0].id);
        if (access.allowed) {
          p = await getPatient(matches[0].id);
        }
      }
    }
    if (p) {
      patientName = p.fullName;
      if (p.medicalAlert) medicalAlert = p.medicalAlert;
      patientId = p.id;
    }
  }

  // P0-FIX-9: فحص كفاية السياق السريري ومنع توليد المضاد الحيوي بناء على كلمة مفردة
  const isSingleKeywordTrigger =
    normCondition === "خراج" ||
    normCondition === "سخونة" ||
    normCondition === "fever" ||
    normCondition === "ألم" ||
    normCondition === "التهاب";

  const hasSpecificDrugCheck = Array.isArray(params.requestedDrugs) && params.requestedDrugs.length > 0;
  const hasDetailedClinicalContext =
    Boolean(params.confirmedDiagnosis) ||
    (normCondition.length > 15 && (normCondition.includes("حساسية") || normCondition.includes("سنة") || normCondition.includes("أسبوع") || normCondition.includes("مزمن") || normCondition.includes("انتشار") || normCondition.includes("موضعي"))) ||
    medicalAlert !== null ||
    params.age !== undefined;

  if (isSingleKeywordTrigger || (!hasSpecificDrugCheck && !hasDetailedClinicalContext && normCondition.length < 10)) {
    return {
      success: false,
      textSummary: `⚠️ **نقص في السياق السريري الضروري (Missing Clinical Context):**\n\n` +
        `لا يمكن توليد اقتراح دوائي أو مضاد حيوي لمجرد ورود كلمة مفردة («${params.condition || "غير محدد"}») دون توفر السياق السريري الكافي لتقييم موانع الاستعمال (Contraindications).\n\n` +
        `يرجى تزويد المساعد بالبيانات السريرية الإلزامية التالية:\n` +
        `1. **العمر والوزن** (لتحديد الجرعة).\n` +
        `2. **التاريخ المرضي للحساسية** (وخاصة البنسلين ومضادات الالتهاب NSAIDs).\n` +
        `3. **الحمل أو الرضاعة الطبيعية** (للإناث في سن الإنجاب).\n` +
        `4. **وظائف الكبد والكلى واضطرابات النزف/السيولة**.\n` +
        `5. **الأدوية الفعالة الحالية والتشخيص السريري المؤكد ومصدر العدوى**.\n\n` +
        `💡 *ملاحظة:* عدم وجود تنبيه مسجل في الملف لا يعني عدم وجود موانع؛ يجب استقصاء الحالة سريرياً قبل وصف أي علاج. القرار النهائي للطبيب البشري.`,
      warnings: ["نقص في السياق السريري الضروري لسلامة الوصفة"],
    };
  }

  const drugs: DrugInput[] = [];

  // إذا تم طلب أدوية محددة للفحص
  if (params.requestedDrugs && params.requestedDrugs.length > 0) {
    for (const d of params.requestedDrugs) {
      drugs.push({ name: d, instructions: "حسب الوصفة المكتوبة" });
    }
  } else if (
    // المضادات الحيوية لا تُقترح إلا عند وجود مؤشرات سريرية صريحة للعدوى المنتشرة أو الخراج
    normCondition.includes("تورم صديدي منتشر") ||
    normCondition.includes("عدوى بكتيرية حادة منتشرة") ||
    normCondition.includes("cellulitis") ||
    (normCondition.includes("خراج") && (normCondition.includes("حرارة") || normCondition.includes("انتشار") || normCondition.includes("تورم في الوجه")))
  ) {
    drugs.push(
      { name: "Amoxicillin 500mg", instructions: "كبسولة كل 8 ساعات لمدة 5 أيام (يخضع لتقييم علامات العدوى الحادة)" },
      { name: "Flagyl 500mg", instructions: "قرص كل 8 ساعات بعد الأكل لمدة 5 أيام" },
      { name: "Ibuprofen 400mg", instructions: "قرص كل 8 ساعات لتسكين الألم وتقليل الالتهاب" },
    );
  } else if (normCondition.includes("خلع") || normCondition.includes("جراح") || normCondition.includes("عقل")) {
    // جراحة وخلع بدون عدوى: مسكنات ومضاد التهاب ومضمضة فقط (لا مضاد حيوي افتراضي)
    drugs.push(
      { name: "Ibuprofen 400mg", instructions: "قرص كل 8 ساعات بعد الأكل عند اللزوم لتسكين الألم" },
      { name: "Paracetamol 500mg", instructions: "قرصان كل 8 ساعات كمسكن مساند (أو بديل عند موانع NSAIDs)" },
      { name: "Chlorhexidine 0.12%", instructions: "مضمضة فموية مرتين يومياً بعد 24 ساعة من الجراحة" },
    );
  } else if (normCondition.includes("عصب") || normCondition.includes("لب") || normCondition.includes("ألم حاد")) {
    // علاج العصب وألم السن: مسكنات للألم الموضعي (المضاد الحيوي غير موصى به روتينياً دون انتشار)
    drugs.push(
      { name: "Ibuprofen 400mg", instructions: "قرص كل 8 ساعات بعد الوجبات" },
      { name: "Paracetamol 500mg", instructions: "قرصان عند اللزوم (بحد أقصى 4 جرام يومياً)" },
    );
  } else {
    // مسكنات قياسية مع توجيه سريري (منع المضاد الحيوي الافتراضي)
    drugs.push(
      { name: "Paracetamol 500mg", instructions: "قرص أو قرصان كل 6-8 ساعات عند اللزوم" },
      { name: "Ibuprofen 400mg", instructions: "قرص كل 8 ساعات بعد الطعام عند اللزوم" },
    );
  }

  // فحص التعارضات الدوائية مع ملف المريض
  const safetyAlerts = evaluatePrescriptionSafety(drugs, medicalAlert);
  const adjustedDrugs: DrugInput[] = [];
  const safetyCards: KpiCard[] = [];
  let warningMessage = "";

  for (const drug of drugs) {
    const alert = safetyAlerts.find((a) => a.medicationName.toLowerCase() === drug.name.toLowerCase());
    if (alert) {
      safetyCards.push({
        title: `⚠️ تعارض دوائي: ${drug.name}`,
        value: alert.title,
        tone: alert.severity === "critical" ? "bad" : "warn",
      });

      warningMessage += `\n🚨 **${alert.title}**: ${alert.message}`;
      if (alert.suggestedAlternative) {
        warningMessage += `\n💡 **بدائل آمنة مقترحة:** ${alert.suggestedAlternative}`;
        if (alert.contraindicatedRiskId === "allergy_penicillin") {
          adjustedDrugs.push({
            name: "Clindamycin 300mg",
            instructions: "كبسولة كل 8 ساعات لمدة 5 أيام (بديل آمن لحساسية البنسلين)",
          });
        } else if (alert.contraindicatedRiskId === "pregnancy" || alert.contraindicatedRiskId === "bleeding_disorder") {
          adjustedDrugs.push({
            name: "Paracetamol 1g",
            instructions: "قرص كل 8 ساعات بعد الأكل (بديل آمن خالٍ من مضادات الالتهاب غير الستيرويدية)",
          });
        }
      }
    } else {
      adjustedDrugs.push(drug);
    }
  }

  const alertStatusText = medicalAlert
    ? `⚠️ ${medicalAlert}`
    : "لا توجد موانع مسجلة في ملف المريض";

  const cards: KpiCard[] = [
    { title: "نوع الإجراء", value: "دعم قرار سريري (CDS) 🩺", tone: "info" },
    { title: "المريض", value: patientName, tone: "info" },
    { title: "التنبيهات السريرية", value: alertStatusText, tone: medicalAlert ? "warn" : "calm" },
    ...safetyCards,
  ];

  let rxText = `🩺 **اقتراح الأدوية ودعم القرار السريري (الروشتة المقترحة) لـ «${patientName}»**${params.condition ? ` (حالة: ${params.condition})` : ""}:\n\n` +
    `• **التنبيهات والموانع الصحية:** ${alertStatusText}\n\n` +
    `💊 **الأدوية المقترحة للمراجعة السريرية:**\n`;

  adjustedDrugs.forEach((d, idx) => {
    rxText += `${idx + 1}. **${d.name}**\n   • الجرعة الاسترشادية: ${d.instructions || "حسب تقييم الطبيب"}\n`;
  });

  if (!normCondition.includes("خراج") && !normCondition.includes("تورم صديدي") && !normCondition.includes("cellulitis")) {
    rxText += `\n💡 **ملاحظة سريرية (Stewardship):** لم يتم إدراج مضاد حيوي تلقائياً لعدم وجود مؤشرات لعدوى بكتيرية منتشرة، حيث تكفي المعالجة الموضعية والمسكنات.\n`;
  }

  if (warningMessage) {
    rxText += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🛡️ **فحص الأمان والتعارضات الدوائية (تحذيرات وتعارضات دوائية حرجة):**${warningMessage}\n`;
  }

  rxText += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `⚠️ **تنبيه إلزامي (المادة 214):** هذا المقترح هو لدعم القرار السريري للطبيب (Clinical Decision Support) استرشادياً فقط، ولا يعد وصفة طبية نافذة ولا يصرف إلا بعد مراجعة واعتماد الطبيب المعالج المرخص عبر شاشة الزيارة الموثقة.\n💡 **الطبيب البشري المعالج هو المسؤول الأول والأخير عن القرار العلاجي.**`;

  // أزرار العمليات السريرية المعتمدة (منع إرسال الوصفة للواتساب أو طباعتها قبل اعتماد الطبيب)
  const actions: ActionButton[] = [];
  if (patientId) {
    actions.push({ label: `فتح الزيارة لاعتماد الوصفة رسمياً`, href: `/patients/${patientId}/visits`, actionType: "navigate" });
    actions.push({ label: `فتح ملف ${patientName}`, href: `/patients/${patientId}`, actionType: "navigate" });
  } else if (patientName && patientName !== "المريض") {
    actions.push({ label: `بحث عن ملف ${patientName}`, href: `/patients?q=${encodeURIComponent(patientName)}`, actionType: "navigate" });
  }

  return {
    success: true,
    textSummary: rxText,
    cards,
    actions,
    patientIdAccessed: patientId || undefined,
  };
}

// ─── 2. محرك إرشادات وتعليمات ما بعد العمليات السنية ─────────────────────────────

export async function generatePostOpCareAction(
  params: {
    patientName?: string;
    patientId?: number;
    procedureType?: string;
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  let patientName = params.patientName || context.currentPatientName || "المريض الكريم";
  let patientPhone: string | null = null;
  let patientId = params.patientId;

  // فحص عزل الأطباء وصلاحية الوصول لملف المريض
  const candidatePatient = params.patientId || params.patientName || context.currentPatientName;
  if (candidatePatient) {
    const accessCheck = await verifyAiPatientAccess(context, candidatePatient);
    if (!accessCheck.allowed) {
      return {
        success: false,
        textSummary: accessCheck.reason || "🔒 **تنبيه أمني (عزل الأطباء §39):** ليس لديك صلاحية للاطلاع على بيانات هذا المريض أو إرسال إرشادات له.",
        warnings: ["محاولة وصول لإرشادات مريض غير مسند للطبيب"],
      };
    }
    if (accessCheck.patient) {
      patientName = accessCheck.patient.fullName;
      patientPhone = accessCheck.patient.phone;
      patientId = accessCheck.patient.id;
    }
  }

  if (context.isDbConnected && !patientPhone && patientId) {
    const p = await getPatient(patientId);
    if (p) {
      patientName = p.fullName;
      patientPhone = p.phone;
    }
  }

  const template: PostOpTemplate = detectPostOpTemplateFromText(params.procedureType || "");

  const instructionsText =
    `🦷 **${template.icon} ${template.title} ${patientName ? `— المريض: ${patientName} ` : ""}— مركز د. عقلان الكامل**\n\n` +
    `📌 **ملخص العناية:** ${template.summary}\n\n` +
    `⏰ **أول 24 ساعة:**\n` +
    template.first24Hours.map((step) => `• ${step}`).join("\n") +
    `\n\n🥗 **النظام الغذائي:**\n` +
    `• المسموح: ${template.diet.allowed.join("، ")}\n` +
    `• الممنوع: ${template.diet.avoid.join("، ")}\n\n` +
    `🚨 **متى تتواصل فوراً مع المركز؟**\n` +
    template.emergencyWarnings.map((w) => `⚠️ ${w}`).join("\n");

  const cleanPhone = toWhatsAppNumber(patientPhone || "");
  const actions: ActionButton[] = [];

  if (cleanPhone) {
    const waText = `السلام عليكم يا ${patientName}،\n` +
      `إرشادات العناية بعد الإجراء من د. عقلان الكامل:\n\n` +
      `📌 ${template.title}\n\n` +
      template.first24Hours.slice(0, 3).map((s) => `• ${s}`).join("\n") +
      `\n\nنتمنى لكم الشفاء العاجل والسلامة الدائمة. 🌹✨`;
    actions.push({
      label: `📲 إرسال الإرشادات واتساب إلى ${patientName}`,
      href: `https://wa.me/${cleanPhone}?text=${encodeURIComponent(waText)}`,
      actionType: "whatsapp",
    });
  }

  if (patientId) {
    actions.push({ label: `فتح ملف ${patientName}`, href: `/patients/${patientId}`, actionType: "navigate" });
  }

  const cards: KpiCard[] = [
    { title: "نوع الإجراء", value: template.procedureName, tone: "info" },
    { title: "المريض", value: patientName, tone: "good" },
    { title: "حالة الإرسال", value: cleanPhone ? "جاهز للإرسال 📲" : "بلا هاتف مسجل", tone: cleanPhone ? "good" : "warn" },
  ];

  return {
    success: true,
    textSummary: instructionsText,
    cards,
    actions,
    patientIdAccessed: patientId || undefined,
  };
}

// ─── 3. محرك الاستعلام عن دليل الخدمات والأسعار الرسمية ────────────────────────

export async function getServicePricingAction(
  params: {
    query?: string;
    serviceQuery?: string;
    category?: string;
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  const settings = context.isDbConnected ? await getSettings().catch(() => ({} as any)) : ({} as any);
  const baseCurrency: Currency = isCurrency(settings["finance.base_currency"]) ? settings["finance.base_currency"] : "YER";
  const sarRate = rateFromSettings(settings, "SAR", baseCurrency) ?? 0.0038;
  const usdRate = rateFromSettings(settings, "USD", baseCurrency) ?? 0.0019;

  const rawQ = (params.query || params.serviceQuery || "").trim().toLowerCase();
  let filtered = DEFAULT_SERVICES;

  // استخراج الكلمات المفتاحية الذكية إذا كان الاستعلام يحتوي على جملة استفسارية طويلة
  let searchKeyword = rawQ;
  if (rawQ.includes("زراع") || rawQ.includes("غرس") || rawQ.includes("implant")) searchKeyword = "زراع";
  else if (rawQ.includes("تقويم") || rawQ.includes("ortho") || rawQ.includes("شد")) searchKeyword = "تقويم";
  else if (rawQ.includes("تبييض") || rawQ.includes("bleach") || rawQ.includes("white")) searchKeyword = "تبييض";
  else if (rawQ.includes("عصب") || rawQ.includes("جذور") || rawQ.includes("endo")) searchKeyword = "عصب";
  else if (rawQ.includes("تنظيف") || rawQ.includes("لثة") || rawQ.includes("جير") || rawQ.includes("perio")) searchKeyword = "تنظيف";
  else if (rawQ.includes("حشو") || rawQ.includes("كومبوزيت") || rawQ.includes("كمبوزيت") || rawQ.includes("أمالغم")) searchKeyword = "حشو";
  else if (rawQ.includes("خلع") || rawQ.includes("قلع") || rawQ.includes("جراح")) searchKeyword = "خلع";
  else if (rawQ.includes("تاج") || rawQ.includes("زيركون") || rawQ.includes("زركون") || rawQ.includes("تركيب") || rawQ.includes("crown") || rawQ.includes("جسور") || rawQ.includes("جسر")) searchKeyword = "تاج";
  else if (rawQ.includes("أشعة") || rawQ.includes("اشعة") || rawQ.includes("بانوراما")) searchKeyword = "أشعة";
  else if (rawQ.includes("كشف") || rawQ.includes("استشارة") || rawQ.includes("معاينة")) searchKeyword = "كشف";

  if (params.category) {
    filtered = filtered.filter((s) => s.category?.toLowerCase() === params.category!.toLowerCase());
  }

  if (searchKeyword && !rawQ.includes("كل الخدمات") && !rawQ.includes("قائمة الأسعار كلها") && !rawQ.includes("دليل الأسعار")) {
    const matched = filtered.filter(
      (s) => s.name.toLowerCase().includes(searchKeyword) || (s.category && s.category.toLowerCase().includes(searchKeyword)),
    );
    if (matched.length > 0) {
      filtered = matched;
    }
  }

  if (filtered.length === 0) {
    return {
      success: true,
      textSummary: `لم يتم العثور على خدمات مطابقة للبحث «${params.query || params.category}». تتوفر في المركز خدمات: الكشف، الحشوات، علاج الجذور، التيجان والزيركون، الزراعة، التقويم، والتبييض.`,
      cards: [{ title: "نتائج البحث", value: "0 خدمات", tone: "info" }],
    };
  }

  const rows = filtered.slice(0, 12).map((s) => {
    const yerPrice = formatMoney(s.priceMinor, "YER");
    const sarEst = sarRate ? Math.round(s.priceMinor * sarRate) : null;
    const sarFormatted = sarEst ? `${sarEst.toLocaleString()} ر.س` : "—";
    return [
      s.name,
      CATEGORY_LABEL[s.category || ""] || s.category || "عام",
      yerPrice,
      sarFormatted,
    ];
  });

  const table: StructuredTable = {
    headers: ["الخدمة السنية", "التصنيف", "السعر بالريال اليمني", "تقديري سعودي"],
    rows,
  };

  const cards: KpiCard[] = [
    { title: "الخدمات المطابقة", value: `${filtered.length} خدمات`, tone: "good" },
    { title: "العملة الأساسية", value: baseCurrency, tone: "info" },
  ];

  const actions: ActionButton[] = [
    { label: "فتح شاشة المالية والخدمات", href: "/finance/services", actionType: "navigate" },
    { label: "حجز موعد كشف واستشارة", href: "/appointments", actionType: "navigate" },
  ];

  const textSummary =
    `🦷 **دليل أسعار وخدمات مركز د. عقلان الكامل لطب وجراحة الأسنان:**\n\n` +
    filtered.slice(0, 8).map((s) => `• **${s.name}**: ${formatMoney(s.priceMinor, "YER")} (${CATEGORY_LABEL[s.category || ""] || "خدمة"})`).join("\n") +
    (filtered.length > 8 ? `\n\n... ويوجد ${filtered.length - 8} خدمات إضافية موضحة في الجدول أدناه.` : "") +
    `\n\n💡 الأسعار خاضعة للتقييم السريري الدقيق للطبيب بعد الفحص المباشر والأشعة التشخيصية.`;

  return {
    success: true,
    textSummary,
    table,
    cards,
    actions,
  };
}
