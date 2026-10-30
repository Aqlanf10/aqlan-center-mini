/**
 * محرك فحص التعارضات الدوائية والأمان السريري (Medication Safety & Contraindication Engine).
 *
 * يقارن الأدوية المدخلة في الروشتة مع السوابق المرضية وشارات الحساسية وحالة المريض (حمل، ضغط، سكري، كلى).
 * يمنع الأخطاء الطبية ويقترح البدائل الآمنة فوراً أثناء كتابة الوصفة.
 */

import { parseMedicalAlerts, type MedicalRiskAlert } from "./patient";
import type { MedicalHistoryInput } from "./medical-history";

export type SafetySeverity = "critical" | "warning" | "info";

export interface DrugSafetyAlert {
  id: string;
  medicationName: string;
  severity: SafetySeverity;
  title: string;
  message: string;
  contraindicatedRiskId: string;
  suggestedAlternative?: string;
}

export interface DrugInput {
  name: string;
  dose?: string;
  instructions?: string;
}

interface SafetyRule {
  id: string;
  riskId: string; // مطابق لمعرفات COMMON_MEDICAL_RISKS
  medKeywords: string[];
  severity: SafetySeverity;
  title: string;
  message: string;
  suggestedAlternative?: string;
}

const SAFETY_RULES: SafetyRule[] = [
  // 1. حساسية البنسلين ومشتقاته
  {
    id: "penicillin_allergy_contraindication",
    riskId: "allergy_penicillin",
    medKeywords: [
      "amoxicillin",
      "augmentin",
      "amox",
      "ampicillin",
      "penicillin",
      "بنسلين",
      "اموكسيسيلين",
      "أوغمنتين",
      "اوغمنتين",
      "كلافوكس",
      "klavox",
      "curam",
      "مومينتوم",
    ],
    severity: "critical",
    title: "خطر تحسسي حرج (Penicillin Allergy)",
    message: "المريض يعاني من حساسية بنسلين مؤكدة! صرف مشتقات البنسلين قد يسبب صدمة حساسية مهددة للحياة (Anaphylaxis).",
    suggestedAlternative: "البديل الآمن المعتمد: Clindamycin 300mg أو Azithromycin 500mg.",
  },

  // 2. الحمل ومضادات الالتهاب غير الستيرويدية (NSAIDs)
  {
    id: "pregnancy_nsaid_contraindication",
    riskId: "pregnancy",
    medKeywords: [
      "ibuprofen",
      "brufen",
      "diclofenac",
      "voltaren",
      "cataflam",
      "ketoprofen",
      "naproxen",
      "بروفين",
      "فولتارين",
      "كتافلام",
      "ديكلوفيناك",
      "نابروكسين",
      "أولفين",
      "profenid",
    ],
    severity: "critical",
    title: "محظور أثناء الحمل (NSAIDs in Pregnancy)",
    message: "تمنع مسكنات ومضادات الالتهاب غير الستيرويدية (NSAIDs) أثناء الحمل لخطرها على الدورة الدموية للجنين وانغلاق القناة الشريانية المبكر.",
    suggestedAlternative: "المسكن الآمن المعتمد للحوامل: Paracetamol (Panadol) 500mg - 1g.",
  },

  // 3. الحمل والمترونيدازول
  {
    id: "pregnancy_metronidazole_warning",
    riskId: "pregnancy",
    medKeywords: ["metronidazole", "flagyl", "فلاجيل", "مترونيدازول"],
    severity: "warning",
    title: "تنبيه سريري للحامل (Metronidazole)",
    message: "يُفضل تجنب المترونيدازول خصوصاً في الثلث الأول من الحمل إلا للضرورة السريرية القصوى وتحت إشراف طبي مشترك.",
    suggestedAlternative: "الاستعاضة بعلاج موضعي أو استشارة طبيب النساء والتوليد المشرف.",
  },

  // 4. سيولة الدم والأسبرين / مميعات الدم مع مسكنات NSAIDs
  {
    id: "bleeding_nsaid_warning",
    riskId: "bleeding_disorder",
    medKeywords: [
      "ibuprofen",
      "brufen",
      "diclofenac",
      "voltaren",
      "cataflam",
      "aspirin",
      "أسبرين",
      "اسبرين",
      "بروفين",
      "فولتارين",
      "كتافلام",
    ],
    severity: "warning",
    title: "مخاطر نزف دوائي (Bleeding Risk)",
    message: "المريض يتناول مميعات دم أو يعاني من سيولة؛ أدوية NSAIDs تثبط الصفائح الدموية وتزيد مخاطر النزيف الهضمي وبعد الجراحة السنية.",
    suggestedAlternative: "استخدم مسكناً لطيفاً على التخثر والمعدة: Paracetamol 500mg.",
  },

  // 5. مرضى الربو التحسسي ومسكنات NSAIDs (Aspirin-induced Asthma)
  {
    id: "asthma_nsaid_warning",
    riskId: "asthma",
    medKeywords: [
      "aspirin",
      "ibuprofen",
      "brufen",
      "diclofenac",
      "voltaren",
      "cataflam",
      "أسبرين",
      "بروفين",
      "فولتارين",
      "كتافلام",
    ],
    severity: "warning",
    title: "حساسية ربو صامتة (Aspirin/NSAID Induced Asthma)",
    message: "قد تسبب مسكنات NSAIDs أزمة تشنج قصبي حادة لمرضى الربو (تصل إلى 10% من الحالات).",
    suggestedAlternative: "البديل الأكثر أماناً للجهاز التنفسي: Paracetamol.",
  },

  // 6. مرضى الفشل الكلوي والكبد
  {
    id: "kidney_nsaid_warning",
    riskId: "kidney_liver",
    medKeywords: [
      "ibuprofen",
      "brufen",
      "diclofenac",
      "voltaren",
      "cataflam",
      "بروفين",
      "فولتارين",
      "كتافلام",
    ],
    severity: "warning",
    title: "قصور كلوي / كبدي (Renal/Hepatic Caution)",
    message: "تجنب مسكنات NSAIDs لمرضى القصور الكلوي لتقليل ترشيح الكبيبات الكلوية وارتفاع ضغط الدم.",
    suggestedAlternative: "استشر الطبيب الباطني أو استخدم الباراسيتامول بجرعات مضبوطة.",
  },
];

