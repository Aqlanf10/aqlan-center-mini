/**
 * محرك الفهم الطبيعي وتوجيه النوايا الذكي (Aqlan Assistant NLU & Intent Engine)
 *
 * يدعم:
 * 1. اللغة العربية الفصحى واللهجة اليمنية الدارجة في العيادات.
 * 2. التعرف على التواريخ والعملات والتخصصات بدقة.
 * 3. سياق المحادثة الممتد (الربط التلقائي للمريض في الأسئلة اللاحقة).
 * 4. حماية صارمة ضد محاولات كسر القيود (Prompt Injection Defense).
 */

import type { AiToolContext, StructuredAiResponse, ToolExecutionResult } from "./ai-tools/types";
import { executeAiTool } from "./ai-tools/registry";
import { generateDentalExpertReply } from "./dental-ai-engine";
import { extractPatientIdentifier } from "./assistant-knowledge";
import type { PeriodPreset, CurrencyFilter } from "./reports-types";

/**
 * فحص محاولات حقن الأوامر والتلاعب بالصلاحيات (Prompt Injection)
 */
export function detectPromptInjection(query: string): boolean {
  const norm = query.toLowerCase();
  const injectionPatterns = [
    "تجاهل التعليمات",
    "تجاهل كل التعليمات",
    "تجاهل الأوامر",
    "ignore all instructions",
    "ignore previous instructions",
    "أنا المدير",
    "أنا مدير المركز",
    "أعطني صلاحية",
    "تجاهل الصلاحيات",
    "تخطي الصلاحيات",
    "database_url",
    "session_secret",
    "select * from",
    "drop table",
    "delete from",
    "union select",
    "اطبع المتغيرات",
    "اطبع المفاتيح",
    "api key",
    "اعطني كلمة المرور",
    "اعرض حسابات الأطباء",
  ];

  return injectionPatterns.some((pattern) => norm.includes(pattern));
}

/**
 * استخراج العملة المستهدفة من السؤال (YER, SAR, USD)
 */
export function extractCurrency(text: string): CurrencyFilter {
  const norm = text.toLowerCase();
  if (norm.includes("دولار") || norm.includes("usd") || norm.includes("$")) {
    return "USD";
  }
  if (norm.includes("سعودي") || norm.includes("sar") || norm.includes("ريال سعودي")) {
    return "SAR";
  }
  if (norm.includes("يمني") || norm.includes("yer") || norm.includes("ريال يمني") || norm.includes("بالريال")) {
    return "YER";
  }
  return "all";
}

/**
 * استخراج الفترة الزمنية المحددة من السؤال
 */
export function extractPeriodPreset(text: string): PeriodPreset {
  const norm = text.toLowerCase();
  if (norm.includes("أمس") || norm.includes("البارحة")) return "yesterday";
  if (norm.includes("اليوم") || norm.includes("الليلة")) return "today";
  if (norm.includes("هذا الأسبوع") || norm.includes("الاسبوع الحالي")) return "this_week";
  if (norm.includes("الشهر الماضي") || norm.includes("الشهر السابق")) return "prev_month";
  if (norm.includes("هذا الشهر") || norm.includes("الشهر الحالي")) return "this_month";
  if (norm.includes("هذا الربع") || norm.includes("الربع الحالي")) return "this_quarter";
  if (norm.includes("السنة الماضية") || norm.includes("العام الماضي")) return "prev_year";
  if (norm.includes("هذه السنة") || norm.includes("هذا العام") || norm.includes("سنوي") || norm.includes("السنوي")) return "this_year";
  return "this_month";
}

/**
 * استخراج التخصص المستهدف من السؤال
 */
