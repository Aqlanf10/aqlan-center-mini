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

export interface VitalSigns {
  bpSystolic?: number | null;
  bpDiastolic?: number | null;
  pulse?: number | null;
  bloodSugar?: number | null; // mg/dL
  bloodGroup?: string | null; // e.g. "O+", "A+", etc.
  recordedAt?: string | null; // YYYY-MM-DD
}

export type BloodPressureCategory = "normal" | "elevated" | "stage1" | "stage2" | "crisis" | "unknown";

export interface BloodPressureRisk {
  category: BloodPressureCategory;
  label: string;
  severity: "low" | "medium" | "high" | "critical";
  color: "emerald" | "yellow" | "amber" | "rose" | "gray";
  clinicalNote: string;
}

export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] as const;

export function getBloodPressureRisk(
  systolic: number | null | undefined,
  diastolic: number | null | undefined,
): BloodPressureRisk {
  if (!systolic || !diastolic || systolic <= 0 || diastolic <= 0) {
    return {
      category: "unknown",
      label: "غير مسجّل",
      severity: "low",
      color: "gray",
      clinicalNote: "لم يتم قياس ضغط الدم بعد.",
    };
  }

  if (systolic >= 180 || diastolic >= 120) {
    return {
      category: "crisis",
      label: "أزمة فرط ضغط دم حادة (Crisis)",
      severity: "critical",
      color: "rose",
      clinicalNote: "طوارئ طبية! تجنب التخدير الموضعي المحتوي على الإبينفرين وحوّل المريض فورًا للاستقرار الطبي.",
    };
  }
  if (systolic >= 140 || diastolic >= 90) {
    return {
      category: "stage2",
      label: "ارتفاع ضغط دم - مرحلة 2",
      severity: "high",
      color: "rose",
      clinicalNote: "ضغط مرتفع بشكل ملحوظ. يجب الحذر، تقليل جرعات الأدرينالين وتجنب الإجراءات الجراحية المطولة.",
    };
  }
  if (systolic >= 130 || diastolic >= 80) {
    return {
      category: "stage1",
      label: "ارتفاع ضغط دم - مرحلة 1",
      severity: "medium",
      color: "amber",
      clinicalNote: "متابعة المريض أثناء العلاج والحرص على تقليل التوتر والراحة.",
    };
  }
  if (systolic >= 120 && diastolic < 80) {
    return {
      category: "elevated",
      label: "ضغط دم مرتفع طفيف",
      severity: "low",
      color: "yellow",
      clinicalNote: "قريب من المعدل الطبيعي ومناسب لجميع الإجراءات العلاجية.",
    };
  }
  return {
    category: "normal",
    label: "ضغط دم طبيعي ومثالي",
    severity: "low",
    color: "emerald",
    clinicalNote: "المؤشرات الحيوية طبيعية ومثالية لجميع العلاجات والتخدير.",
  };
}

/**
 * يحلل نص التنبيه الطبي ويستخرج العلامات الحيوية المنظمة إن وُجدت.
 */
