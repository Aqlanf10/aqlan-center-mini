/**
 * بيانات المريض — المنطق الخالص.
 *
 * وحدة المرضى صارت العمود الفقري: الموعد والزيارة والمختبر والفاتورة كلها تشير إلى
 * سجل مريض. وسجلٌّ ناقص أو مكرّر يُفسد كل ما بُني عليه — رصيدٌ موزّع على سجلّين،
 * وتاريخ علاج مقسوم نصفين، ومريض يُستدعى مرتين.
 *
 * لذلك القاعدتان هنا: **الرقم يُوحَّد** ليمنع التكرار، و**التنبيه الطبي يُقرأ قبل
 * الإجراء** لا بعده.
 */

export type Gender = "male" | "female" | "unknown";

export const GENDER_LABEL: Record<Gender, string> = {
  male: "ذكر",
  female: "أنثى",
  unknown: "غير محدد",
};

export interface Patient {
  id: number;
  patientNumber: string;
  fullName: string;
  phone: string | null;
  altPhone: string | null;
  gender: Gender;
  birthYear: number | null;
  address: string | null;
  /** تنبيه يظهر بالأحمر في كل شاشة تخصّ المريض: حساسية، سكري، مميعات دم. */
  medicalAlert: string | null;
  note: string | null;
  createdAt: string;
}

export interface MedicalRiskAlert {
  id: string;
  label: string;
  category: "allergy" | "chronic" | "condition";
  icon: string;
  severity: "high" | "medium";
  keywords: string[];
}

export const COMMON_MEDICAL_RISKS: MedicalRiskAlert[] = [
  { id: "allergy_penicillin", label: "حساسية بنسلين", category: "allergy", icon: "💊", severity: "high", keywords: ["بنسلين", "بنسلينات", "penicillin", "amox"] },
  { id: "allergy_latex", label: "حساسية لاتكس", category: "allergy", icon: "🧤", severity: "medium", keywords: ["لاتكس", "latex", "قفاز"] },
  { id: "bleeding_disorder", label: "سيولة دم / أسبرين", category: "chronic", icon: "🩸", severity: "high", keywords: ["سيولة", "اسبرين", "أسبرين", "وارفارين", "بلاRun", "plavix", "bleeding", "مميع"] },
  { id: "diabetes", label: "داء السكري", category: "chronic", icon: "💉", severity: "medium", keywords: ["سكر", "سكري", "diabetes", "انسولين", "أنسولين"] },
  { id: "hypertension", label: "ارتفاع ضغط الدم", category: "chronic", icon: "❤️", severity: "medium", keywords: ["ضغط", "hypertension", "ضغط الدم"] },
  { id: "cardiac", label: "أمراض قلب / صمامات", category: "chronic", icon: "🫀", severity: "high", keywords: ["قلب", "صمام", "قسطرة", "دعامات", "cardiac", "heart"] },
  { id: "pregnancy", label: "حامل", category: "condition", icon: "🤰", severity: "high", keywords: ["حامل", "حمل", "pregnant", "pregnancy"] },
  { id: "kidney_liver", label: "أمراض كلى / كبد", category: "chronic", icon: "⚠️", severity: "high", keywords: ["كلى", "كبد", "غسيل", "فشل كلوي", "تليف", "renal", "hepatic"] },
  { id: "asthma", label: "ربو تحسسي", category: "chronic", icon: "🫁", severity: "medium", keywords: ["ربو", "asthma", "حساسية صدر"] },
];

/**
 * يحلل نص التنبيه الطبي ويستخرج الشارات المعيارية مع أي ملاحظة مخصصة إضافية.
 */
export function parseMedicalAlerts(text: string | null | undefined): {
  badges: MedicalRiskAlert[];
  customNote: string | null;
} {
  if (!text || !text.trim()) {
    return { badges: [], customNote: null };
  }
  const clean = text.trim();
  const lower = clean.toLowerCase();
  const matchedBadges: MedicalRiskAlert[] = [];

  for (const risk of COMMON_MEDICAL_RISKS) {
    const hasKeyword = risk.keywords.some((kw) => lower.includes(kw.toLowerCase()));
    if (hasKeyword) {
      matchedBadges.push(risk);
    }
  }

  return {
    badges: matchedBadges,
    customNote: clean,
  };
}

export type PatientInput = Omit<Patient, "id" | "patientNumber" | "createdAt">;

/** أصغر وأكبر سنة ميلاد مقبولة — تمنع «1092» و«2126» من الدخول بخطأ مطبعي. */
export const MIN_BIRTH_YEAR = 1900;

export function ageFromBirthYear(birthYear: number | null, today: string): number | null {
  if (!birthYear) return null;
  const year = Number(today.slice(0, 4));
  if (!Number.isFinite(year)) return null;
  const age = year - birthYear;
  return age >= 0 && age < 130 ? age : null;
}

/** «34 سنة» / «سنة واحدة» / «سنتان» — العربية تعدّ على صيغ لا على واحدة. */
export function ageText(age: number | null): string {
  if (age === null) return "العمر غير مسجّل";
  if (age === 0) return "أقل من سنة";
  if (age === 1) return "سنة واحدة";
  if (age === 2) return "سنتان";
  if (age <= 10) return `${age} سنوات`;
  return `${age} سنة`;
}

export type PatientValidation =
  | { ok: true; value: PatientInput }
  | { ok: false; message: string; field: string };

/**
 * يتحقق من بيانات المريض ويسمّي الحقل الخاطئ.
 *
 * تسمية الحقل ليست تجميلًا: النموذج فيه ثمانية حقول، و«بيانات غير صالحة» وحدها تترك
 * الاستقبال تفتّش فيها والمريض واقف أمامها.
 */
export function validatePatient(raw: Record<string, unknown>, today: string): PatientValidation {
  const fullName = typeof raw.fullName === "string" ? raw.fullName.trim().replace(/\s+/g, " ") : "";
  if (fullName.length < 2 || fullName.length > 120) {
    return { ok: false, message: "اكتب اسم المريض.", field: "fullName" };
  }
  if (!/[؀-ۿA-Za-z]/.test(fullName)) {
    return { ok: false, message: "اكتب الاسم بالحروف.", field: "fullName" };
  }

  const readPhone = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, 40) : null;

  const gender: Gender =
    raw.gender === "male" || raw.gender === "female" ? raw.gender : "unknown";

  let birthYear: number | null = null;
  if (raw.birthYear !== undefined && raw.birthYear !== null && String(raw.birthYear).trim() !== "") {
    const parsed = Number(String(raw.birthYear).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)));
    const thisYear = Number(today.slice(0, 4));
    if (!Number.isInteger(parsed) || parsed < MIN_BIRTH_YEAR || parsed > thisYear) {
      return { ok: false, message: `سنة الميلاد بين ${MIN_BIRTH_YEAR} و${thisYear}.`, field: "birthYear" };
    }
    birthYear = parsed;
  }

  const text = (value: unknown, max: number) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

  return {
    ok: true,
    value: {
      fullName,
      phone: readPhone(raw.phone),
      altPhone: readPhone(raw.altPhone),
      gender,
      birthYear,
      address: text(raw.address, 200),
      medicalAlert: text(raw.medicalAlert, 300),
      note: text(raw.note, 2000),
    },
  };
}
