import { caseLayout } from "./ortho-case-template";
import type { StudySourceKind } from "./ortho-case-study";

/** Display-only language. Never part of clinical content, hashes or save commands. */
export type StudyDisplayLocale = "ar" | "en";
export const STUDY_DISPLAY_LOCALE_KEY = "aqlan.orthoStudy.displayLocale";
export const STUDY_ENGLISH = {
  "هذا القسم موجود في الدراسة.": "This section already exists in the study.",
  "تغيرت هوية الحالة؛ أعد فتح الدراسة من الحالة الصحيحة.": "The case identity changed. Reopen the study from the correct case.",
  "دراسة حالة التقويم": "Orthodontic case study",
  "دراسة حالة تقويم": "Orthodontic case study",
  "لغة العرض": "Display language",
  "تُحفظ الدراسة داخل الملف مستقلة عن التصدير. توثيق نسخة لا يوقع موافقة علاجية ولا يغيّر العلاج أو الحساب.": "The study is saved in the patient record independently of export. Documenting a revision does not sign treatment consent or change treatment or the account.",
  "تعذّرت قراءة الدراسة أو تغيرت الصلاحية. لم يُعتبر السجل فارغًا ولم تُستبدل المسودة.": "The study could not be read or access changed. The record was not treated as empty and the draft was retained.",
  "التعديل غير صالح أو تجاوز الحد؛ بقيت المسودة السابقة محفوظة محليًا.": "The edit is invalid or exceeds the limit. The previous local draft was retained.",
  "اكتب سبب حفظ هذه النسخة.": "Enter a reason for saving this revision.",
  "بلغ سجل الطلبات غير المحسومة الحد الآمن. تحقّق من الطلبات السابقة قبل حفظ طلب جديد؛ القراءة والمسودة لا تزالان متاحتين.": "The pending request limit was reached. Resolve previous requests before saving a new request. Reading and the draft remain available.",
  "لم يُؤكد الحفظ. احتُفظ بالمسودة؛ تحقّق من التعارض أو أعد نفس الطلب عند عدم اليقين.": "Saving was not confirmed. The draft was retained. Check for a conflict or retry the same request if its outcome is uncertain.",
  "تغير المصدر. أزل الاختيار القديم صراحة قبل اختيار النسخة الجديدة؛ لم تُنقل تعديلات الصور تلقائيًا.": "The source changed. Explicitly remove the old selection before selecting the new version. Image edits were not transferred automatically.",
  "توجد تعديلات محلية محفوظة لسياق سابق لهذه الحالة. لن يُكشف محتواها لحساب أو مريض أو رابط مختلف، ولن تُستبدل تلقائيًا. عُد للسياق الأصلي بعد التحقق من الصلاحية.": "Local edits belong to a previous context for this case. Their contents will not be shown to a different account, patient or case link, or replaced automatically. Return to the original context after verifying access.",
  "نتيجة الطلب السابق غير مؤكدة. لن يُنشأ طلب حفظ جديد ولن تُحذف المسودة.": "The previous request outcome is uncertain. No new save request will be created and the draft will be retained.",
  "إعادة التحقق بنفس الطلب": "Recheck the same request",
  "الدراسة غير جاهزة للعرض أو التعديل.": "The study is not ready to view or edit.",
  "النسخة المعروضة": "Displayed revision",
  "آخر نسخة محفوظة": "Latest saved revision",
  "النسخة": "Revision",
  "مسودة": "Draft",
  "موثقة": "Documented",
  "تحديث القراءة دون حذف المسودة": "Refresh without discarding the draft",
  "تعذّر فك المسودة المحلية؛ لم تُستبدل بمحتوى فارغ.": "The local draft could not be decoded. It was not replaced with empty content.",
  "عرض فقط حسب الصلاحية الحالية.": "Read only under current access.",
  "سبب حفظ النسخة": "Reason for saving this revision",
  "تعليق الدراسة": "Study comment",
  "قسم جديد للدراسة": "New study section",
  "إضافة القسم": "Add section",
  "تضمين القسم في العرض": "Include section in presentation",
  "تعليق": "Comment",
  "المراجع المختارة:": "Selected sources:",
  "لم يُختر مصدر. لا تُفترض نتائج طبيعية.": "No source selected. Normal findings are not assumed.",
  "نقل للأعلى": "Move up",
  "نقل للأسفل": "Move down",
  "إضافة المرجع إلى القسم": "Add source to section",
  "المراجع المحفوظة في المسودة": "Sources retained in the draft",
  "نسخة": "Version",
  "إزالة المرجع واستخداماته من هذه المسودة": "Remove source and its uses from this draft",
  "إطار الصورة غير متاح؛ لم تُحذف تعديلات الاستخدام.": "The image frame is unavailable. Edits to this use were retained.",
  "حفظ مسودة الدراسة": "Save study draft",
  "توثيق النسخة المحفوظة نفسها": "Document this saved revision",
  "التصدير غير مفعّل حتى اكتمال التحقق من ملفات PowerPoint وPDF. حفظ الدراسة وإعادة فتحها لا يحتاجان محرك التصدير.": "Export is not enabled until PowerPoint and PDF verification is complete. Saving and reopening the study do not require the export engine.",
  "المستند": "Document",
  "مختار. إسناده إلى إطار صورة ينتظر أساس أبعاد واتجاه موثوقًا؛ لا تمنع هذه الخطوة حفظ الدراسة.": "is selected. Assigning it to an image frame requires verified dimensions and orientation. This does not prevent saving the study.",
  "تعذّرت قراءة المراجع أو أن القسم مقيّد؛ لم تُعتبر القائمة فارغة.": "Sources could not be read or this section is restricted. The list was not treated as empty.",
  "اختيار مصدر حقيقي": "Select an existing source",
  "نوع مصدر الدراسة": "Study source type",
  "هذا النوع من المصادر مقيّد بالصلاحية الحالية.": "This source type is restricted under current access.",
  "اختيار": "Select",
  "المصدر غير متاح بهذه النسخة؛ لا تُفترض بيانات بديلة.": "This source version is unavailable. No replacement data is assumed.",
  "لا توجد مراجع من هذا النوع في الصفحة الحالية.": "No sources of this type on the current page.",
  "الصفحة الأولى": "First page",
  "المراجع التالية": "Next sources",
  "مراجعة الدراسة المحفوظة": "Saved study review",
  "مراجعة النسخة المحفوظة": "Review saved revision",
  "هذا العرض من النسخة المحفوظة المحددة. التعديلات المحلية لا تظهر فيه قبل الحفظ؛ توثيق الدراسة لا يعني اعتمادًا سريريًا جديدًا.": "This view uses the selected saved revision. Local edits appear only after saving. Documenting the study does not constitute new clinical approval.",
  "القسم المحفوظ المعروض": "Displayed saved section",
  "تغيرت صلاحية أو هوية العرض؛ يلزم تحقق جديد.": "View access or identity changed. Verification is required.",
  "تعذّرت مراجعة هذا القسم أو تغيّرت صلاحية مصدره. لا تعني النتيجة خلو السجل ولا تعرض نسخة بديلة.": "This section could not be reviewed or source access changed. This does not mean the record is empty. No substitute revision is displayed.",
  "جارٍ قراءة القسم المحفوظ…": "Reading the saved section…",
  "وقت التقاط النسخة:": "Revision captured at:",
  "مضمّن في العرض المختار": "Included in the selected presentation",
  "مستبعد من العرض المختار؛ محفوظ للمراجعة": "Excluded from the selected presentation; retained for review",
  "حالة القسم المحفوظة:": "Saved section state:",
  "متاح": "Available",
  "غير مسجل": "Not recorded",
  "غير متاح": "Unavailable",
  "مقيّد": "Restricted",
  "لا تُعرض حقائق سريرية أو صور لهذا القسم وفق حالته المحفوظة. بقيت المراجع والتعليقات في النسخة دون تغيير؛ هذه الحالة لا تمنح صلاحية وصول.": "No clinical facts or images are displayed for this section in its saved state. Sources and comments remain unchanged in the revision. This state does not grant access.",
  "جدول محفوظ": "Saved table",
  "لا توجد حقائق نصية مسجلة ومطابقة لهذا القسم. لا تُفترض نتائج طبيعية.": "No recorded textual facts match this section. Normal findings are not assumed.",
  "مصادر غير متاحة في الالتقاط المحفوظ:": "Sources unavailable in the saved capture:",
  "مصادر محفوظة لم يكتمل عرضها في هذا القسم:": "Saved sources not yet fully displayed in this section:",
  "وصف السبب غير متاح؛ الرمز المحفوظ:": "Reason description unavailable; recorded code:",
  "الصور المختارة لهذا القسم:": "Images selected for this section:",
  "المعاينة المتحققة غير متاحة هنا بعد؛ لم تُستبدل الصور بصور افتراضية.": "Verified previews are not yet available here. No placeholder images were substituted.",
  "مراجع الصور المحتفظ بها دون عرض:": "Image references retained without display:",
  "تعليقات مؤلف الدراسة المحفوظة": "Saved study author comments",
  "المحتوى المحفوظ أدناه معروض بلغته الأصلية دون ترجمة أو تعديل.": "The saved content below is shown in its original language without translation or modification."
} as const;
export type StudyMessage = keyof typeof STUDY_ENGLISH;
export const studyText = (locale: StudyDisplayLocale, message: StudyMessage): string => locale === "en" ? STUDY_ENGLISH[message] : message;
export const studyDirection = (locale: StudyDisplayLocale) => locale === "ar" ? "rtl" : "ltr";
export const readStudyDisplayLocale = (value: unknown): StudyDisplayLocale => value === "en" ? "en" : "ar";
export const studyLayoutTitle = (key: string, locale: StudyDisplayLocale): string => {
  const layout = caseLayout(key);
  return layout ? (locale === "en" ? layout.titleEn : layout.titleAr) : studyText(locale, "غير متاح");
};
const sourceNames: Record<StudySourceKind, readonly [string, string]> = {
  "assessment": [
    "التقييم",
    "Assessment"
  ],
  "diagnosis": [
    "التشخيص",
    "Diagnosis"
  ],
  "strategy": [
    "المشكلات والاستراتيجية",
    "Problems and strategy"
  ],
  "decision": [
    "القرارات",
    "Decisions"
  ],
  "retention_event": [
    "أجهزة التثبيت ومتابعتها",
    "Retention appliances and follow-up"
  ],
  "document": [
    "الصور والمستندات",
    "Images and documents"
  ],
  "ceph_study": [
    "السيفالومتري",
    "Cephalometry"
  ],
  "adjustment": [
    "جلسات المتابعة",
    "Follow-up sessions"
  ],
  "plan_consent": [
    "الخطة والموافقة المسجلة",
    "Recorded plan and consent"
  ]
};
export const studySourceName = (kind: StudySourceKind, locale: StudyDisplayLocale): string => sourceNames[kind][locale === "en" ? 1 : 0];