export function parsePatientVitals(text: string | null | undefined): {
  vitals: VitalSigns | null;
  cleanAlert: string | null;
} {
  if (!text || !text.trim()) {
    return { vitals: null, cleanAlert: null };
  }

  const clean = text.trim();
  const vitalsTagMatch = clean.match(/\[(?:VITALS|علامات حيوية):\s*([^\]]+)\]/i);

  let bpSystolic: number | null = null;
  let bpDiastolic: number | null = null;
  let pulse: number | null = null;
  let bloodSugar: number | null = null;
  let bloodGroup: string | null = null;
  let recordedAt: string | null = null;
  let hasAny = false;

  if (vitalsTagMatch) {
    const payload = vitalsTagMatch[1];
    const bpMatch = payload.match(/(?:BP|ضغط)=?\s*(\d+)\s*\/\s*(\d+)/i);
    if (bpMatch) {
      bpSystolic = Number(bpMatch[1]);
      bpDiastolic = Number(bpMatch[2]);
      hasAny = true;
    }
    const hrMatch = payload.match(/(?:HR|PULSE|نبض)=?\s*(\d+)/i);
    if (hrMatch) {
      pulse = Number(hrMatch[1]);
      hasAny = true;
    }
    const bsMatch = payload.match(/(?:BS|GLUCOSE|سكر)=?\s*(\d+)/i);
    if (bsMatch) {
      bloodSugar = Number(bsMatch[1]);
      hasAny = true;
    }
    const bgMatch = payload.match(/(?:BG|فصيلة)=?\s*([ABO][+-]|AB[+-])/i);
    if (bgMatch) {
      bloodGroup = bgMatch[1].toUpperCase();
      hasAny = true;
    }
    const dateMatch = payload.match(/(?:DATE|تاريخ)=?\s*([\d-]+)/i);
    if (dateMatch) {
      recordedAt = dateMatch[1];
      hasAny = true;
    }

    const cleanAlert = clean.replace(vitalsTagMatch[0], "").trim();
    return {
      vitals: hasAny ? { bpSystolic, bpDiastolic, pulse, bloodSugar, bloodGroup, recordedAt } : null,
      cleanAlert: cleanAlert || null,
    };
  }

  // محاولة استخراج مرنة من النص الحر إن وُجدت صيغ مباشرة
  const freeBp = clean.match(/(?:ضغط|BP)[\s:=]*(\d{2,3})\s*[\/\\-]\s*(\d{2,3})/i);
  if (freeBp) {
    bpSystolic = Number(freeBp[1]);
    bpDiastolic = Number(freeBp[2]);
    hasAny = true;
  }
  const freePulse = clean.match(/(?:نبض|pulse|HR)[\s:=]*(\d{2,3})/i);
  if (freePulse) {
    pulse = Number(freePulse[1]);
    hasAny = true;
  }
  const freeBs = clean.match(/(?:سكر|glucose|blood sugar)[\s:=]*(\d{2,3})/i);
  if (freeBs) {
    bloodSugar = Number(freeBs[1]);
    hasAny = true;
  }
  const freeBg = clean.match(/(?:فصيلة\s*(?:الدم)?|blood\s*group)[\s:=]*([ABO][+-]|AB[+-])/i);
  if (freeBg) {
    bloodGroup = freeBg[1].toUpperCase();
    hasAny = true;
  }

  return {
    vitals: hasAny ? { bpSystolic, bpDiastolic, pulse, bloodSugar, bloodGroup, recordedAt } : null,
    cleanAlert: clean,
  };
}

/**
 * يحول العلامات الحيوية إلى وسم معياري آمن يدمج داخل التنبيه الطبي.
 */
export function serializeVitalsToAlert(vitals: VitalSigns | null | undefined, existingAlert?: string | null): string {
  const { cleanAlert } = parsePatientVitals(existingAlert);
  if (!vitals) return cleanAlert || "";

  const parts: string[] = [];
  if (vitals.bpSystolic && vitals.bpDiastolic) {
    parts.push(`BP=${vitals.bpSystolic}/${vitals.bpDiastolic}`);
  }
  if (vitals.pulse) {
    parts.push(`HR=${vitals.pulse}`);
  }
  if (vitals.bloodSugar) {
    parts.push(`BS=${vitals.bloodSugar}`);
  }
  if (vitals.bloodGroup) {
    parts.push(`BG=${vitals.bloodGroup.toUpperCase()}`);
  }
  if (vitals.recordedAt) {
    parts.push(`DATE=${vitals.recordedAt}`);
  }

  if (parts.length === 0) {
    return cleanAlert || "";
  }

  const tag = `[VITALS: ${parts.join(", ")}]`;
  return cleanAlert ? `${tag} ${cleanAlert}` : tag;
}

/**
 * يحلل نص التنبيه الطبي ويستخرج الشارات المعيارية والعلامات الحيوية مع أي ملاحظة مخصصة إضافية.
 */
export function parseMedicalAlerts(text: string | null | undefined): {
  badges: MedicalRiskAlert[];
  customNote: string | null;
  vitals: VitalSigns | null;
} {
  if (!text || !text.trim()) {
    return { badges: [], customNote: null, vitals: null };
  }
  const { vitals, cleanAlert } = parsePatientVitals(text);
  const clean = cleanAlert ?? text.trim();
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
    customNote: clean || null,
    vitals,
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
      medicalAlert: text(raw.medicalAlert, 800),
      note: text(raw.note, 2000),
    },
  };
}
