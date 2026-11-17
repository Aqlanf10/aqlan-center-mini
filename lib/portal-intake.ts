/**
 * استمارة الصحة العامة.
 *
 * قائمة شروط ثابتة تُؤشَّر لا حقل حرّ أولًا: الطاقم يقرأ في ثوانٍ، والبيانات تبقى
 * قابلة للعدّ. النص الحر للمضادات والأدوية والملاحظات يأتي بعد القائمة لا قبلها.
 * والاستمارة **تُضاف إليها فقط**: كل إرسال نسخة جديدة، فتاريخ الصحة لا يُستبدل.
 */
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