const ANTICOAGULANT_KEYWORDS = [
  "warfarin",
  "coumadin",
  "aspirin",
  "clopidogrel",
  "plavix",
  "rivaroxaban",
  "xarelto",
  "apixaban",
  "eliquis",
  "dabigatran",
  "heparin",
  "وارفارين",
  "كومادين",
  "أسبرين",
  "اسبرين",
  "كلوبيدوقرل",
  "بلافيكس",
  "مميع",
];

const PENICILLIN_SUBSTANCE_KEYWORDS = [
  "penicillin",
  "amoxicillin",
  "augmentin",
  "ampicillin",
  "amox",
  "بنسلين",
  "بنسيلين",
  "أموكسيسيلين",
  "اموكسيسيلين",
  "أوغمنتين",
  "اوغمنتين",
];

const BREASTFEEDING_NSAID_OR_METRO_KEYWORDS = [
  "aspirin",
  "أسبرين",
  "اسبرين",
  "metronidazole",
  "flagyl",
  "فلاجيل",
  "مترونيدازول",
  "doxycycline",
  "tetracycline",
  "ciprofloxacin",
  "دوكسيسيكلين",
  "تتراسيكلين",
  "سيبروفلوكساسين",
];

export type StructuredMedicalSafetyContext = Partial<
  Pick<MedicalHistoryInput, "answers" | "allergies" | "medications" | "asaClass" | "notes">
> | null | undefined;

/**
 * يفحص قائمة الأدوية المكتوبة في الوصفة الطبية ويقارنها مع التنبيهات النصية
 * والتاريخ الطبي المهيكل للمريض (الحساسيات، الحمل، الإرضاع، السيولة، الربو، الكلى/الكبد، والأدوية الحالية).
 */
