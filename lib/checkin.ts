/**
 * كشك التسجيل الذاتي والاستمارة الطبية للمريض — المنطق الخالص.
 *
 * يتيح للمريض الواصل لصالة الانتظار مسح رمز QR بهاتفه وتسجيل حضوره،
 * وتحديد الشكوى الرئيسية، واستيفاء الفحص الصحي الدقيق، مما يسرّع عمل
 * الاستقبال ويضمن وصول التنبيهات الطبية الحرجة لكرسي الطبيب فوراً.
 */

import { samePhone } from "./duplicates";
import type { Gender } from "./patient";

export type ChiefComplaintId =
  | "emergency_pain"
  | "routine_checkup"
  | "scaling_polishing"
  | "filling_caries"
  | "root_canal"
  | "cosmetic_whitening"
  | "orthodontics"
  | "implant_prostho"
  | "pediatric"
  | "other";

export interface ChiefComplaintMeta {
  id: ChiefComplaintId;
  label: string;
  icon: string;
  isUrgent: boolean;
  hint: string;
}

export const CHIEF_COMPLAINTS: ChiefComplaintMeta[] = [
  {
    id: "emergency_pain",
    label: "ألم أسنان حاد / طوارئ",
    icon: "⚡",
    isUrgent: true,
    hint: "ألم مستمر، نبض، انتفاخ، أو كسر مفاجئ في السن",
  },
  {
    id: "routine_checkup",
    label: "فحص دوري وكشف شامل",
    icon: "🔍",
    isUrgent: false,
    hint: "معاينة عامة للأسنان واللثة وتحديد خطة علاج",
  },
  {
    id: "scaling_polishing",
    label: "تنظيف وتلميع وإزالة الجير",
    icon: "✨",
    isUrgent: false,
    hint: "إزالة الترسبات الجيرية وعلاج نزيف اللثة ورائحة الفم",
  },
  {
    id: "filling_caries",
    label: "حشوات تجميلية / تسوس",
    icon: "🦷",
    isUrgent: false,
    hint: "علاج النخر والتسوسات بحشوات ضوئية تجميلية",
  },
  {
    id: "root_canal",
    label: "علاج وجراحة العصب",
    icon: "🔬",
    isUrgent: false,
    hint: "سحب العصب وتطهير الجذور وحشو الأقنية السنية",
  },
  {
    id: "cosmetic_whitening",
    label: "ابتسامة هوليوود وتبييض",
    icon: "💎",
    isUrgent: false,
    hint: "تبييض الأسنان أو فينير وقشور خزفية تجميلية",
  },
  {
    id: "orthodontics",
    label: "تقويم الأسنان ومتابعته",
    icon: "📐",
    isUrgent: false,
    hint: "كشف أولي للتقويم أو شد وتعديل أسلاك تقويم قائم",
  },
  {
    id: "implant_prostho",
    label: "زراعة أسنان وتركيبات",
    icon: "🔩",
    isUrgent: false,
    hint: "تعويض الأسنان المفقودة بالزراعة أو تيجان وجسور الزيركون",
  },
  {
    id: "pediatric",
    label: "طب أسنان الأطفال",
    icon: "🧸",
    isUrgent: false,
    hint: "علاج أسنان الأطفال اللبنية والدائمة بأسلوب لطيف ومحبب",
  },
  {
    id: "other",
    label: "استشارة أو سبب آخر",
    icon: "📝",
    isUrgent: false,
    hint: "قلع ضرس، مراجعة بعد علاج، أو استشارة عامة",
  },
];

export interface MedicalQuestionMeta {
  key: string;
  label: string;
  category: "critical" | "warning" | "general";
  icon: string;
  clinicalAlert: string;
}

