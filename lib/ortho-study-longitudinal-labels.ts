/** Shared display-only explanations for saved review and export. Never clinical facts. */
import type { StudyDisplayLocale } from "./ortho-case-presentation-i18n";
import type { StudyLongitudinalReason } from "./ortho-study-longitudinal-contract";
const labels: Record<StudyLongitudinalReason, { ar: string; en: string }> = {
  clinical_comparability_not_validated: { ar: "تطابقت هوية المصدر المرسلة مع التقاط الخادم. هذا لا يثبت ما شاهده الطبيب، ولا يمثل اعتمادًا سريريًا مستقلاً أو تحققًا من قابلية القياسات للمقارنة.", en: "Submitted source identity matched the server capture. This does not prove what the clinician viewed, provide independent clinical validation, or establish measurement comparability." },
  source_identity_not_view_bound: { ar: "تم التحقق من سلامة سجل المصدر الثابت المحفوظ عند الإكمال، لكن لم يُثبت أنه المصدر الذي شاهده الطبيب. لا يثبت ذلك قابلية المقارنة أو اعتمادًا سريريًا مستقلاً.", en: "The immutable source record saved at completion passed integrity checks, but it is not confirmed as the source the clinician viewed. This does not establish comparability or independent clinical validation." },
  source_unavailable: { ar: "المصدر المختار غير متاح في هذا الالتقاط المحفوظ.", en: "The selected source is unavailable in this saved capture." },
  not_completed: { ar: "السجل السيفالومتري المحفوظ غير موسوم كمكتمل.", en: "The saved cephalometric record is not marked completed." },
  image_unavailable: { ar: "صورة المصدر غير متاحة في الالتقاط المحفوظ.", en: "The source image is unavailable in the saved capture." },
  legacy_completion_witness_missing: { ar: "لا يحتوي الالتقاط القديم على سجل ثابت للمدخلات المستخدمة عند الإكمال.", en: "This legacy capture has no immutable record of the inputs used at completion." },
  measurement_unit_unversioned: { ar: "لم تُحفظ وحدات القياس ضمن نسخة محددة.", en: "Measurement units were not captured with a version." },
  formula_version_unversioned: { ar: "لم تُحفظ نسخة معادلات القياس المستخدمة.", en: "The measurement formula version was not captured." },
  reference_version_unversioned: { ar: "لم تُحفظ نسخة القيم المرجعية المستخدمة؛ اسم المجموعة المرجعية وحده لا يكفي.", en: "The reference-value version was not captured. A reference-set name alone is insufficient." },
  calibration_not_captured: { ar: "لم تُحفظ معايرة مرتبطة بمدخلات القياس المكتملة.", en: "Calibration bound to the completed measurement inputs was not captured." },
  no_ceph_source: { ar: "لم يُربط مصدر سيفالومتري بهذه المرحلة المحفوظة.", en: "No cephalometric source is assigned to this saved stage." },
  multiple_ceph_sources: { ar: "ترتبط بهذه المرحلة مصادر سيفالومترية متعددة؛ لم يُختر أحدها للمقارنة تلقائيًا.", en: "Multiple cephalometric sources are assigned to this stage. None was automatically selected for comparison." },
};
export const studyLongitudinalReasonText = (reason: StudyLongitudinalReason, locale: StudyDisplayLocale): string => labels[reason][locale];
