/**
 * المسجل المركزي لأدوات الذكاء الاصطناعي (AI Tool Registry)
 *
 * يتولى تدقيق الأذونات والصلاحيات قبل استدعاء أي أداة داخلية.
 */

import type { AiToolContext, AiToolDefinition, ToolExecutionResult } from "./types";
import { AI_TOOL_ALIAS_TO_CANONICAL, authorizeToolPolicy, resolveToolPolicy } from "./policy";
import { applyPatientScoping } from "./authorization";
import { buildToolConfirmationOffer, buildToolConfirmationPayload, TOOL_CONFIRMATION_MAX_PARAMS_JSON } from "../ai-confirmation";
import { buildConfirmationPreview, toolActionLabel } from "./confirmation-preview";
import { claimToolConfirmation } from "../db";
import { generateInternalReport, getTodayCollections, getPatientReceivables, getDebtAging, getDoctorCommissionReport } from "./finance-tools";
import { searchPatient, getPatientSummary } from "./patient-tools";
import { getTodayAppointments } from "./appointment-tools";
import { getOrthoFollowupsDue, getCephalometricSummary } from "./ortho-tools";
import { getInventorySummary } from "./inventory-tools";
import { getLabCases } from "./lab-tools";
import { getDoctors, getServicePrices, getClinicStatistics } from "./management-tools";
import { findSystemFeature } from "./system-feature-registry";
import {
  createPatientAction,
  bookAppointmentAction,
  updateAppointmentStatusAction,
  recordPatientPaymentAction,
  addPatientMedicalAlertAction,
  createLabOrderAction,
  recordInventoryMovementAction,
  generateWhatsAppReminderAction,
} from "./action-tools";
import {
  recommendPrescriptionAction,
  generatePostOpCareAction,
  getServicePricingAction,
} from "./clinical-action-tools";
import {
  draftConsentFormAction,
  draftTreatmentPlanFormAction,
  draftLabOrderFormAction,
  draftPatientIntakeFormAction,
  draftMedicalReportFormAction,
} from "./form-drafting-tools";