export const CHECKIN_MEDICAL_QUESTIONS: MedicalQuestionMeta[] = [
  {
    key: "diabetes",
    label: "هل تعاني من داء السكري؟",
    category: "warning",
    icon: "💉",
    clinicalAlert: "سكري",
  },
  {
    key: "hypertension",
    label: "هل تعاني من ارتفاع ضغط الدم؟",
    category: "warning",
    icon: "❤️",
    clinicalAlert: "ضغط مرتفع",
  },
  {
    key: "cardiac",
    label: "هل تعاني من أمراض قلب أو قسطرة أو صمامات؟",
    category: "critical",
    icon: "🫀",
    clinicalAlert: "أمراض قلب وصمامات",
  },
  {
    key: "bleeding",
    label: "هل تعاني من سيولة بالدم أو تتناول أسبرين/مميعات؟",
    category: "critical",
    icon: "🩸",
    clinicalAlert: "سيولة دم / مميعات",
  },
  {
    key: "penicillin_allergy",
    label: "هل لديك حساسية من البنسلين أو أي مضاد حيوي؟",
    category: "critical",
    icon: "💊",
    clinicalAlert: "حساسية بنسلين",
  },
  {
    key: "latex_allergy",
    label: "هل لديك حساسية من قفازات اللاتكس أو مواد طبية؟",
    category: "warning",
    icon: "🧤",
    clinicalAlert: "حساسية لاتكس",
  },
  {
    key: "anesthesia_issues",
    label: "هل عانيت سابقاً من مشاكل أو إغماء مع بنج الأسنان؟",
    category: "critical",
    icon: "⚠️",
    clinicalAlert: "مضاعفات بنج سابقة",
  },
  {
    key: "pregnancy",
    label: "هل يوجد حمل أو إرضاع طبيعي؟ (للسيدات)",
    category: "critical",
    icon: "🤰",
    clinicalAlert: "حامل / إرضاع",
  },
  {
    key: "asthma",
    label: "هل تعاني من الربو أو صعوبة بالتنفس؟",
    category: "warning",
    icon: "🫁",
    clinicalAlert: "ربو تحسسي",
  },
  {
    key: "kidney_liver",
    label: "هل تعاني من أمراض بالكلى أو الكبد؟",
    category: "critical",
    icon: "⚠️",
    clinicalAlert: "أمراض كلى / كبد",
  },
];

export interface CheckinInput {
  phone: string;
  fullName: string;
  gender?: Gender;
  birthYear?: number | null;
  complaintId: ChiefComplaintId;
  complaintNote?: string | null;
  conditions: string[];
  allergies?: string | null;
  medications?: string | null;
  emergencyName?: string | null;
  emergencyPhone?: string | null;
  habits?: {
    smoking?: boolean;
    khat?: boolean;
  };
  signatureDataUrl?: string | null;
}

export type CheckinValidation =
  | { ok: true; value: CheckinInput }
  | { ok: false; message: string };

const VALID_COMPLAINTS = new Set(CHIEF_COMPLAINTS.map((c) => c.id));
const VALID_CONDITIONS = new Set(CHECKIN_MEDICAL_QUESTIONS.map((q) => q.key));

export function validateCheckinInput(raw: unknown): CheckinValidation {
  if (!raw || typeof raw !== "object") {
    return { ok: false, message: "بيانات التسجيل غير صالحة." };
  }
  const body = raw as Record<string, unknown>;

  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const phoneDigits = phone.replace(/\D/g, "");
  if (phoneDigits.length < 7 || phoneDigits.length > 15) {
    return { ok: false, message: "يرجى إدخال رقم جوال صحيح للتواصل وتأكيد الدور." };
  }

  const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
  if (fullName.length < 3) {
    return { ok: false, message: "يرجى كتابة الاسم الكامل (الثنائي على الأقل)." };
  }

  const complaintId = body.complaintId as ChiefComplaintId;
  if (!VALID_COMPLAINTS.has(complaintId)) {
    return { ok: false, message: "يرجى اختيار سبب الزيارة أو الشكوى الرئيسية." };
  }

  const gender = body.gender === "female" ? "female" : body.gender === "male" ? "male" : "unknown";

  let birthYear: number | null = null;
  if (typeof body.birthYear === "number" && body.birthYear > 1920 && body.birthYear <= new Date().getFullYear()) {
    birthYear = body.birthYear;
  } else if (typeof body.age === "number" && body.age >= 0 && body.age < 120) {
    birthYear = new Date().getFullYear() - body.age;
  }

  const conditionsRaw = Array.isArray(body.conditions) ? body.conditions : [];
  const conditions = conditionsRaw.filter((k): k is string => typeof k === "string" && VALID_CONDITIONS.has(k));

  const allergies = typeof body.allergies === "string" && body.allergies.trim() ? body.allergies.trim().slice(0, 300) : null;
  const medications = typeof body.medications === "string" && body.medications.trim() ? body.medications.trim().slice(0, 300) : null;
  const complaintNote = typeof body.complaintNote === "string" && body.complaintNote.trim() ? body.complaintNote.trim().slice(0, 400) : null;
  const emergencyName = typeof body.emergencyName === "string" && body.emergencyName.trim() ? body.emergencyName.trim().slice(0, 100) : null;
  const emergencyPhone = typeof body.emergencyPhone === "string" && body.emergencyPhone.trim() ? body.emergencyPhone.trim().slice(0, 30) : null;

  const habitsRaw = body.habits as Record<string, unknown> | undefined;
  const habits = {
    smoking: Boolean(habitsRaw?.smoking),
    khat: Boolean(habitsRaw?.khat),
  };

  const signatureDataUrl = typeof body.signatureDataUrl === "string" && body.signatureDataUrl.startsWith("data:image/")
    ? body.signatureDataUrl
    : null;

  return {
    ok: true,
    value: {
      phone,
      fullName,
      gender,
      birthYear,
      complaintId,
      complaintNote,
      conditions,
      allergies,
      medications,
      emergencyName,
      emergencyPhone,
      habits,
      signatureDataUrl,
    },
  };
}

