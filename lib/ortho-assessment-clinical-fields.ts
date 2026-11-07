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
