/**
 * معاينات تأكيد أدوات تغيير الحالة (Confirmation Previews)
 *
 * ما يراه المستخدم قبل الضغط على «تأكيد التنفيذ»: ماذا سيحدث، على من، وبأي
 * قيم — والمبالغ والجرعات والقيم السريرية تُبرَز بوصفها قيمًا حساسة.
 */

import type { ToolConfirmationField } from "./types";

const str = (value: unknown): string =>
  typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : "";

const CURRENCY_LABEL: Record<string, string> = {
  YER: "ريال يمني",
  SAR: "ريال سعودي",
  USD: "دولار أمريكي",
};

export interface ConfirmationPreview {
  title: string;
  description: string;
  fields: ToolConfirmationField[];
}

/** التسمية العربية لكل أداة تغيير حالة — تظهر في عنوان المعاينة والتدقيق. */
export const TOOL_ACTION_LABEL: Record<string, string> = {
  create_patient: "تسجيل مريض جديد",
  book_appointment: "حجز موعد",
  update_appointment_status: "تعديل حالة موعد",
  record_patient_payment: "تسجيل سند قبض",
  add_patient_medical_alert: "تسجيل تنبيه طبي",
  create_lab_order: "إنشاء أمر معمل",
  record_inventory_movement: "تسجيل حركة مخزون",
};

export function toolActionLabel(tool: string): string {
  return TOOL_ACTION_LABEL[tool] || "تنفيذ إجراء";
}

/**
 * يبني المعاينة من المعاملات المنقّاة بعد تثبيت المريض — تُعرض للقراءة،
 * والتوقيع على المعاملات نفسها المضمّنة في الرمز.
 */
export function buildConfirmationPreview(
  tool: string,
  params: Record<string, unknown>,
  patient?: { id: number | null; name: string } | null,
): ConfirmationPreview {
  const label = toolActionLabel(tool);
  const fields: ToolConfirmationField[] = [];

  if (patient) {
    fields.push({
      label: "المريض",
      value: patient.id != null ? `${patient.name} (ملف #${patient.id})` : patient.name,
      sensitive: true,
    });
  }

  switch (tool) {
    case "create_patient": {
      const fullName = str(params.fullName);
      if (fullName) fields.push({ label: "الاسم الكامل", value: fullName, sensitive: true });
      const phone = str(params.phone);
      if (phone) fields.push({ label: "الهاتف", value: phone, sensitive: true });
      const gender = params.gender === "female" ? "أنثى" : "ذكر";
      fields.push({ label: "الجنس", value: gender });
      if (params.birthYear) fields.push({ label: "سنة الميلاد", value: str(params.birthYear) });
      const alert = str(params.medicalAlert);
      if (alert) fields.push({ label: "التنبيه الطبي", value: alert, sensitive: true });
      break;
    }
    case "book_appointment": {
      fields.push({ label: "التاريخ", value: str(params.date) || "اليوم" });
      fields.push({ label: "الوقت", value: str(params.time) || "16:00" });
      fields.push({ label: "نوع الموعد", value: str(params.appointmentType) || "كشف ومعاينة" });
      if (params.doctorName) fields.push({ label: "الطبيب", value: `د. ${str(params.doctorName)}` });
      if (params.durationMinutes) fields.push({ label: "المدة (دقيقة)", value: str(params.durationMinutes) });
      break;
    }
    case "update_appointment_status": {
      if (params.appointmentId) fields.push({ label: "رقم الموعد", value: `#${str(params.appointmentId)}` });
      const actionLabel: Record<string, string> = {
        arrive: "تسجيل وصول",
        cancel: "إلغاء الموعد",
        done: "إنهاء الموعد",
        no_show: "تسجيل عدم حضور",
      };
      fields.push({
        label: "الإجراء على الموعد",
        value: actionLabel[str(params.action)] || str(params.action),
        sensitive: true,
      });
      break;
    }
    case "record_patient_payment": {
      const currency = CURRENCY_LABEL[str(params.currency) || "YER"] || str(params.currency) || "ريال يمني";
      fields.push({ label: "المبلغ", value: `${str(params.amount)} ${currency}`, sensitive: true });
      fields.push({
        label: "طريقة القبض",
        value: params.method === "transfer" ? "تحويل" : "نقدًا بالصندوق",
        sensitive: true,
      });
      if (params.invoiceId) fields.push({ label: "الفاتورة", value: `#${str(params.invoiceId)}` });
      break;
    }
    case "add_patient_medical_alert": {
      fields.push({ label: "نص التنبيه الطبي", value: str(params.medicalAlert), sensitive: true });
      break;
    }
    case "create_lab_order": {
      fields.push({ label: "المعمل", value: str(params.labName) || "المعمل الافتراضي" });
      fields.push({ label: "الخدمة", value: str(params.serviceName) || "تركيبات / تعويضات سنية" });
      if (params.shade) fields.push({ label: "لون VITA", value: str(params.shade) });
      fields.push({ label: "تاريخ الاستلام", value: str(params.dueDate) || "خلال 5 أيام" });
      break;
    }
    case "record_inventory_movement": {
      fields.push({ label: "المادة", value: str(params.itemName) || `#${str(params.itemId)}` });
      const kindLabel: Record<string, string> = {
        in: "إدخال وتوريد",
        out: "صرف واستهلاك",
        adjust: "تسوية جرد",
      };
      fields.push({ label: "نوع الحركة", value: kindLabel[str(params.kind)] || str(params.kind), sensitive: true });
      fields.push({ label: "الكمية", value: str(params.qty), sensitive: true });
      if (params.reason) fields.push({ label: "السبب", value: str(params.reason) });
      break;
    }
    default:
      break;
  }

  return {
    title: `تأكيد: ${label}`,
    description:
      "لن يُنفَّذ هذا الإجراء إلا بعد تأكيدك الصريح. تأكد من صحة البيانات أعلاه — المريض والقيم الحساسة — ثم اضغط «تأكيد التنفيذ».",
    fields,
  };
}
