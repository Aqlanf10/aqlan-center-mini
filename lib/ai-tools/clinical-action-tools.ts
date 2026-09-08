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
import { canAccessPatient } from "../patient-access";
import { evaluatePrescriptionSafety, type DrugInput } from "../medication-safety";
import { POST_OP_TEMPLATES, type PostOpTemplate, detectPostOpTemplateFromText } from "../post-op-care";
import { DEFAULT_SERVICES, CATEGORY_LABEL } from "../services-catalog";
import { formatMoney, isCurrency, type Currency } from "../money";
import { rateFromSettings } from "../settings";
import { toWhatsAppNumber } from "../reminders";
import type { AiToolContext, ToolExecutionResult, KpiCard, ActionButton, StructuredTable } from "./types";


/** مجال بحث المرضى: الطبيب بلا منحٍ عامة يبحث في مرضاه فقط (P0.2). */
function doctorScopeIdFor(context: AiToolContext): number | null {
  if (context.role !== "doctor" && context.userRole !== "doctor") return null;
  if (context.canViewAllPatients || context.permissions?.canViewAllPatients) return null;
  return context.doctorPartyId ?? null;
}

// ─── 1. محرك الأمان الدوائي واقتراح الروشتات السريرية ──────────────────────────

export async function recommendPrescriptionAction(
  params: {
    patientName?: string;
    patientId?: number;
    condition?: string;
    requestedDrugs?: string[];
    medicalAlert?: string;
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  let patientName = params.patientName || context.currentPatientName || "المريض";
  let medicalAlert: string | null = params.medicalAlert || null;
  let patientPhone: string | null = null;
  let patientId = params.patientId;

  const normCondition = (params.condition || "").toLowerCase();
  if (!medicalAlert && (normCondition.includes("حساسية") || normCondition.includes("ضغط") || normCondition.includes("سكر") || normCondition.includes("حامل") || normCondition.includes("نزف"))) {
    medicalAlert = params.condition || null;
  }

  if (context.isDbConnected && (patientId || params.patientName || context.currentPatientName)) {
    let p = null;
    if (patientId) {
      p = await getPatient(patientId);
    } else {
      const queryName = params.patientName || context.currentPatientName || "";
      const matches = await searchPatients(queryName.trim(), 1, doctorScopeIdFor(context));
      if (matches[0]) p = await getPatient(matches[0].id);
    }
    /* عزل الطبيب: ملف مريض زملته لا يُقرأ لتوليد اقتراح دوائي باسمه (P0.2). */
    if (p) {
      const session = {
        userId: context.userId ?? 1,
        username: context.username || "anonymous",
        role: (context.role || context.userRole || "doctor") as string,
        expiresAt: Date.now() + 3600_000,
        partyId: context.doctorPartyId ?? undefined,
      };
      const allowed = await canAccessPatient(session, p.id).catch(() => false);
      if (!allowed) {
        return {
          success: false,
          textSummary: "🔒 **تنبيه أمني:** ليس لديك صلاحية للوصول إلى ملف هذا المريض (عزل الكادر السريري).",
          warnings: ["عزل الأطباء: محاولة قراءة ملف مريض غير مسند"],
        };
      }
      patientName = p.fullName;
      if (p.medicalAlert) medicalAlert = p.medicalAlert;
      patientPhone = p.phone;
      patientId = p.id;
    }
  }

  /* ── Antibiotic Stewardship (P0.10) ──
   * المضاد الحيوي ليس روتينًا بعد الخلع ولا لمجرد ألم العصب، ولا يُبنى نظامه
   * على كلمة مفتاحية واحدة: لا يُقترح إلا بعلامات عدوى صريحة في نص الحالة،
   * أو بأدويةٍ طلب الطبيب فحصها بنفسه. وغياب الحالة السريرية لا يولّد وصفة
   * افتراضية — بل يطلب التوضيح.
   */
  const INFECTION_SIGNS = [
    "خراج", "تورم", "صديد", "انتفاخ", "عدوى", "إنتان", "حمى", "حرارة",
    "التهاب صديدي", "abscess", "infection", "swelling", "pus", "cellulitis",
  ];
  const hasInfectionSigns = INFECTION_SIGNS.some((k) => normCondition.includes(k));
  const isSurgical = normCondition.includes("خلع") || normCondition.includes("جراح") || normCondition.includes("عقل") || normCondition.includes("زراع") || normCondition.includes("implant");
  const isEndodonticPain = normCondition.includes("عصب") || normCondition.includes("لب") || normCondition.includes("ألم") || normCondition.includes("وجع");

  const drugs: DrugInput[] = [];
  let stewardshipNote = "";

  if (params.requestedDrugs && params.requestedDrugs.length > 0) {
    // أدوية طلب الطبيب فحص أمانها بنفسه — الغرض فحص التعارض لا اقتراح نظام
    for (const d of params.requestedDrugs) {
      drugs.push({ name: d, instructions: "حسب الوصفة المكتوبة" });
    }
  } else if (hasInfectionSigns) {
    drugs.push(
      { name: "Amoxicillin 500mg", instructions: "كبسولة كل 8 ساعات لمدة 5 أيام (بعد الأكل)" },
      { name: "Metronidazole 500mg", instructions: "قرص كل 8 ساعات بعد الأكل لمدة 5 أيام" },
      { name: "Ibuprofen 400mg", instructions: "قرص كل 8 ساعات لتسكين الألم وتقليل الالتهاب" },
    );
    stewardshipNote = "المضاد الحيوي مُقترح لعلامات عدوى صريحة وردت في وصف الحالة — يؤكده الطبيب بعد الفحص.";
  } else if (isSurgical || isEndodonticPain) {
    drugs.push(
      { name: "Ibuprofen 400mg", instructions: "قرص كل 8 ساعات بعد الأكل عند اللزوم" },
      { name: "Paracetamol 500mg", instructions: "قرص كل 8 ساعات كمسكن مساند" },
      { name: "Chlorhexidine 0.12%", instructions: "مضمضة مرتين يومياً لمدة أسبوع" },
    );
    stewardshipNote =
      "لم تُضمّن مضادات حيوية: الخلع الروتيني وألم العصب بلا علامات عدوى لا يستوجبانها " +
      "(Antibiotic Stewardship) — تُضاف فقط عند وجود خراج أو تورم أو علامات عدوى يقررها الطبيب.";
  } else {
    /* لا وصفة افتراضية بلا حالة سريرية: الطلب يُعيَن لا يُخمَّن. */
    return {
      success: true,
      textSummary:
        "🧪 **فحص الأمان الدوائي يحتاج أدويةً أو حالة:**\n" +
        "• اكتب الأدوية المطلوب فحص تعارضها (مثال: «افحص أمان Augmentin وBrufen لمريض…»).\n" +
        "• أو صف الحالة السريرية (مثال: «مريض بعد خلع جراحي مع تورم»).\n\n" +
        "لا يُقترح نظام دوائي افتراضي دون سياقٍ سريري — الاقتراح دعم قرارٍ للطبيب لا وصفة جاهزة.",
      cards: [{ title: "فحص الأمان الدوائي", value: "بحاجة إلى أدوية أو حالة", tone: "info" }],
      patientIdAccessed: patientId || undefined,
    };
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
        // استبدال الدواء بالبديل المقترح
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

  const cards: KpiCard[] = [
    { title: "المريض", value: patientName, tone: "info" },
    { title: "التنبيهات السريرية", value: medicalAlert || "لا يوجد تنبيه أو مانع مسجل في الملف — يجب التحقق سريرياً", tone: medicalAlert ? "warn" : "calm" },
    ...safetyCards,
  ];

  let rxText = `📋 **الروشتة المقترحة والوصفة الطبية لـ «${patientName}»**${params.condition ? ` (حالة: ${params.condition})` : ""}:\n\n`;
  adjustedDrugs.forEach((d, idx) => {
    rxText += `${idx + 1}. **${d.name}**\n   • الجرعة والاستخدام: ${d.instructions || "حسب إرشادات الطبيب"}\n`;
  });

  if (warningMessage) {
    rxText += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🛡️ **تحذيرات وتعارضات دوائية حرجة (Medication Safety Guard):**${warningMessage}\n`;
  }

  if (stewardshipNote) {
    rxText += `\n🧭 **سياسة المضادات الحيوية:** ${stewardshipNote}\n`;
  }

  rxText += `\n⚖️ **تنبيه دستوري (المادة 214):** هذا الاقتراح الدوائي للمراجعة السريرية من قبل الطبيب المعالج قبل الاعتماد والطباعة.`;

  /* لا إرسال واتساب ولا طباعة رسمية لاقتراحٍ لم يعتمده الطبيب بعد (P0.10):
   * المساعد يقترح ويفحص الأمان؛ الوثيقة الرسمية تصدر من نافذة الوصفة في ملف
   * المريض حيث تُحفظ وتُوقّع باسم مُصدرها — ومنها وحدها الطباعة والإرسال. */
  const actions: ActionButton[] = [];
  if (patientId) {
    actions.push({
      label: `فتح ملف ${patientName} لإصدار الوصفة الرسمية`,
      href: `/patients/${patientId}`,
      actionType: "navigate",
    });
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

  if (context.isDbConnected && (patientId || params.patientName || context.currentPatientName)) {
    let p = null;
    if (patientId) {
      p = await getPatient(patientId);
    } else {
      const q = params.patientName || context.currentPatientName || "";
      const matches = await searchPatients(q.trim(), 1, doctorScopeIdFor(context));
      if (matches[0]) p = await getPatient(matches[0].id);
    }
    if (p) {
      patientName = p.fullName;
      patientPhone = p.phone;
      patientId = p.id;
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
