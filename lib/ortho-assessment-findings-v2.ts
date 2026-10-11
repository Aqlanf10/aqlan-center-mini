import { editMeasurementPayloadV2, type MeasurementEditorDraftV2 } from "./ortho-assessment-measurement-editor-v2";
import type { AssessmentObservationV2, ObservationTarget } from "./ortho-assessment-v2";
export const CLINICAL_FIELDS_V2 = [
  ["chiefComplaint", "الشكوى الرئيسية", "history"], ["medicalHistory", "مرجع التاريخ الطبي عند بداية الحالة", "history"],
  ["dentalHistory", "التاريخ السني", "history"], ["familyHistory", "التاريخ العائلي", "history"], ["growthHistory", "تاريخ وتقييم النمو", "history"],
  ["facialProfile", "المظهر الجانبي للوجه", "facial"], ["facialSymmetry", "تناظر الوجه", "facial"],
  ["facialFifths", "أخماس الوجه", "facial"], ["facialThirds", "أثلاث الوجه", "facial"], ["lips", "الشفتان", "facial"], ["smile", "الابتسامة", "facial"],
  ["upperMidline", "الخط المتوسط العلوي", "intraoral"], ["lowerMidline", "الخط المتوسط السفلي", "intraoral"],
  ["upperArchForm", "شكل القوس العلوية", "intraoral"], ["lowerArchForm", "شكل القوس السفلية", "intraoral"],
  ["rightMolarRelation", "علاقة الأرحاء يمينًا", "intraoral"], ["leftMolarRelation", "علاقة الأرحاء يسارًا", "intraoral"],
  ["rightCanineRelation", "علاقة الأنياب يمينًا", "intraoral"], ["leftCanineRelation", "علاقة الأنياب يسارًا", "intraoral"],
  ["anteriorCrossbite", "العضة المعكوسة الأمامية", "intraoral"], ["posteriorCrossbite", "العضة المعكوسة الخلفية", "intraoral"],
  ["curveOfSpee", "منحنى سبي", "intraoral"], ["toothFindings", "الملاحظات السنية والأسطح", "intraoral"],
  ["overjet", "البروز الأفقي Overjet", "intraoral"], ["overbite", "التراكب العمودي Overbite", "intraoral"],
] as const;
export type ClinicalFieldV2 = typeof CLINICAL_FIELDS_V2[number][0];
export const CLINICAL_CHOICES_V2: Partial<Record<ClinicalFieldV2, readonly string[]>> = {
  chiefComplaint: ["ازدحام الأسنان", "فراغات بين الأسنان", "بروز الأسنان", "صعوبة الإطباق"],
  dentalHistory: ["علاج تقويمي سابق", "قلع سابق", "إصابة سنية سابقة"], familyHistory: ["تاريخ عائلي لمشكلة إطباقية"],
  facialProfile: ["محدب", "مستقيم", "مقعر"], facialSymmetry: ["متناظر", "غير متناظر"],
  lips: ["إغلاق شفوي مريح", "إغلاق مع إجهاد", "عدم انطباق الشفتين"],
  upperMidline: ["متوافق مع خط الوجه", "انحراف يمينًا", "انحراف يسارًا"], lowerMidline: ["متوافق مع الخط العلوي", "انحراف يمينًا", "انحراف يسارًا"],
  upperArchForm: ["بيضوية", "مربعة", "متضيقة"], lowerArchForm: ["بيضوية", "مربعة", "متضيقة"],
  rightMolarRelation: ["الصنف الأول", "الصنف الثاني", "الصنف الثالث", "غير قابل للتحديد"], leftMolarRelation: ["الصنف الأول", "الصنف الثاني", "الصنف الثالث", "غير قابل للتحديد"],
  rightCanineRelation: ["الصنف الأول", "الصنف الثاني", "الصنف الثالث", "غير قابل للتحديد"], leftCanineRelation: ["الصنف الأول", "الصنف الثاني", "الصنف الثالث", "غير قابل للتحديد"],
  anteriorCrossbite: ["موجودة — حدد الأسنان", "غير موجودة بعد الفحص"], posteriorCrossbite: ["أحادية الجانب — حدد الجانب", "ثنائية الجانب", "غير موجودة بعد الفحص"],
};
export function clinicalFieldIdV2(field: ClinicalFieldV2) { return `clinical_${field}`; }
export function blankClinicalObservationV2(field: ClinicalFieldV2): AssessmentObservationV2 {
  const config = CLINICAL_FIELDS_V2.find(row => row[0] === field)!;
  const numeric = field === "overjet" || field === "overbite";
  const target: ObservationTarget = field.startsWith("upper") ? { kind: "arch", arch: "upper" } : field.startsWith("lower") ? { kind: "arch", arch: "lower" }
    : field.startsWith("right") ? { kind: "side", side: "right" } : field.startsWith("left") ? { kind: "side", side: "left" } : { kind: "case" };
  return { id: clinicalFieldIdV2(field), definition: numeric ? field : field === "growthHistory" ? "growth_assessment" : "clinical_finding",
    definitionVersion: 1, label: config[1], unit: numeric ? "mm" : "qualitative", target,
    value: { state: "not_recorded" }, occurredOn: null, provenance: null };
}
/** Explicitly add a missing named observation. Never replace a conflicting ID. */
export function addClinicalFieldV2(draft: MeasurementEditorDraftV2, field: ClinicalFieldV2): MeasurementEditorDraftV2 | null {
  const row = blankClinicalObservationV2(field);
  if (draft.payload.observations.observations.some(existing => existing.id === row.id)) return null;
  const next = editMeasurementPayloadV2({ ...draft.payload, observations: { ...draft.payload.observations, observations: [...draft.payload.observations.observations, row] } });
  return next ? { ...next, decimal: draft.decimal, values: { ...draft.values, [row.id]: next.values[row.id] } } : null;
}
