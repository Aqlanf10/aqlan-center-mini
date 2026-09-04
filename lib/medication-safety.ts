/**
 * محرك فحص التعارضات الدوائية والأمان السريري (Medication Safety & Contraindication Engine).
 *
 * يقارن الأدوية المدخلة في الروشتة مع السوابق المرضية وشارات الحساسية وحالة المريض (حمل، ضغط، سكري، كلى).
 * يمنع الأخطاء الطبية ويقترح البدائل الآمنة فوراً أثناء كتابة الوصفة.
 */

import { parseMedicalAlerts, type MedicalRiskAlert } from "./patient";

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

/**
 * يفحص قائمة الأدوية المكتوبة في الوصفة الطبية ويقارنها مع سجل وسوابق المريض الطبية.
 */
export function evaluatePrescriptionSafety(
  medications: DrugInput[],
  medicalAlertText: string | null | undefined,
): DrugSafetyAlert[] {
  if (!medications || medications.length === 0) return [];

  const { badges } = parseMedicalAlerts(medicalAlertText);
  if (badges.length === 0) return [];

  const activeRiskIds = new Set(badges.map((b) => b.id));
  const alerts: DrugSafetyAlert[] = [];

  for (const med of medications) {
    if (!med.name || !med.name.trim()) continue;
    const medLower = med.name.toLowerCase().trim();

    for (const rule of SAFETY_RULES) {
      if (activeRiskIds.has(rule.riskId)) {
        const matchesMed = rule.medKeywords.some((kw) => medLower.includes(kw.toLowerCase()));
        if (matchesMed) {
          alerts.push({
            id: `${rule.id}_${med.name}`,
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
  }

  // ترتيب التحذيرات: الحرج أولاً
  return alerts.sort((a, b) => {
    const score = (s: SafetySeverity) => (s === "critical" ? 3 : s === "warning" ? 2 : 1);
    return score(b.severity) - score(a.severity);
  });
}
