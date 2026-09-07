/**
 * المسجل المركزي لأدوات الذكاء الاصطناعي (AI Tool Registry)
 *
 * يتولى تدقيق الأذونات والصلاحيات قبل استدعاء أي أداة داخلية.
 */

import type { AiToolContext, AiToolDefinition, ToolExecutionResult } from "./types";
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
};

// أسماء بديلة للأدوات لضمان التوافقية الكاملة
AI_TOOL_DEFINITIONS.get_ortho_followups_due = AI_TOOL_DEFINITIONS.get_ortho_followups;
AI_TOOL_DEFINITIONS.get_services = AI_TOOL_DEFINITIONS.get_service_prices;
AI_TOOL_DEFINITIONS.get_system_feature_guide = AI_TOOL_DEFINITIONS.get_system_guide;
AI_TOOL_DEFINITIONS.add_patient = AI_TOOL_DEFINITIONS.create_patient;
AI_TOOL_DEFINITIONS.new_patient = AI_TOOL_DEFINITIONS.create_patient;
AI_TOOL_DEFINITIONS.register_patient = AI_TOOL_DEFINITIONS.create_patient;
AI_TOOL_DEFINITIONS.schedule_appointment = AI_TOOL_DEFINITIONS.book_appointment;
AI_TOOL_DEFINITIONS.new_appointment = AI_TOOL_DEFINITIONS.book_appointment;
AI_TOOL_DEFINITIONS.cancel_appointment = AI_TOOL_DEFINITIONS.update_appointment_status;
AI_TOOL_DEFINITIONS.arrive_patient = AI_TOOL_DEFINITIONS.update_appointment_status;
AI_TOOL_DEFINITIONS.record_payment = AI_TOOL_DEFINITIONS.record_patient_payment;
AI_TOOL_DEFINITIONS.receive_payment = AI_TOOL_DEFINITIONS.record_patient_payment;
AI_TOOL_DEFINITIONS.record_receipt = AI_TOOL_DEFINITIONS.record_patient_payment;
AI_TOOL_DEFINITIONS.set_medical_alert = AI_TOOL_DEFINITIONS.add_patient_medical_alert;
AI_TOOL_DEFINITIONS.new_lab_order = AI_TOOL_DEFINITIONS.create_lab_order;
AI_TOOL_DEFINITIONS.send_to_lab = AI_TOOL_DEFINITIONS.create_lab_order;
AI_TOOL_DEFINITIONS.stock_movement = AI_TOOL_DEFINITIONS.record_inventory_movement;
AI_TOOL_DEFINITIONS.send_whatsapp = AI_TOOL_DEFINITIONS.generate_whatsapp_reminder;
AI_TOOL_DEFINITIONS.whatsapp_reminder = AI_TOOL_DEFINITIONS.generate_whatsapp_reminder;

export const aiToolRegistry = AI_TOOL_DEFINITIONS;

/**
 * تنفيذ أداة ذكية مع التحقق الصارم من الصلاحيات
 */
export async function executeAiTool(
  toolName: string,
  params: Record<string, any>,
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  const tool = AI_TOOL_DEFINITIONS[toolName];
  if (!tool) {
    const text = `الأداة المطلوبة «${toolName}» غير مسجلة في سجل أدوات النظام.`;
    return {
      success: false,
      textSummary: text,
      message: text,
      warnings: ["أداة غير معروفة"],
    };
  }

  const role = context.role || context.userRole;

  // فحص الصلاحية المطلوبة
  if (tool.requiredPermission === "admin_only" && role !== "admin") {
    const text = "🔒 **تنبيه أمني:** هذه الأداة مقتصرة حصراً على إدارة المركز (غير مصرح).";
    return {
      success: false,
      textSummary: text,
      message: text,
      warnings: ["غير مصرح: محاولة تنفيذ أداة إدارة من مستخدم غير مخول"],
    };
  }

  if (tool.requiredPermission === "finance_only") {
    const hasFinance = role === "admin" || context.canViewClinicFinance === true;
    if (!hasFinance) {
      const text = "🔒 **تنبيه أمني:** الاطلاع على المعلومات المالية يتطلب صلاحية مالية مخصصة (المدير أو المحاسب) - غير مصرح.";
      return {
        success: false,
        textSummary: text,
        message: text,
        warnings: ["غير مصرح: محاولة وصول لبيانات مالية بدون صلاحية"],
      };
    }
  }

  const res = await tool.execute(params, context);
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

