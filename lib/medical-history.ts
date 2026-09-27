/**
 * (PAT-2) التاريخ الطبي المنظَّم — كما في الأنظمة الرائدة: استبيانٌ نعم/لا بأسئلةٍ ثابتة،
 * وقائمة حساسية بشدتها، وقائمة أدوية، وتصنيف ASA، وفصيلة الدم، ومراجعةٌ دورية موقّعة.
 *
 * كل حفظٍ نسخةٌ جديدة (سجلٌّ لا يُعدَّل) — فيُعرف ماذا قال المريض ومتى ومن سجّله. والتنبيهات
 * التي تظهر في كل شاشة تُشتق من آخر نسخة، بجانب التنبيه النصي القديم الذي يبقى كما هو.
 *
 * منطقٌ خالص: التحقق والاشتقاق هنا، والقاعدة تحفظ ما صحّ فقط.
 */
import { BLOOD_GROUPS } from "./patient";

export type Answer = "yes" | "no" | "unknown";
export type Risk = "high" | "medium";

export interface HistoryQuestion {
  key: string;
  label: string;
  /** خطر الإجابة بـ«نعم» على العلاج السني — يُشتق منه تنبيه. null: معلومة لا تنبيه. */
  risk: Risk | null;
  /** نص التنبيه عند «نعم». */
  alert?: string;
}

export const HISTORY_QUESTIONS: HistoryQuestion[] = [
  { key: "heart_disease", label: "أمراض القلب أو الذبحة أو جلطة سابقة", risk: "high", alert: "مريض قلب" },
  { key: "heart_valve", label: "صمام صناعي أو التهاب شغاف سابق (يحتاج مضادًّا وقائيًّا)", risk: "high", alert: "صمام/شغاف — وقاية بالمضاد" },
  { key: "pacemaker", label: "منظّم ضربات القلب", risk: "high", alert: "منظّم قلب" },
  { key: "hypertension", label: "ارتفاع ضغط الدم", risk: "medium", alert: "ضغط مرتفع" },
  { key: "diabetes", label: "السكري", risk: "medium", alert: "سكري" },
  { key: "bleeding_disorder", label: "اضطراب نزف أو سيولة", risk: "high", alert: "اضطراب نزف" },
  { key: "anticoagulants", label: "مميّعات الدم (وارفارين، أسبرين يومي، كلوبيدوقرل…)", risk: "high", alert: "على مميّعات دم" },
  { key: "bisphosphonates", label: "أدوية هشاشة العظام (بيسفوسفونات) — خطر عند الخلع والزراعة", risk: "high", alert: "بيسفوسفونات — حذر خلع/زراعة" },
  { key: "asthma", label: "الربو أو ضيق التنفس", risk: "medium", alert: "ربو" },
  { key: "epilepsy", label: "الصرع أو نوبات الإغماء", risk: "medium", alert: "صرع/إغماء" },
  { key: "kidney_disease", label: "أمراض الكلى أو الغسيل الكلوي", risk: "high", alert: "أمراض كلى" },
  { key: "liver_disease", label: "أمراض الكبد أو التهاب الكبد", risk: "high", alert: "أمراض كبد" },
  { key: "infectious", label: "مرض معدٍ (التهاب كبد B/C، إلخ)", risk: "high", alert: "مرض معدٍ" },
  { key: "thyroid", label: "الغدة الدرقية", risk: null },
  { key: "head_neck_radiation", label: "علاج إشعاعي للرأس أو الرقبة", risk: "high", alert: "إشعاع رأس/رقبة" },
  { key: "recent_surgery", label: "عملية أو تنويم في المستشفى خلال سنة", risk: null },
  { key: "pregnancy", label: "حامل حاليًّا", risk: "high", alert: "حامل" },
  { key: "breastfeeding", label: "مرضع", risk: "medium", alert: "مرضع" },
  { key: "smoking", label: "التدخين أو القات", risk: null },
];

export type Severity = "mild" | "moderate" | "severe";
export const SEVERITY_LABEL: Record<Severity, string> = { mild: "خفيفة", moderate: "متوسطة", severe: "شديدة" };

export interface Allergy { substance: string; reaction: string | null; severity: Severity }
export interface Medication { name: string; dose: string | null }

export const ASA_CLASSES = ["I", "II", "III", "IV", "V"] as const;
export type AsaClass = typeof ASA_CLASSES[number];
export const ASA_LABEL: Record<AsaClass, string> = {
  I: "I — سليم", II: "II — مرض جهازي خفيف", III: "III — مرض جهازي شديد",
  IV: "IV — مرض يهدد الحياة", V: "V — حالة حرجة",
};

export interface MedicalHistoryInput {
  answers: Record<string, Answer>;
  allergies: Allergy[];
  medications: Medication[];
  asaClass: AsaClass | null;
  bloodGroup: string | null;
  notes: string | null;
  /** المريض (أو وليّه) أكّد صحة الإجابات. */
  patientConfirmed: boolean;
}

const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