/**
 * يولّد وسم التنبيه الطبي السريري للمريض بناءً على إجابات الاستمارة الصحية.
 */
export function serializeCheckinAlerts(
  input: CheckinInput,
  existingAlert?: string | null,
): string {
  const alerts: string[] = [];

  for (const cond of input.conditions) {
    const q = CHECKIN_MEDICAL_QUESTIONS.find((item) => item.key === cond);
    if (q) alerts.push(q.clinicalAlert);
  }

  if (input.allergies) {
    alerts.push(`حساسية: ${input.allergies}`);
  }

  if (input.medications) {
    alerts.push(`أدوية: ${input.medications}`);
  }

  if (input.habits?.smoking) {
    alerts.push("مدخن");
  }
  if (input.habits?.khat) {
    alerts.push("مستهلك قات");
  }

  const newAlertText = alerts.join(" · ");
  if (!existingAlert || !existingAlert.trim()) {
    return newAlertText;
  }

  // دمج التنبيه مع القائم وتجنب التكرار
  const existingParts = existingAlert.split("·").map((p) => p.trim()).filter(Boolean);
  for (const part of alerts) {
    if (!existingParts.some((ex) => ex.includes(part) || part.includes(ex))) {
      existingParts.push(part);
    }
  }
  return existingParts.join(" · ");
}

/**
 * يولّد ملاحظة الزيارة الموجهة لكرسي الطبيب ولائحة الانتظار.
 */
export function buildCheckinVisitNote(input: CheckinInput): string {
  const complaint = CHIEF_COMPLAINTS.find((c) => c.id === input.complaintId);
  const complaintLabel = complaint ? complaint.label : "زيارة عامة";
  const parts = [`الشكوى: ${complaintLabel}`];

  if (complaint?.isUrgent) {
    parts.unshift("🚨 [طوارئ وألم حاد]");
  }

  if (input.complaintNote) {
    parts.push(`تفاصيل: ${input.complaintNote}`);
  }

  if (input.conditions.length > 0) {
    const condLabels = input.conditions
      .map((k) => CHECKIN_MEDICAL_QUESTIONS.find((q) => q.key === k)?.clinicalAlert)
      .filter(Boolean);
    parts.push(`حالة صحية: ${condLabels.join("، ")}`);
  }

  if (input.allergies) {
    parts.push(`⚠️ حساسية: ${input.allergies}`);
  }

  return parts.join(" | ");
}

/**
 * يحسب الموقع والوقت التقديري للانتظار.
 */
export function calculateQueueEstimate(
  waitingAhead: number,
  avgWaitMinutes: number | null,
): {
  positionText: string;
  estimatedWaitMinutes: number;
} {
  const pace = avgWaitMinutes && avgWaitMinutes > 5 && avgWaitMinutes < 60 ? avgWaitMinutes : 15;
  const estimated = Math.max(0, waitingAhead * pace);

  if (waitingAhead <= 0) {
    return {
      positionText: "أنت التالي للدخول مباشرة",
      estimatedWaitMinutes: 0,
    };
  }
  if (waitingAhead === 1) {
    return {
      positionText: "أمامك مريض واحد فقط",
      estimatedWaitMinutes: estimated,
    };
  }
  if (waitingAhead === 2) {
    return {
      positionText: "أمامك مريضان",
      estimatedWaitMinutes: estimated,
    };
  }
  return {
    positionText: `أمامك ${waitingAhead} مرضى`,
    estimatedWaitMinutes: estimated,
  };
}
