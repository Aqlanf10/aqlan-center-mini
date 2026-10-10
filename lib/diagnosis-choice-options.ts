/** Documentation vocabulary only. No thresholds, diagnosis inference or defaults.
 * Sources and field mapping are recorded in the accompanying review packet.
 * Values remain the existing clinician-authored strings, never taxonomy codes.
 */
export interface DiagnosisChoiceGroup {
  label: string;
  options: readonly { value: string; searchTerms?: string }[];
}

export const DIAGNOSIS_CHOICE_GROUPS: Record<"skeletal" | "dental" | "crowding" | "bite", readonly DiagnosisChoiceGroup[]> = {
  skeletal: [{ label: "العلاقة الهيكلية", options: [
    { value: "Class I", searchTerms: "الصنف الأول الهيكلي skeletal 1" },
    { value: "Class II", searchTerms: "الصنف الثاني الهيكلي skeletal 2" },
    { value: "Class III", searchTerms: "الصنف الثالث الهيكلي skeletal 3" },
  ] }],
  dental: [{ label: "الصنف السني", options: [
    { value: "Class I", searchTerms: "الصنف الأول dental 1" },
    { value: "Class II", searchTerms: "الصنف الثاني dental 2" },
    { value: "Class II Div 1", searchTerms: "الصنف الثاني الشعبة الأولى division 1" },
    { value: "Class II Div 2", searchTerms: "الصنف الثاني الشعبة الثانية division 2" },
    { value: "Class III", searchTerms: "الصنف الثالث dental 3" },
  ] }],
  crowding: [
    { label: "وصف الازدحام", options: [
      { value: "ازدحام أمامي", searchTerms: "anterior crowding" },
      { value: "ازدحام خفيف", searchTerms: "mild crowding" },
      { value: "ازدحام متوسط", searchTerms: "moderate crowding" },
    ] },
    { label: "الفراغات", options: [{ value: "فراغات سنية", searchTerms: "spacing" }] },
  ],
  bite: [
    { label: "العضة الرأسية", options: [{ value: "عضة عميقة", searchTerms: "deep bite overbite" }] },
    { label: "العلاقات العرضية", options: [
      { value: "عضة معكوسة أمامية", searchTerms: "anterior crossbite cross bite" },
      { value: "عضة معكوسة خلفية", searchTerms: "posterior crossbite cross bite" },
      { value: "عضة مقصية", searchTerms: "scissors bite scissor" },
    ] },
  ],
};