export function evaluatePrescriptionSafety(
  medications: DrugInput[],
  medicalAlertText: string | null | undefined,
  structuredHistory?: StructuredMedicalSafetyContext,
): DrugSafetyAlert[] {
  if (!medications || medications.length === 0) return [];

  const combinedTextParts: string[] = [];
  if (medicalAlertText && medicalAlertText.trim()) combinedTextParts.push(medicalAlertText.trim());
  if (structuredHistory?.notes && structuredHistory.notes.trim()) combinedTextParts.push(structuredHistory.notes.trim());

  const { badges } = parseMedicalAlerts(combinedTextParts.join(" — ") || null);
  const activeRiskIds = new Set(badges.map((b) => b.id));

  const answers = structuredHistory?.answers ?? {};
  if (answers.pregnancy === "yes") activeRiskIds.add("pregnancy");
  if (answers.bleeding_disorder === "yes" || answers.anticoagulants === "yes") activeRiskIds.add("bleeding_disorder");
  if (answers.asthma === "yes") activeRiskIds.add("asthma");
  if (answers.kidney_disease === "yes" || answers.liver_disease === "yes") activeRiskIds.add("kidney_liver");

  const currentMeds = structuredHistory?.medications ?? [];
  for (const current of currentMeds) {
    const nameLower = (current.name ?? "").toLowerCase();
    if (ANTICOAGULANT_KEYWORDS.some((kw) => nameLower.includes(kw))) {
      activeRiskIds.add("bleeding_disorder");
    }
  }

  const structuredAllergies = structuredHistory?.allergies ?? [];
  for (const allergy of structuredAllergies) {
    const subLower = (allergy.substance ?? "").toLowerCase().trim();
    if (!subLower) continue;
    if (PENICILLIN_SUBSTANCE_KEYWORDS.some((kw) => subLower.includes(kw))) {
      activeRiskIds.add("allergy_penicillin");
    }
  }

  const isBreastfeeding = answers.breastfeeding === "yes";
  if (activeRiskIds.size === 0 && structuredAllergies.length === 0 && !isBreastfeeding) return [];

  const alerts: DrugSafetyAlert[] = [];
  const seenIds = new Set<string>();

  for (const med of medications) {
    if (!med.name || !med.name.trim()) continue;
    const medLower = med.name.toLowerCase().trim();

    for (const rule of SAFETY_RULES) {
      if (activeRiskIds.has(rule.riskId)) {
        const matchesMed = rule.medKeywords.some((kw) => medLower.includes(kw.toLowerCase()));
        const alertId = `${rule.id}_${med.name}`;
        if (matchesMed && !seenIds.has(alertId)) {
          seenIds.add(alertId);
          alerts.push({
            id: alertId,
            medicationName: med.name,
            severity: rule.severity,
            title: rule.title,
            message: rule.message,
            contraindicatedRiskId: rule.riskId,
            suggestedAlternative: rule.suggestedAlternative,
          });
        }
      }
    }

    // فحص مباشر لأي مادة حساسية مهيكلة أخرى مسجلة في التاريخ الطبي (مثل Clindamycin / Sulfa / Ibuprofen)
    for (const allergy of structuredAllergies) {
      const substanceRaw = (allergy.substance ?? "").trim();
      const substanceLower = substanceRaw.toLowerCase();
      if (substanceLower.length < 3) continue;
      if (PENICILLIN_SUBSTANCE_KEYWORDS.some((kw) => substanceLower.includes(kw))) continue;
      if (medLower.includes(substanceLower) || substanceLower.includes(medLower)) {
        const alertId = `structured_allergy_${substanceLower}_${med.name}`;
        if (!seenIds.has(alertId)) {
          seenIds.add(alertId);
          alerts.push({
            id: alertId,
            medicationName: med.name,
            severity: "critical",
            title: `خطر تحسسي مسجل (${substanceRaw})`,
            message: `التاريخ الطبي للمريض يوثّق حساسية تجاه «${substanceRaw}»${allergy.reaction ? ` (${allergy.reaction})` : ""}. يُمنع صرف هذا الدواء لتفادي تفاعل تحسسي خطير.`,
            contraindicatedRiskId: "structured_allergy",
          });
        }
      }
    }

    if (isBreastfeeding && BREASTFEEDING_NSAID_OR_METRO_KEYWORDS.some((kw) => medLower.includes(kw.toLowerCase()))) {
      const alertId = `breastfeeding_caution_${med.name}`;
      if (!seenIds.has(alertId)) {
        seenIds.add(alertId);
        alerts.push({
          id: alertId,
          medicationName: med.name,
          severity: "warning",
          title: "تنبيه سريري للمرضع (Breastfeeding Caution)",
          message: "المريضة مرضع حسب التاريخ الطبي المسجل؛ بعض المضادات والمسكنات تعبر لحليب الأم وتستلزم بديلاً آمناً أو ضبط التوقيت.",
          contraindicatedRiskId: "breastfeeding",
          suggestedAlternative: "المسكن الآمن المفضل أثناء الإرضاع: Paracetamol أو Ibuprofen قصير الأمد.",
        });
      }
    }
  }

  // ترتيب التحذيرات: الحرج أولاً
  return alerts.sort((a, b) => {
    const score = (s: SafetySeverity) => (s === "critical" ? 3 : s === "warning" ? 2 : 1);
    return score(b.severity) - score(a.severity);
  });
}
