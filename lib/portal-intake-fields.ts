/** Browser-safe intake vocabulary only. Session signing stays in portal.ts. */
export const INTAKE_CONDITIONS: { key: string; label: string }[] = [
  { key: "diabetes", label: "السكري" },
  { key: "hypertension", label: "ارتفاع الضغط" },
  { key: "heart", label: "مرض قلبي" },
  { key: "asthma", label: "الربو" },
  { key: "kidney", label: "مرض كلى" },
  { key: "liver", label: "مرض كبد" },
  { key: "thyroid", label: "خلل الغدة الدرقية" },
  { key: "epilepsy", label: "الصرع" },
  { key: "pregnancy", label: "الحمل" },
  { key: "bleeding", label: "اضطراب نزف أو مضيعات دم" },
  { key: "anesthesia", label: "مضاعفات سابقة من التخدير" },
];

export interface IntakeAnswers {
  conditions: string[];
  allergies: string | null;
  medications: string | null;
  emergencyName: string | null;
  emergencyPhone: string | null;
  note: string | null;
}