export const AI_TOOL_DEFINITIONS: Record<string, AiToolDefinition> = {
  // ─── أدوات التقارير والمالية ─────────────────────────────────────────────
  generate_internal_report: {
    name: "generate_internal_report",
    description: "توليد تقرير محاسبي أو سريري معتمد من محرك التقارير الأساسي (يومي، شهري، سنوي، مديونية، أطباء).",
    category: "finance",
    requiredPermission: "finance_only",
    execute: (params, ctx) => generateInternalReport(params as any, ctx),
  },
  get_today_collections: {
    name: "get_today_collections",
    description: "استعلام متحصلات وصندوق اليوم بالعملات المختلفة (ريال يمني، سعودي، دولار).",
    category: "finance",
    requiredPermission: "finance_only",
    execute: (params, ctx) => getTodayCollections(params, ctx),
  },
  get_patient_receivables: {
    name: "get_patient_receivables",
    description: "استعلام مديونيات المرضى ورصيد المتبقي الإجمالي ومستحقات العيادة.",
    category: "finance",
    requiredPermission: "finance_only",
    execute: (params, ctx) => getPatientReceivables(params, ctx),
  },
  get_debt_aging: {
    name: "get_debt_aging",
    description: "تقرير أعمار الديون المصنف وفق الفترات (0-30، 31-60، 61-90، +90 يوم).",
    category: "finance",
    requiredPermission: "finance_only",
    execute: (params, ctx) => getDebtAging(params, ctx),
  },
  get_doctor_commission: {
    name: "get_doctor_commission",
    description: "استعلام عمولات ومستحقات الأطباء على الخدمات السنية المنفذة.",
    category: "finance",
    execute: (params, ctx) => getDoctorCommissionReport(params, ctx),
  },

  // ─── أدوات المرضى ────────────────────────────────────────────────────────
  search_patient: {
    name: "search_patient",
    description: "البحث عن مريض بالاسم أو الهاتف أو رقم الملف السكني مع تطبيق عزل الطبيب.",
    category: "patient",
    execute: (params, ctx) => searchPatient(params as any, ctx),
  },
  get_patient_summary: {
    name: "get_patient_summary",
    description: "جلب البطاقة الشاملة للمريض: الرصيد، التنبيه الطبي، المواعيد، وخطط العلاج.",
    category: "patient",
    execute: (params, ctx) => getPatientSummary(params as any, ctx),
  },

  // ─── أدوات المواعيد والجدول ──────────────────────────────────────────────
  get_today_appointments: {
    name: "get_today_appointments",
    description: "استعلام مواعيد وحضور المرضى اليوم أو في تاريخ محدد بالعيادة.",
    category: "appointment",
    execute: (params, ctx) => getTodayAppointments(params, ctx),
  },

  // ─── أدوات التقويم والسيفالومتري ─────────────────────────────────────────
  get_ortho_followups: {
    name: "get_ortho_followups",
    description: "استعلام متابعات التقويم والشدات المتأخرة والحالات بدون موعد محجوز.",
    category: "ortho",
    execute: (params, ctx) => getOrthoFollowupsDue(params, ctx),
  },
  get_cephalometric_summary: {
    name: "get_cephalometric_summary",
    description: "جلب ملخص آخر تحليل سيفالومتري وزوايا الفكين المسجلة للمريض.",
    category: "ortho",
    execute: (params, ctx) => getCephalometricSummary(params as any, ctx),
  },

  // ─── أدوات المخزون ───────────────────────────────────────────────────────
  get_inventory_summary: {
    name: "get_inventory_summary",
    description: "استعلام أرصدة المخزون السني وتنبيهات المواد التي أوشكت على النفاد.",
    category: "inventory",
    execute: (params, ctx) => getInventorySummary(params, ctx),
  },

  // ─── أدوات المعمل ────────────────────────────────────────────────────────
  get_lab_cases: {
    name: "get_lab_cases",
    description: "استعلام حالات وأوامر معمل الأسنان وقيد الإنجاز وألوان VITA.",
    category: "lab",
    execute: (params, ctx) => getLabCases(params, ctx),
  },

  // ─── أدوات الإدارة والخدمات ──────────────────────────────────────────────
  get_doctors: {
    name: "get_doctors",
    description: "قائمة الكادر الطبي المعتمد وتخصصات الأطباء بالمركز.",
    category: "management",
    execute: (_params, ctx) => getDoctors(ctx),
  },
  get_service_prices: {
    name: "get_service_prices",
    description: "دليل أسعار الخدمات السنية المعتمدة في المركز والبحث في الخدمات.",
    category: "management",
    execute: (params, ctx) => getServicePrices(params, ctx),
  },
  get_clinic_statistics: {
    name: "get_clinic_statistics",
    description: "إحصائيات المركز التراكمية: إجمالي المرضى، المواعيد، والزيارات.",
    category: "management",
    execute: (_params, ctx) => getClinicStatistics(ctx),
  },

  // ─── دليل استخدام النظام ─────────────────────────────────────────────────
  get_system_guide: {
    name: "get_system_guide",
    description: "شرح كيفية استخدام أي شاشة أو خاصية في النظام خطوة بخطوة مع رابط التنقل.",
    category: "system",
    execute: async (params, ctx) => {
      const query = String(params.query || "");
      const feature = findSystemFeature(query, ctx.role);
      if (!feature) {
        return {
          success: false,
          textSummary: `لم أجد شاشة أو خاصية محددة تطابق استفسارك. يمكنك سؤالي مثلاً:\n• «كيف أضيف مريض جديد؟»\n• «كيف أعمل فاتورة وسند قبض؟»\n• «كيف أحجز موعد؟»\n• «كيف أعمل نسخ احتياطي Backup؟»`,
        };
      }

      const stepsText = feature.howToSteps.map((s, idx) => `${idx + 1}. ${s}`).join("\n");
      const textSummary = `📋 **دليل استخدام: ${feature.name}**\n*${feature.description}*\n\n### 📌 الخطوات الإجرائية:\n${stepsText}`;

      return {
        success: true,
        textSummary,
        message: textSummary,
        actions: feature.actionLink ? [{ label: `فتح شاشة ${feature.name}`, href: feature.actionLink, actionType: "navigate" }] : undefined,
        data: feature,
      };
    },
  },

  // ─── أدوات تنفيذ العمليات التشغيلية (Action & Execution Tools) ─────────────
  create_patient: {
    name: "create_patient",
    description: "تسجيل مريض جديد وفتح ملفه رسمياً بالمركز (الاسم، الهاتف، الجنس، سنة الميلاد، العنوان، التنبيه الطبي).",
    category: "patient",
    execute: (params, ctx) => createPatientAction(params as any, ctx),
  },
  book_appointment: {
    name: "book_appointment",
    description: "حجز موعد مباشر لمريض في جدول العيادة (المريض، التاريخ، الوقت، الطبيب، نوع الإجراء، الملاحظات).",
    category: "appointment",
    execute: (params, ctx) => bookAppointmentAction(params as any, ctx),
  },
  update_appointment_status: {
    name: "update_appointment_status",
    description: "تعديل حالة موعد في الجدول (تسجيل وصول للصالة arrive، إلغاء cancel، إنهاء done، غياب no_show).",
    category: "appointment",
    execute: (params, ctx) => updateAppointmentStatusAction(params as any, ctx),
  },
  record_patient_payment: {
    name: "record_patient_payment",
    description: "تسجيل سند قبض ودفعات مالية لحساب مريض وتوريدها للصندوق بالعملات المختلفة (ريال يمني، سعودي، دولار).",
    category: "finance",
    requiredPermission: "finance_only",
    execute: (params, ctx) => recordPatientPaymentAction(params as any, ctx),
  },
  add_patient_medical_alert: {
    name: "add_patient_medical_alert",
    description: "تسجيل أو تحديث تنبيه طبي وحساسية أدوية وأمراض مزمنة في ترويسة ملف المريض لسلامته.",
    category: "patient",
    execute: (params, ctx) => addPatientMedicalAlertAction(params as any, ctx),
  },
  create_lab_order: {
    name: "create_lab_order",
    description: "إنشاء طلب وأمر عمل لمعمل تركيبات الأسنان (المريض، المعمل، الخدمة، لون VITA، تاريخ الاستلام).",
    category: "lab",
    execute: (params, ctx) => createLabOrderAction(params as any, ctx),
  },
  record_inventory_movement: {
    name: "record_inventory_movement",
    description: "تسجيل حركة مخزون للمواد السنية (إدخال وتوريد in، صرف واستهلاك عيادة out، تسوية جرد adjust).",
    category: "inventory",
    execute: (params, ctx) => recordInventoryMovementAction(params as any, ctx),
  },
  generate_whatsapp_reminder: {
    name: "generate_whatsapp_reminder",
    description: "توليد رسالة تذكير وتواصل واتساب مباشرة للمريض مع رابط إرسال فوري wa.me.",
    category: "system",
    execute: (params, ctx) => generateWhatsAppReminderAction(params as any, ctx),
  },
  recommend_prescription: {
    name: "recommend_prescription",
    description: "اقتراح وصفة علاجية سنية مع فحص الأمان الدوائي التلقائي والتحقق من عدم وجود حساسية أو موانع بملف المريض.",
    category: "patient",
    execute: (params, ctx) => recommendPrescriptionAction(params as any, ctx),
  },
  generate_post_op_care: {
    name: "generate_post_op_care",
    description: "توليد تعليمات وإرشادات ما بعد الإجراء السني (خلع، زراعة، عصب، تقويم، تبييض) وتجهيز رسالة واتساب المريض.",
    category: "patient",
    execute: (params, ctx) => generatePostOpCareAction(params as any, ctx),
  },
  get_service_pricing: {
    name: "get_service_pricing",
    description: "الاستعلام عن أسعار وتفاصيل خدمات المركز السنية الرسمية المعتمدة ومقارنة الفئات والعملات.",
    category: "management",
    execute: (params, ctx) => getServicePricingAction(params as any, ctx),
  },
  // ─── أدوات صياغة وتعبئة النماذج الذكية ────────────────────────────────────
  draft_consent_form: {
    name: "draft_consent_form",
    description: "صياغة وتعبئة استمارة إقرار الموافقة الطبية المستنيرة (خلع، زراعة، عصب، تقويم، تبييض) مخصصة للمريض وجاهزة للطباعة والتوقيع.",
    category: "patient",
    execute: (params, ctx) => draftConsentFormAction(params as any, ctx),
  },
  draft_treatment_plan_form: {
    name: "draft_treatment_plan_form",
    description: "صياغة وتعبئة خطة علاج متكاملة المراحل مع جدول الأقساط الشهرية والتزامات السداد.",
    category: "finance",
    execute: (params, ctx) => draftTreatmentPlanFormAction(params as any, ctx),
  },
  draft_lab_order_form: {
    name: "draft_lab_order_form",
    description: "صياغة وتعبئة نموذج أمر عمل المختبر السني الفني (السن، الخامة، لون VITA، المختبر، تاريخ الاستلام).",
    category: "lab",
    execute: (params, ctx) => draftLabOrderFormAction(params as any, ctx),
  },
  draft_patient_intake_form: {
    name: "draft_patient_intake_form",
    description: "صياغة وتعبئة استمارة السيرة المرضية والفحص الأولي للمريض وفرز المخاطر الطبية تلقائياً.",
    category: "patient",
    execute: (params, ctx) => draftPatientIntakeFormAction(params as any, ctx),
  },
  draft_medical_report_form: {
    name: "draft_medical_report_form",
    description: "صياغة وتجهيز تقرير طبي سني رسمي معتمد للمريض موجه للجهات الرسمية أو شركات التأمين.",
    category: "patient",
    execute: (params, ctx) => draftMedicalReportFormAction(params as any, ctx),
  },
};