/** يطبّع ما جاء من الشاشة ويتحقق منه — رسالة عربية لأول خطأ. */
export function normalizeMedicalHistory(raw: unknown):
  | { ok: true; value: MedicalHistoryInput }
  | { ok: false; message: string } {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const answers: Record<string, Answer> = {};
  const rawAnswers = (input.answers && typeof input.answers === "object" ? input.answers : {}) as Record<string, unknown>;
  for (const question of HISTORY_QUESTIONS) {
    const value = rawAnswers[question.key];
    answers[question.key] = value === "yes" || value === "no" ? value : "unknown";
  }

  const allergies: Allergy[] = [];
  for (const row of Array.isArray(input.allergies) ? input.allergies : []) {
    const item = (row ?? {}) as Record<string, unknown>;
    const substance = text(item.substance, 80);
    if (!substance) continue;
    const severity = item.severity === "mild" || item.severity === "severe" ? item.severity : "moderate";
    allergies.push({ substance, reaction: text(item.reaction, 120), severity });
  }
  if (allergies.length > 30) return { ok: false, message: "قائمة الحساسية أطول من ٣٠." };

  const medications: Medication[] = [];
  for (const row of Array.isArray(input.medications) ? input.medications : []) {
    const item = (row ?? {}) as Record<string, unknown>;
    const name = text(item.name, 80);
    if (!name) continue;
    medications.push({ name, dose: text(item.dose, 60) });
  }
  if (medications.length > 40) return { ok: false, message: "قائمة الأدوية أطول من ٤٠." };

  const asa = input.asaClass;
  if (asa !== undefined && asa !== null && asa !== "" && !(ASA_CLASSES as readonly unknown[]).includes(asa)) {
    return { ok: false, message: "تصنيف ASA غير صالح." };
  }
  const blood = input.bloodGroup;
  if (blood !== undefined && blood !== null && blood !== "" && !(BLOOD_GROUPS as readonly unknown[]).includes(blood)) {
    return { ok: false, message: "فصيلة الدم غير صالحة." };
  }
  return {
    ok: true,
    value: {
      answers,
      allergies,
      medications,
      asaClass: asa ? (asa as AsaClass) : null,
      bloodGroup: blood ? String(blood) : null,
      notes: text(input.notes, 1000),
      patientConfirmed: input.patientConfirmed === true,
    },
  };
}

export interface DerivedAlert { label: string; severity: Risk }

/** تنبيهات آخر نسخة: كل حساسية (الشديدة أولًا)، وكل «نعم» على سؤالٍ خطِر، وASA III فأعلى. */
/** مفاتيح الأسئلة التي تُعدّ «نعم» فيها تنبيهًا — للمرشّح في قاعدة البيانات. */
export const ALERT_QUESTION_KEYS: string[] = HISTORY_QUESTIONS.filter((question) => question.risk && question.alert).map((question) => question.key);

export function deriveAlerts(history: Pick<MedicalHistoryInput, "answers" | "allergies" | "asaClass">): DerivedAlert[] {
  const alerts: DerivedAlert[] = [];
  const allergies = [...history.allergies].sort((a, b) => (a.severity === "severe" ? -1 : 0) - (b.severity === "severe" ? -1 : 0));
  for (const allergy of allergies) {
    alerts.push({ label: `حساسية ${allergy.substance}${allergy.severity === "severe" ? " (شديدة)" : ""}`, severity: allergy.severity === "mild" ? "medium" : "high" });
  }
  for (const question of HISTORY_QUESTIONS) {
    if (question.risk && question.alert && history.answers[question.key] === "yes") {
      alerts.push({ label: question.alert, severity: question.risk });
    }
  }
  if (history.asaClass && ["III", "IV", "V"].includes(history.asaClass)) {
    alerts.push({ label: `ASA ${history.asaClass}`, severity: "high" });
  }
  return alerts;
}

/** هل حان موعد مراجعة التاريخ الطبي؟ — بلا نسخة: نعم دائمًا. */
export function reviewDue(recordedAt: string | null, months: number, today: string): { due: boolean; months: number } {
  if (!recordedAt) return { due: true, months };
  const recorded = new Date(recordedAt);
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCMonth(limit.getUTCMonth() - Math.max(1, months));
  return { due: recorded < limit, months };
}

export interface VitalsInput {
  bpSystolic: number | null;
  bpDiastolic: number | null;
  pulse: number | null;
  temperature: number | null;
  spo2: number | null;
  glucose: number | null;
  weightKg: number | null;
}

const RANGES: Record<keyof VitalsInput, [number, number, string]> = {
  bpSystolic: [50, 300, "الضغط الانقباضي"],
  bpDiastolic: [30, 200, "الضغط الانبساطي"],
  pulse: [20, 250, "النبض"],
  temperature: [30, 45, "الحرارة"],
  spo2: [50, 100, "تشبّع الأكسجين"],
  glucose: [20, 800, "السكر"],
  weightKg: [1, 400, "الوزن"],
};

/** العلامات الحيوية: أرقام ضمن حدودٍ طبية معقولة، وقراءةٌ واحدة على الأقل. */
export function normalizeVitals(raw: unknown): { ok: true; value: VitalsInput } | { ok: false; message: string } {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const value = {} as VitalsInput;
  for (const [key, [min, max, label]] of Object.entries(RANGES) as [keyof VitalsInput, [number, number, string]][]) {
    const rawValue = input[key];
    if (rawValue === undefined || rawValue === null || rawValue === "") { value[key] = null; continue; }
    const number = Number(rawValue);
    if (!Number.isFinite(number) || number < min || number > max) return { ok: false, message: `${label} خارج الحدود المعقولة (${min}–${max}).` };
    value[key] = key === "temperature" || key === "weightKg" ? Math.round(number * 10) / 10 : Math.round(number);
  }
  if ((value.bpSystolic === null) !== (value.bpDiastolic === null)) return { ok: false, message: "اكتب الضغط كاملًا: الانقباضي والانبساطي." };
  if (value.bpSystolic !== null && value.bpDiastolic !== null && value.bpDiastolic >= value.bpSystolic) {
    return { ok: false, message: "الضغط الانبساطي يجب أن يكون أقل من الانقباضي." };
  }
  if (Object.values(value).every((item) => item === null)) return { ok: false, message: "سجّل قراءةً واحدة على الأقل." };
  return { ok: true, value };
}