/** Display-only descriptions of codes emitted by the existing source readers.
 * Unknown codes remain unknown. Never translate authored prose by matching it here. */
const sourceReasons = {
  source_missing_or_outside_case: ["المصدر غير موجود أو لا يتبع هذه الحالة.", "The source is missing or does not belong to this case."],
  source_schema_unavailable: ["بنية المصدر غير متاحة لهذه القراءة.", "The source schema is unavailable for this read."],
  document_removed: ["أُزيل المستند؛ لم يُستبدل بمستند آخر.", "The document was removed. No replacement was substituted."],
  ceph_review_projection_unavailable: ["عرض مراجعة السيفالومتري غير متاح لهذا المصدر.", "The cephalometric review projection is unavailable for this source."],
  source_unavailable: ["المصدر غير متاح.", "The source is unavailable."],
  assessment_layout_not_mapped: ["لم يُربط التقييم بعرض هذا القسم.", "The assessment has not been mapped to this section."],
  retention_event_not_debond: ["الحدث المختار ليس حدث فك الجهاز.", "The selected event is not an appliance removal event."],
  layout_source_projection_not_implemented: ["عرض هذا النوع من المصادر في هذا القسم غير مفعّل بعد.", "Presentation of this source type in this section is not implemented yet."],
} as const;
export function studySourceReason(reason: string, locale: StudyDisplayLocale): string | null {
  return Object.hasOwn(sourceReasons, reason) ? sourceReasons[reason as keyof typeof sourceReasons][locale === "en" ? 1 : 0] : null;
}