/* ── الأسماء البديلة تُشتق من السياسة المركزية لا تُكتب يدويًا ──────────────────
 * فكل اسم بديل يرث تعريف الأداة الأساسية وسياستها كاملةً (الأدوار والصلاحيات
 * والتأكيد والعزل) — استنادًا إلى خريطة policy.ts — فلا ينحرف مرادفٌ عن
 * سياسة أصله أبدًا. */
for (const [aliasOrCanonical, canonical] of Object.entries(AI_TOOL_ALIAS_TO_CANONICAL)) {
  const base = AI_TOOL_DEFINITIONS[canonical];
  if (base && !AI_TOOL_DEFINITIONS[aliasOrCanonical]) {
    AI_TOOL_DEFINITIONS[aliasOrCanonical] = base;
  }
}

export const aiToolRegistry = AI_TOOL_DEFINITIONS;

/** نتيجة رفضٍ موحّدة الأداء والصياغة. */
function deniedResult(textSummary: string, warnings: string[]): ToolExecutionResult {
  return { success: false, textSummary, message: textSummary, warnings };
}

/**
 * تنفيذ أداة ذكية — البوابة المركزية الموحدة.
 *
 * الترتيب دستوريّ لا يُخالَف:
 * ١) حلّ الاسم إلى سياسة — **لا سياسة = رفض** (المجهول ليس «قراءة آمنة»).
 * ٢) تفويض السياسة: الدور، الصلاحيات الصريحة، النطاق المالي والمخزوني.
 * ٣) عزل المريض وتثبيت هويته من المسموح به فقط، وحلّ الموارد غير المباشرة
 *    إلى مرضاها (BOLA) — ويتكرر هذا الفحص عند التنفيذ بعد التأكيد.
 * ٤) أدوات تغيير الحالة لا تُنفّذ فورًا: عرضُ تأكيدٍ موقّع مرتبط بالمستخدم
 *    والأداة والمعاملات والمريض، ولا تنفيذ إلا برمزٍ مُستهلَك مرةً واحدة.
 * ٥) القراءة ودعم القرار تُنفّذ بعد نفس العزل والتثبيت.
 */
