import { editMeasurementPayloadV2, type MeasurementEditorDraftV2 } from "./ortho-assessment-measurement-editor-v2";
import { blankClinicalObservationV2, type ClinicalFieldV2 } from "./ortho-assessment-clinical-fields";
import { sameAssessmentStructure } from "./ortho-assessment-read-v2";
export { CLINICAL_FIELDS_V2, clinicalFieldIdV2, blankClinicalObservationV2, type ClinicalFieldV2 } from "./ortho-assessment-clinical-fields";
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
/** Explicitly add a missing named observation. Never replace a conflicting ID. */
export function addClinicalFieldV2(draft: MeasurementEditorDraftV2, field: ClinicalFieldV2): MeasurementEditorDraftV2 | null {
  const row = blankClinicalObservationV2(field);
  if (draft.payload.observations.observations.some(existing => existing.id === row.id)) return null;
  const next = editMeasurementPayloadV2({ ...draft.payload, observations: { ...draft.payload.observations, observations: [...draft.payload.observations.observations, row] } });
  return next ? { ...next, decimal: draft.decimal, values: { ...draft.values, [row.id]: next.values[row.id] } } : null;
}
/** A schema-valid observation can still belong to a different clinical target.
 * Every named editor, source and copy destination must pass this same identity. */
export function isClinicalFieldIdentityV2(draft: MeasurementEditorDraftV2, field: ClinicalFieldV2): boolean {
  const shape = blankClinicalObservationV2(field), row = draft.payload.observations.observations.find(item => item.id === shape.id);
  return !!row && !!draft.values[shape.id] && row.definition === shape.definition && row.unit === shape.unit
    && sameAssessmentStructure(row.target, shape.target);
}
/** Typing is an explicit observation, not a normal finding or clinical approval.
 * Empty untouched inputs remain unrecorded. Erasing an entered value stays
 * incomplete until explicitly changed, so neither provenance nor missingness
 * is silently rewritten. The existing save validator still owns admission. */
export function editClinicalFindingValueV2(draft: MeasurementEditorDraftV2, field: ClinicalFieldV2, input: string): MeasurementEditorDraftV2 | null {
  const shape = blankClinicalObservationV2(field);
  const value = draft.values[shape.id], numeric = shape.unit === "mm", entered = numeric ? "measured" : "recorded";
  if (!isClinicalFieldIdentityV2(draft, field) || !value
    || value.state !== "not_recorded" && value.state !== entered) return null;
  return { ...draft, values: { ...draft.values, [shape.id]: { ...value,
    state: value.state === "not_recorded" && !input.trim() ? "not_recorded" : entered,
    ...(numeric ? { numberText: input } : { text: input }),
  } } };
}
