import type { AssessmentEditorV2 } from "./ortho-assessment-editor-v2";
import { CLINICAL_FIELDS_V2, clinicalFieldIdV2 } from "./ortho-assessment-clinical-fields";
import { observationInputHintV2 } from "./ortho-assessment-input-hints-v2";
import { measurementPayloadV2 } from "./ortho-assessment-measurement-editor-v2";
import { boundedText } from "./ortho-assessment-model";

/** Display the existing save validator's errors; never repair or change the draft. */
export function assessmentSaveFeedbackV2(draft: AssessmentEditorV2): string[] {
  const messages: string[] = [];
  const reasonText = draft.reason.trim();
  if (!boundedText(draft.reason, 500)) messages.push(reasonText
    ? "سبب إنشاء المراجعة: استخدم نصًا صالحًا لا يتجاوز 500 حرف."
    : "سبب إنشاء المراجعة: اكتب سبب توثيق هذه المراجعة.");
  const checked = measurementPayloadV2(draft.measurements);
  if (!checked.ok) for (const error of checked.errors) {
    const clinical = CLINICAL_FIELDS_V2.find(([field]) => clinicalFieldIdV2(field) === error.observationId);
    const observation = draft.measurements.payload.observations.observations.find(row => row.id === error.observationId);
    const section = clinical ? { history: "المقابلة والشكوى", facial: "الفحص خارج الفم", intraoral: "الفحص داخل الفم" }[clinical[2]] : "القياسات والسجلات";
    messages.push(observation
      ? `${section} · ${clinical?.[1] ?? observation.label}: ${observationInputHintV2(error.code)}`
      : error.code === "conflicting_source_versions"
        ? "تتضمن المسودة إصدارين مختلفين للمصدر نفسه. راجع روابط المصدر واختر الإصدار الصحيح قبل الحفظ."
        : error.code === "source_reference_limit"
          ? "عدد مراجع المصادر في المسودة يتجاوز الحد المسموح. راجع الروابط المضافة قبل الحفظ؛ لم تُحذف أي بيانات."
          : "راجع ربط القياسات والسجلات في هذه المسودة قبل الحفظ.");
  }
  return messages;
}