export async function executeAiTool(
  toolName: string,
  params: Record<string, any>,
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  /* ١) السياسة: المفقودة مرفوضة — لا افتراضَ لقراءةٍ آمنة لمجهول. */
  const policy = resolveToolPolicy(toolName);
  if (!policy) {
    return deniedResult(
      `🔒 الأداة «${String(toolName).slice(0, 60)}» غير مسجلة في سياسة أدوات النظام — الرفض الافتراضي.`,
      ["أداة غير معروفة: رفض ضمني (Missing Policy ⇒ DENY)"],
    );
  }
  const tool = AI_TOOL_DEFINITIONS[policy.canonicalName];
  if (!tool) {
    return deniedResult("الأداة غير متاحة حاليًا.", ["تعريف مفقود لأداة مسجلة في السياسة"]);
  }

  /* ٢) التفويض المركزي للسياسة. */
  const decision = authorizeToolPolicy(policy, context);
  if (!decision.allowed) {
    return deniedResult(`🔒 **تنبيه أمني:** ${decision.reason}`, ["غير مصرح: بوابة سياسة الأدوات المركزية"]);
  }

  /* احتياط التوافق مع القيود القديمة المصرّح بها على التعريف. */
  const role = context.role || context.userRole;
  if (tool.requiredPermission === "admin_only" && role !== "admin") {
    return deniedResult(
      "🔒 **تنبيه أمني:** هذه الأداة مقتصرة حصراً على إدارة المركز (غير مصرح).",
      ["غير مصرح: محاولة تنفيذ أداة إدارة من مستخدم غير مخول"],
    );
  }
  if (
    tool.requiredPermission === "finance_only" &&
    !(role === "admin" || context.permissions?.canViewClinicFinance === true)
  ) {
    return deniedResult(
      "🔒 **تنبيه أمني:** الاطلاع على المعلومات المالية يتطلب صلاحية مالية مخصصة - غير مصرح.",
      ["غير مصرح: محاولة وصول لبيانات مالية بدون صلاحية"],
    );
  }

  /* ٤-أ) مسار التنفيذ الموثّق: رمز تأكيد ساري + إعادة تفويض + استهلاك ذرّي مرة واحدة. */
  if (policy.requiresConfirmation && context.confirmationExecution) {
    const payload = context.confirmationExecution;
    if (payload.tool !== policy.canonicalName) {
      return deniedResult("رمز التأكيد لا يطابق الأداة المطلوبة.", ["عدم تطابق الأداة مع رمز التأكيد"]);
    }
    if (context.userId == null || payload.userId !== context.userId) {
      return deniedResult("رمز التأكيد صادر لمستخدم آخر — لا يُنفَّذ نيابةً عنه.", ["رمز تأكيد عابر للمستخدمين"]);
    }
    if (payload.exp <= Date.now()) {
      return deniedResult("انتهت صلاحية عرض التأكيد — أعد الطلب من جديد.", ["انتهاء عمر رمز التأكيد"]);
    }
    /* إعادة التفويض والتفويض على بيانات اللحظة: الصلاحيات والملكية تُفحص الآن. */
    const tokenParams =
      typeof payload.params === "object" && payload.params ? { ...payload.params } : {};
    let execParams = tokenParams;
    let resolvedPatientId: number | null = null;
    if (context.isDbConnected) {
      const scoping = await applyPatientScoping(policy, tokenParams, context);
      if (scoping.refusal) return scoping.refusal;
      execParams = scoping.sanitizedParams;
      resolvedPatientId = scoping.patientId ?? null;
      /* المريض تبيّن أنه لطبيبٍ آخر منذ العرض، أو تغيّرت إحالته: لا تنفيذ. */
      if (payload.patientId != null && resolvedPatientId != null && payload.patientId !== resolvedPatientId) {
        return deniedResult(
          "تغيّرت هوية المريض المرتبط بالطلب منذ عرض التأكيد — أعد الطلب للفحص من جديد.",
          ["تغيّر هوية المريض بعد العرض"],
        );
      }
      const claimed = await claimToolConfirmation(
        payload.jti,
        payload.userId,
        policy.canonicalName,
      ).catch(() => false);
      if (!claimed) {
        return deniedResult(
          "رمز التأكيد مستهلك أو منفَّذ مسبقًا — الإجراء لا يُنفّذ مرتين. أعد الطلب من جديد إن أردت تكراره.",
          ["إعادة تشغيل رمز تأكيد مُستهلَك (Replay)"],
        );
      }
    }
    const confirmed = await tool.execute(execParams, context);
    if (!confirmed.message && confirmed.textSummary) confirmed.message = confirmed.textSummary;
    return confirmed;
  }

  /* ٤-ب) مسار العرض: أداة تغيير حالة بلا رمز — معاينة موقّعة وانتظار التأكيد. */
  if (policy.requiresConfirmation) {
    const offerParams: Record<string, any> =
      params && typeof params === "object" ? { ...params } : {};
    let previewParams = offerParams;
    let patient: { id: number | null; name: string } | null = null;
    if (context.isDbConnected) {
      const scoping = await applyPatientScoping(policy, offerParams, context);
      if (scoping.refusal) return scoping.refusal;
      previewParams = scoping.sanitizedParams;
      if (scoping.patientId != null) {
        patient = { id: scoping.patientId, name: scoping.patientName || `#${scoping.patientId}` };
      }
    } else if (typeof offerParams.patientName === "string" && offerParams.patientName.trim()) {
      /* وضعٌ بلا قاعدة بيانات: الاسم يُعرض للمعاينة بلا تثبيت هوية. */
      patient = { id: null, name: offerParams.patientName.trim() };
    }
    let serialized = "";
    try {
      serialized = JSON.stringify(previewParams);
    } catch {
      serialized = "";
    }
    if (serialized.length > TOOL_CONFIRMATION_MAX_PARAMS_JSON) {
      return deniedResult(
        "معاملات الإجراء أكبر من الحد المسموح للتأكيد — قلّل التفاصيل وأعد الطلب.",
        ["تجاوز حجم معاملات التأكيد"],
      );
    }
    const payload = buildToolConfirmationPayload({
      userId: context.userId ?? 0,
      username: context.username || context.userName || "unknown",
      tool: policy.canonicalName,
      params: previewParams,
      patientId: patient?.id ?? null,
    });
    const preview = buildConfirmationPreview(policy.canonicalName, previewParams, patient);
    const offer = buildToolConfirmationOffer(payload, {
      title: preview.title,
      description: preview.description,
      patientLabel: patient?.name ?? null,
      fields: preview.fields,
    });
    context.pendingConfirmation = offer;
    const fieldLines = preview.fields
      .map((f) => `• **${f.label}:** ${f.sensitive ? `⟵ ${f.value} ⟶` : f.value}`)
      .join("\n");
    const textSummary = `⏳ **ينتظر تأكيدك قبل التنفيذ — ${toolActionLabel(policy.canonicalName)}**\n\n${
      preview.fields.length > 0 ? `${fieldLines}\n\n` : ""
    }لن يُلمس أي سجل قبل موافقتك الصريحة: راجع البيانات أعلاه ثم اضغط **«تأكيد التنفيذ»**، أو **«إلغاء»** للتراجع. العرض صالح عشر دقائق ويُنفّذ مرةً واحدة.`;
    const cards = preview.fields.slice(0, 4).map((f) => ({
      title: f.label,
      value: f.value,
      tone: f.sensitive ? ("warn" as const) : ("info" as const),
    }));
    return {
      success: false,
      requiresConfirmation: true,
      confirmation: offer,
      textSummary,
      message: textSummary,
      cards: cards.length > 0 ? cards : [{ title: "الإجراء", value: toolActionLabel(policy.canonicalName), tone: "info" }],
      warnings: ["إجراء يغيّر الحالة: بانتظار تأكيد المستخدم"],
    };
  }

  /* ٥) القراءة ودعم القرار: العزل والتثبيت ثم التنفيذ. */
  let scopedParams = params && typeof params === "object" ? { ...params } : {};
  if (policy.patientScoped && context.isDbConnected) {
    const scoping = await applyPatientScoping(policy, scopedParams, context);
    if (scoping.refusal) return scoping.refusal;
    scopedParams = scoping.sanitizedParams;
  }

  const res = await tool.execute(scopedParams, context);
  if (!res.message && res.textSummary) {
    res.message = res.textSummary;
  }
  return res;
}

/** الحصول على قائمة أسماء كافة الأدوات المسجلة */
export function getRegisteredToolNames(): string[] {
  return Object.keys(AI_TOOL_DEFINITIONS);
}

/** البحث عن أداة باسمها الأصلي أو باسمها البديل */
export function findToolByNameOrAlias(name: string): AiToolDefinition | undefined {
  return AI_TOOL_DEFINITIONS[name];
}

