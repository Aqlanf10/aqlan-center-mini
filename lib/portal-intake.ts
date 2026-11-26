// ── الاستمارة الرقمية ────────────────────────────────────────────────────────

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

export type IntakeValidation =
  | { ok: true; value: IntakeAnswers }
  | { ok: false; message: string };

const VALID_CONDITION_KEYS = new Set(INTAKE_CONDITIONS.map((condition) => condition.key));
const TEXT_LIMIT = 500;

function cleanText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}

export function validateIntake(raw: unknown): IntakeValidation {
  const source = (raw ?? {}) as Record<string, unknown>;
  const conditionsRaw = Array.isArray(source.conditions) ? source.conditions : [];
  const conditions: string[] = [];
  for (const key of conditionsRaw) {
    if (typeof key !== "string" || !VALID_CONDITION_KEYS.has(key)) {
      return { ok: false, message: "قائمة الحالات غير صحيحة." };
    }
    if (!conditions.includes(key)) conditions.push(key);
  }
  const allergies = cleanText(source.allergies, TEXT_LIMIT);
  const medications = cleanText(source.medications, TEXT_LIMIT);
  const emergencyName = cleanText(source.emergencyName, 120);
  const emergencyPhone = cleanText(source.emergencyPhone, 30);
  const note = cleanText(source.note, TEXT_LIMIT);
  if (emergencyPhone && emergencyPhone.replace(/\D/g, "").length < 7) {
    return { ok: false, message: "رقم الطوارئ غير صحيح." };
  }
  return { ok: true, value: { conditions, allergies, medications, emergencyName, emergencyPhone, note } };
}