export function extractSpecialty(text: string): string | undefined {
  const norm = text.toLowerCase();
  if (norm.includes("تقويم")) return "ortho";
  if (norm.includes("زراع")) return "implant";
  if (norm.includes("عصب") || norm.includes("جذور")) return "endo";
  if (norm.includes("تركيب") || norm.includes("تاج") || norm.includes("زركون") || norm.includes("بورسلان") || norm.includes("جسر")) return "prostho";
  if (norm.includes("حشو")) return "restorative";
  if (norm.includes("خلع") || norm.includes("جراح")) return "surgery";
  if (norm.includes("أطفال") || norm.includes("طفل")) return "pediatric";
  if (norm.includes("تنظيف") || norm.includes("لثة") || norm.includes("تبييض")) return "perio";
  return undefined;
}

/**
 * فحص ما إذا كان السؤال استفساراً متابعاً لمريض سابق (Follow-up pronoun query)
 */
export function isPatientFollowupQuery(query: string): boolean {
  const norm = query.toLowerCase().trim();
  const followupTriggers = [
    "موعده", "موعدها", "حسابه", "حسابها", "كم دفع", "كم دفعت",
    "علاجه", "علاجها", "خطته", "خطتها", "تلفونه", "تلفونها", "هاتفه", "هاتفها",
    "ملفه", "ملفها", "عنده", "عندها", "مستحقاته", "مستحقاتها", "رصيده", "رصيدها",
  ];
  return followupTriggers.some((tr) => norm.includes(tr));
}

/**
 * محرك المعالجة الشامل لكافة استفسارات المساعد الذكي
 */
export async function processAssistantQuery(
  latestMessage: string,
  context: AiToolContext,
  conversationHistory: Array<{ role: "user" | "assistant" | "system"; content: string }> = [],
): Promise<StructuredAiResponse> {
  const started = Date.now();
  const trimmed = latestMessage.trim();
  const norm = trimmed.toLowerCase();

  // 1. فحص محاولات حقن التعليمات ومقاومة التلاعب
  if (detectPromptInjection(trimmed)) {
    return {
      answer: `🔒 **تنبيه أمني وحوكمة:**\nلا يمكن تعديل الصلاحيات أو تجاوز قواعد الأمان وعزل الأطباء عبر الأوامر النصية.\nيتم التحقق من الصلاحيات حصراً عبر جلسة الخادم الموثقة (دورك الحالي: **${context.role}**).`,
      intent: "security_rejection",
      toolsUsed: ["prompt_injection_guard"],
      warnings: ["محاولة تجاوز أمني مرفوضة"],
      sourceType: "internal_engine",
      model: "aqlan-security-guard",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // 2. فحص استفسارات دليل استخدام النظام (System Feature Guide)
  if (
    norm.includes("كيف أضيف") ||
    norm.includes("كيف اعمل") ||
    norm.includes("كيف أعمل") ||
    norm.includes("كيف احجز") ||
    norm.includes("كيف أحجز") ||
    norm.includes("أين أغير") ||
    norm.includes("كيف أغير") ||
    norm.includes("كيف أفتح") ||
    norm.includes("كيف افتح") ||
    norm.includes("كيف أضبط") ||
    norm.includes("كيف اضبط") ||
    norm.includes("كيف أستخدم") ||
    norm.includes("كيف استخدم") ||
    norm.includes("أين شاشة") ||
    norm.includes("اين شاشة") ||
    norm.includes("طريقة استخدام") ||
    norm.includes("خطوات") ||
    norm.includes("دليل استخدام") ||
    norm.includes("كيف أسجل") ||
    norm.includes("كيف اسجل")
  ) {
    const guideResult = await executeAiTool("get_system_guide", { query: trimmed }, context);
    if (guideResult.success) {
      return {
        answer: guideResult.textSummary,
        intent: "system_guide",
        toolsUsed: ["get_system_guide"],
        actions: guideResult.actions,
        sourceType: "internal_engine",
        model: "aqlan-system-guide",
        latencyMs: Date.now() - started,
        generatedAt: new Date().toISOString(),
      };
    }
  }

  // 3. فحص الاستعلام عن مريض (بحث جديد أو متابعة ضمن نفس الجلسة)
  const convPatientId =
    context.conversationPatientId ||
    (typeof context.currentPatientId === "number"
      ? context.currentPatientId
      : Number(context.currentPatientId) || null);

  const patientTerm = extractPatientIdentifier(trimmed);

  if (!patientTerm && isPatientFollowupQuery(trimmed) && (convPatientId || context.currentPatientName)) {
    // استخدام المريض السابق من سياق الجلسة
    let textSummary = "";
    let cards = undefined;
    let actions = undefined;

    if (convPatientId) {
      const patientResult = await executeAiTool(
        "get_patient_summary",
        { patientId: convPatientId },
        context,
      );
      textSummary = patientResult.textSummary;
      cards = patientResult.cards;
      actions = patientResult.actions;
    } else {
      const pName = context.currentPatientName || "المريض الحالي";
      textSummary = `👤 **متابعة المريض «${pName}»:**\nالاستفسار عن موعده أو حسابه تم تسجيله، وهو مرتبط بملف المريض الحالي.`;
    }

    return {
      answer: textSummary,
      intent: "patient_query",
      toolsUsed: ["get_patient_summary"],
      cards,
      actions,
      sourceType: "live_database",
      model: "aqlan-patient-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // 4. استعلامات السيفالومتري الرقمي
  if (
    norm.includes("سيفالومتري") ||
    norm.includes("ceph") ||
    norm.includes("ستاينر") ||
    norm.includes("قياسات السيفالومتري") ||
    norm.includes("تحليل سيفالومتري")
  ) {
    const cephResult = await executeAiTool(
      "get_cephalometric_summary",
      { patientId: convPatientId || 1 },
      context,
    );
    return {
      answer: cephResult.textSummary,
      intent: "ceph_analysis",
      toolsUsed: ["get_cephalometric_summary"],
      cards: cephResult.cards,
      actions: cephResult.actions,
      sourceType: "live_database",
      model: "aqlan-ortho-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // 5. استعلامات التقويم والمتابعة
  if (
    norm.includes("متابعات التقويم") ||
    norm.includes("مرضى التقويم المتأخرين") ||
    norm.includes("من متأخر من مرضى التقويم") ||
    norm.includes("المتأخرين عن المتابعة") ||
    norm.includes("المتأخرين 30 يوم") ||
    norm.includes("متابعة التقويم") ||
    norm.includes("شدات اليوم")
  ) {
    const orthoResult = await executeAiTool("get_ortho_followups", {}, context);
    return {
      answer: orthoResult.textSummary,
      intent: "ortho_followups",
      toolsUsed: ["get_ortho_followups"],
      cards: orthoResult.cards,
      table: orthoResult.table,
      actions: orthoResult.actions,
      sourceType: "live_database",
      model: "aqlan-ortho-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  if (patientTerm) {
    const patientResult = await executeAiTool("search_patient", { term: patientTerm }, context);
    return {
      answer: patientResult.textSummary,
      intent: "patient_query",
      toolsUsed: ["search_patient"],
      cards: patientResult.cards,
      actions: patientResult.actions,
      sourceType: "live_database",
      model: "aqlan-patient-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // 5. استعلامات المخزون والنواقص
  if (
    norm.includes("المخزون") ||
    norm.includes("المخزن") ||
    norm.includes("نواقص") ||
    norm.includes("المواد المنتهية") ||
    norm.includes("رصيد مادة") ||
    norm.includes("ليدوكايين") ||
    norm.includes("حد الطلب") ||
    norm.includes("مواد ناقصة") ||
    norm.includes("نفاد")
  ) {
    const invResult = await executeAiTool("get_inventory_summary", { onlyLowStock: true }, context);
    return {
      answer: invResult.textSummary,
      intent: "inventory_query",
      toolsUsed: ["get_inventory_summary"],
      cards: invResult.cards,
      table: invResult.table,
      actions: invResult.actions,
      sourceType: "live_database",
      model: "aqlan-inventory-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // 6. استعلامات أوامر المعمل
  if (
    norm.includes("المعمل") ||
    norm.includes("معمل") ||
    norm.includes("المختبر") ||
    norm.includes("مختبر") ||
    norm.includes("معامل") ||
    norm.includes("حالات المعمل") ||
    norm.includes("لم تصل") ||
    norm.includes("طلبات المعمل") ||
    norm.includes("طلبيات مختبر") ||
    norm.includes("معمل التركيبات") ||
    norm.includes("معامل الأسنان")
  ) {
    const labResult = await executeAiTool("get_lab_cases", {}, context);
    return {
      answer: labResult.textSummary,
      intent: "lab_query",
      toolsUsed: ["get_lab_cases"],
      cards: labResult.cards,
      table: labResult.table,
      actions: labResult.actions,
      sourceType: "live_database",
      model: "aqlan-lab-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // 7. استعلامات المواعيد وجدول اليوم
  if (
    norm.includes("مواعيد اليوم") ||
    norm.includes("موعد اليوم") ||
    norm.includes("جدول اليوم") ||
    norm.includes("جدول المواعيد") ||
    norm.includes("مواعيد العيادة") ||
    norm.includes("عندي مواعيد") ||
    norm.includes("حالات اليوم في جدول المواعيد") ||
    norm.includes("من هم المرضى الذين لديهم مواعيد اليوم") ||
    norm.includes("كم مريض متأخر عن الموعد") ||
    norm.includes("كم موعد اليوم") ||
    norm.includes("من عنده موعد")
  ) {
    const aptResult = await executeAiTool("get_today_appointments", {}, context);
    return {
      answer: aptResult.textSummary,
      intent: "today_appointments",
      toolsUsed: ["get_today_appointments"],
      cards: aptResult.cards,
      table: aptResult.table,
      actions: aptResult.actions,
      sourceType: "live_database",
      model: "aqlan-appointment-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // 8. استعلامات الأطباء والخدمات والإحصائيات
  if (norm.includes("أطباء المركز") || norm.includes("من هم الأطباء") || norm.includes("دكاترة المركز")) {
    const docResult = await executeAiTool("get_doctors", {}, context);
    return {
      answer: docResult.textSummary,
      intent: "doctors_query",
      toolsUsed: ["get_doctors"],
      cards: docResult.cards,
      sourceType: "live_database",
      model: "aqlan-management-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  if (norm.includes("سعر") || norm.includes("أسعار") || norm.includes("بكم") || norm.includes("تكلفة") || norm.includes("دليل الخدمات")) {
    let kw = "";
    if (norm.includes("تقويم")) kw = "تقويم";
    else if (norm.includes("عصب") || norm.includes("جذور")) kw = "عصب";
    else if (norm.includes("حشوة") || norm.includes("حشو")) kw = "حشو";
    else if (norm.includes("زراع")) kw = "زراع";
    else if (norm.includes("خلع")) kw = "خلع";
    else if (norm.includes("تنظيف") || norm.includes("تبييض")) kw = "تنظيف";

    const svcResult = await executeAiTool("get_service_prices", { keyword: kw }, context);
    return {
      answer: svcResult.textSummary,
      intent: "services_query",
      toolsUsed: ["get_service_prices"],
      cards: svcResult.cards,
      table: svcResult.table,
      actions: svcResult.actions,
      sourceType: "live_database",
      model: "aqlan-management-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  if (norm.includes("إحصائيات المركز") || norm.includes("كم مريض بالمركز") || norm.includes("عدد المرضى")) {
    const statsResult = await executeAiTool("get_clinic_statistics", {}, context);
    return {
      answer: statsResult.textSummary,
      intent: "statistics_query",
      toolsUsed: ["get_clinic_statistics"],
      cards: statsResult.cards,
      sourceType: "live_database",
      model: "aqlan-management-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // 9. استعلامات المالية والتقارير المتقدمة (buildReport Bridge)
  const currency = extractCurrency(trimmed);
  const period = extractPeriodPreset(trimmed);
  const specialty = extractSpecialty(trimmed);

  if (
    norm.includes("دخل") ||
    norm.includes("إيرادات") ||
    norm.includes("تحصيل") ||
    norm.includes("حصلنا") ||
    norm.includes("صندوق") ||
    norm.includes("مديونية") ||
    norm.includes("مديونيات") ||
    norm.includes("أعمار الديون") ||
    norm.includes("تقرير") ||
    norm.includes("قارن") ||
    norm.includes("مستحقات الدكتور") ||
    norm.includes("عمولة") ||
    norm.includes("مصروفات")
  ) {
    if (norm.includes("أكثر") && (norm.includes("مديونية") || norm.includes("المرضى"))) {
      const recResult = await executeAiTool("get_patient_receivables", {}, context);
      return {
        answer: recResult.textSummary,
        intent: "patient_receivables",
        toolsUsed: ["get_patient_receivables"],
        cards: recResult.cards,
        table: recResult.table,
        actions: recResult.actions,
        sourceType: "live_database",
        model: "aqlan-report-bridge",
        latencyMs: Date.now() - started,
        generatedAt: new Date().toISOString(),
      };
    }

    let reportType: "daily" | "monthly" | "annual" | "debt" | "aging" | "specialty" | "doctor" | "collections" = "daily";
    let compare: "none" | "prev_period" | "prev_year" = "none";

    if (norm.includes("أعمار الديون") || norm.includes("أكثر من 90 يوم") || norm.includes("90 يوم")) {
      reportType = "aging";
    } else if (norm.includes("مديونية") || norm.includes("مديونيات")) {
      reportType = "debt";
    } else if (norm.includes("حصلنا") || norm.includes("تحصيل") || norm.includes("صندوق") || norm.includes("دخل")) {
      reportType = period === "today" ? "daily" : "collections";
    } else if (norm.includes("عمولة") || norm.includes("مستحقات الدكتور") || norm.includes("أطباء")) {
      reportType = "doctor";
    } else if (norm.includes("قارن") || norm.includes("مقارنة")) {
      reportType = "monthly";
      compare = "prev_period";
    } else if (period === "this_year" || period === "prev_year" || norm.includes("السنوي") || norm.includes("سنوي")) {
      reportType = "annual";
    } else if (period === "this_month" || period === "prev_month") {
      reportType = "monthly";
    }

    const reportResult = await executeAiTool(
      "generate_internal_report",
      {
        reportType,
        preset: period,
        currency,
        specialty,
        compare,
      },
      context,
    );

    let intentName = "finance_report";
    if (reportType === "debt") {
      intentName = "debt_report";
    } else if (reportType === "aging") {
      intentName = "debt_aging";
    }

    return {
      answer: reportResult.textSummary,
      intent: intentName,
      toolsUsed: ["generate_internal_report"],
      cards: reportResult.cards,
      table: reportResult.table,
      actions: reportResult.actions,
      warnings: reportResult.warnings,
      sourceType: "live_database",
      model: "aqlan-report-bridge",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // 10. الاستفسارات السريرية والطبية وطوارئ الأسنان والأدوية
  const clinicalResult = await generateDentalExpertReply(
    conversationHistory.length > 0
      ? conversationHistory.map((m) => ({ role: m.role, content: m.content }))
      : [{ role: "user", content: trimmed }],
    {
      userRole: context.role,
      username: context.username,
      doctorPartyId: context.doctorPartyId,
      canViewAllPatients: context.canViewAllPatients,
      canViewFinancials: context.canViewClinicFinance,
    },
  );

  const clinicalMap: Record<string, string> = {
    pharmacology: "clinical_general",
    anesthesia: "clinical_general",
    endo_emergency: "clinical_general",
    general_clinical: "clinical_general",
    post_op: "clinical_general",
  };
  const mappedIntent = clinicalMap[clinicalResult.category] || clinicalResult.category;

  return {
    answer: clinicalResult.reply,
    intent: mappedIntent,
    toolsUsed: ["dental_clinical_expert"],
    sourceType: "internal_engine",
    model: clinicalResult.model,
    latencyMs: Date.now() - started,
    generatedAt: new Date().toISOString(),
  };
}
