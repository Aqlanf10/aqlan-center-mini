/**
 * AQLAN AI Assistant — عقلان المساعد الذكي
 *
 * Strict architectural separation:
 * 1. Local Clinical Engine: 100% deterministic, in-clinic, zero external network calls.
 *    Audits record completeness, summarizes system-approved data per permissions,
 *    checks Case Presentation readiness, and provides verified orthodontic citations.
 *    Works fully even when external Gemini is disabled or offline.
 * 2. Zero-PHI Firewall for External Gemini Engine:
 *    External Gemini is DISABLED by default, restricted strictly to non-clinical
 *    educational references & administrative templates, and rejects ANY patient data,
 *    clinical notes, photos, radiographs, or de-identified patient records.
 */

import {
  computeOrthoWorkspaceCompleteness,
  type OrthoWorkspaceRecord,
} from "./ortho-workspace-types";
import {
  MIN_CEPH_CONFIRMED_LANDMARKS,
  computeBoltonAnalysis,
  computeMoyersAnalysis,
  computeTanakaJohnston,
} from "./ortho-scientific-analyses";

export const AQLAN_AI_BRAND = {
  ar: "عقلان — المساعد الذكي",
  en: "AQLAN AI Assistant",
  full: "AQLAN AI Assistant — عقلان المساعد الذكي",
} as const;

export const EXTERNAL_GEMINI_SETTING_KEY = "ortho.ai.external_gemini_enabled" as const;

export type LocalAssistantAction =
  | "audit_completeness"
  | "approved_summary"
  | "presentation_checklist"
  | "scientific_references";

export type ExternalAssistantIntent = "educational_literature" | "admin_template";

export interface LocalAssistantResponse {
  engine: "local_clinical";
  action: LocalAssistantAction;
  titleAr: string;
  disclaimerAr: string;
  itemsAr: string[];
  references?: Array<{ title: string; source: string; year: number; link: string }>;
}

export const VERIFIED_ORTHO_REFERENCES: ReadonlyArray<{
  title: string;
  source: string;
  year: number;
  link: string;
}> = [
  {
    title: "Contemporary Orthodontics (7th Edition)",
    source: "Proffit WR, Fields HW, Larson BE, Sarver DM — Elsevier",
    year: 2024,
    link: "https://www.elsevier.com/books/contemporary-orthodontics/proffit",
  },
  {
    title: "The Clinical Application of a Tooth-Size Analysis (Bolton Ratio)",
    source: "Bolton WA — American Journal of Orthodontics, 48(7):504–529",
    year: 1962,
    link: "https://doi.org/10.1016/0002-9416(62)90129-X",
  },
  {
    title: "Handbook of Orthodontics (4th Edition) — Mixed Dentition Probability Tables",
    source: "Moyers RE — Year Book Medical Publishers",
    year: 1988,
    link: "https://pubmed.ncbi.nlm.nih.gov/?term=Moyers+mixed+dentition+probability+table",
  },
  {
    title: "The Prediction of the Size of Unerupted Canines and Premolars in a Contemporary Orthodontic Population",
    source: "Tanaka MM, Johnston LE — JADA 88(4):798–801",
    year: 1974,
    link: "https://doi.org/10.14219/jada.archive.1974.0158",
  },
  {
    title: "The Limitations of Orthodontic Treatment: Mixed Dentition Diagnosis and Treatment (Leeway Space)",
    source: "Nance HN — American Journal of Orthodontics and Oral Surgery, 33(4):177–223",
    year: 1947,
    link: "https://doi.org/10.1016/0096-6347(47)90051-3",
  },
  {
    title: "Case Analysis and Treatment Planning Based Upon the Relationship of Tooth Material to Its Supporting Bone",
    source: "Howes AE — American Journal of Orthodontics and Oral Surgery, 33(8):499–533",
    year: 1947,
    link: "https://doi.org/10.1016/0096-6347(47)90212-3",
  },
];

const CLINICAL_DISCLAIMER_AR =
  "ملاحظة مهنية: «عقلان — المساعد الذكي» أداة تنظيم وتدقيق فقط ولا يصدر قرارات تشخيصية أو علاجية؛ القرار والاعتماد للطبيب المختص وحده.";

export function runLocalClinicalAssistant(
  action: LocalAssistantAction,
  record: OrthoWorkspaceRecord | null,
): LocalAssistantResponse {
  if (action === "scientific_references" || !record) {
    return {
      engine: "local_clinical",
      action: "scientific_references",
      titleAr: "المكتبة العلمية المرجعية المعتمدة (محليًا)",
      disclaimerAr: CLINICAL_DISCLAIMER_AR,
      itemsAr: VERIFIED_ORTHO_REFERENCES.map(
        (r) => `${r.title} — ${r.source} (${r.year})`,
      ),
      references: [...VERIFIED_ORTHO_REFERENCES],
    };
  }

  if (action === "audit_completeness") {
    const comp = computeOrthoWorkspaceCompleteness(record);
    const boltonAnt = computeBoltonAnalysis(record.clinicalExam.teeth, "anterior");
    const moyers = computeMoyersAnalysis({
      teeth: record.clinicalExam.teeth,
      dentitionStage: record.clinicalExam.dentitionStage,
      percentile: record.castInputs.moyersPercentile,
    });
    const tanaka = computeTanakaJohnston({
      teeth: record.clinicalExam.teeth,
      dentitionStage: record.clinicalExam.dentitionStage,
    });

    const itemsAr: string[] = [
      `نسبة اكتمال الملف التقويمي: ${comp.percent}% (${comp.completedCount}/${comp.totalCount} أقسام).`,
    ];
    if (comp.missingAr.length > 0) {
      itemsAr.push(`الأقسام الناقصة: ${comp.missingAr.join("، ")}.`);
    } else {
      itemsAr.push("جميع أقسام السجل التقويمي الأساسية مستوفاة.");
    }
    if (boltonAnt.status === "incomplete") {
      itemsAr.push(`تحليل بولتون الأمامي ينقصه قياس الأسنان FDI: ${boltonAnt.missingFdi.join("، ")}.`);
    }
    if (record.clinicalExam.dentitionStage === "mixed" && moyers.status === "incomplete") {
      itemsAr.push(`تحليل مويرز وتاناكا-جونستون ينقصهما قياس القواطع السفلية: ${moyers.missingFdi.join("، ")}.`);
    } else if (record.clinicalExam.dentitionStage === "mixed" && tanaka.status === "calculated") {
      itemsAr.push("مدخلات تحليلات الإطباق المختلط (مويرز / تاناكا-جونستون) مكتملة وجاهزة للاعتماد.");
    }
    if (!record.cbct.pixelSpacingMm) {
      itemsAr.push("تنبيه معايرة الأشعة: لم تُسجّل قيمة Pixel Spacing (mm/px) في تبويب الأشعة وCBCT.");
    }
    itemsAr.push(
      `ضابط السيفالومتري: يُشترط قبل الاعتماد معايرة مليمترية وحد أدنى ${MIN_CEPH_CONFIRMED_LANDMARKS} معلمًا تشريحيًا مؤكدًا من الطبيب.`,
    );

    return {
      engine: "local_clinical",
      action,
      titleAr: "تدقيق اكتمال السجل التقويمي (المحرك المحلي)",
      disclaimerAr: CLINICAL_DISCLAIMER_AR,
      itemsAr,
    };
  }

  if (action === "approved_summary") {
    const approvedProblems = record.problems.filter((p) => p.approved);
    const itemsAr: string[] = [
      `التحليلات المعتمدة: ${record.approvedAnalyses.length}`,
      ...record.approvedAnalyses.map((a) => `• ${a.titleAr}: ${a.summaryAr} (معتمد بواسطة ${a.approvedBy})`),
      `المشكلات المعتمدة: ${approvedProblems.length}`,
      ...approvedProblems.map((p) => `• [${p.severity}] ${p.titleAr}`),
      record.diagnosisSummary.approvedAt
        ? `التشخيص النهائي المعتمد (${record.diagnosisSummary.approvedBy}): ${record.diagnosisSummary.finalDiagnosisAr || "—"}`
        : "التشخيص النهائي لم يُعتمد من الطبيب بعد (لا تُعرض المسودات كتشخيص رسمي).",
      record.treatmentPlan.approvedAt
        ? `خطة العلاج المعتمدة (${record.treatmentPlan.approvedBy}): ${record.treatmentPlan.treatmentModality || "—"} — ${record.treatmentPlan.primaryGoals.join(" | ")}`
        : "خطة العلاج لم تُعتمد من الطبيب بعد.",
    ];
    return {
      engine: "local_clinical",
      action,
      titleAr: "ملخص السجلات والقياسات المعتمدة فقط",
      disclaimerAr: CLINICAL_DISCLAIMER_AR,
      itemsAr,
    };
  }

  // presentation_checklist
  const itemsAr: string[] = [
    `الشرائح المختارة للعرض: ${record.presentation.selectedSlideIds.length} شريحة.`,
    record.diagnosisSummary.approvedAt
      ? "✓ التشخيص النهائي معتمد وجاهز للإدراج في العرض."
      : "⚠️ التشخيص النهائي غير معتمد بعد؛ سيظهر تنبيه بعدم الاعتماد في شريحة التشخيص.",
    record.treatmentPlan.approvedAt
      ? "✓ خطة العلاج معتمدة وجاهزة للإدراج في العرض."
      : "⚠️ خطة العلاج غير معتمدة بعد؛ سيظهر تنبيه بعدم الاعتماد في شريحة الخطة.",
    record.approvedAnalyses.length > 0
      ? `✓ يوجد ${record.approvedAnalyses.length} تحليل قياسات معتمد.`
      : "⚠️ لا توجد تحليلات قياسات معتمدة بعد.",
    record.questionnaire.consentForEducationDeidentified
      ? `✓ موافقة المريض التعليمية مُوثَّقة بتاريخ ${record.questionnaire.consentSignedOn ?? "—"} (يُسمح بالتصدير مُخفى الهوية).`
      : "ℹ️ موافقة المريض التعليمية غير موثّقة بعد؛ يُمنع التصدير التعليمي مُخفى الهوية دون توثيق الموافقة.",
  ];
  return {
    engine: "local_clinical",
    action,
    titleAr: "فحص جاهزية عرض الحالة (Case Presentation)",
    disclaimerAr: CLINICAL_DISCLAIMER_AR,
    itemsAr,
  };
}

/* ─────────────────────────── Zero-PHI Firewall for External Gemini ─────────────────────────── */

const FORBIDDEN_EXTERNAL_KEYS = [
  "patientId",
  "patientName",
  "patientCode",
  "workspace",
  "record",
  "clinicalExam",
  "questionnaire",
  "photos",
  "radiographs",
  "images",
  "attachments",
  "base64",
  "clinicalNotes",
  "measurements",
  "ceph",
  "cbct",
] as const;

const PHI_AND_CLINICAL_PATTERNS: ReadonlyArray<{ pattern: RegExp; reasonAr: string }> = [
  { pattern: /data:image\/|;base64,/i, reasonAr: "يُمنع إرسال الصور أو الأشعة أو ملفات Base64 إلى محرك الذكاء الخارجي." },
  { pattern: /\b(?:\+?967|00967|07\d{8}|7[01378]\d{7})\b/, reasonAr: "يحتوي النص على رقم هاتف؛ يُمنع إرسال بيانات تواصل المرضى." },
  { pattern: /\bP-\d{2,}\b/i, reasonAr: "يحتوي النص على رقم ملف مريض؛ يُمنع إرسال معرفات المرضى." },
  {
    pattern: /(?:المريض|المريضة|ملف المريض|حالة المريض|تشخيص هذا|أشعة المريض|صورة المريض|تقرير المريض|سجل المريض)/,
    reasonAr: "يُمنع إرسال أي بيانات أو حالات أو ملاحظات مرضى إلى Gemini الخارجي (حتى بعد إزالة الأسماء).",
  },
  {
    pattern: /\b(?:my patient|this patient|patient's|patient case|patient file|diagnose this|recommend treatment for)\b/i,
    reasonAr: "External Gemini is strictly non-clinical; patient cases or clinical decision prompts are prohibited.",
  },
];

export function validateExternalGeminiPayload(rawBody: Record<string, unknown>):
  | { ok: true; intent: ExternalAssistantIntent; query: string }
  | { ok: false; reasonAr: string } {
  for (const key of FORBIDDEN_EXTERNAL_KEYS) {
    if (key in rawBody && rawBody[key] !== undefined && rawBody[key] !== null) {
      return {
        ok: false,
        reasonAr: `مرفوض أمنيًا: يُمنع إرفاق الحقل (${key}) مع محرك Gemini الخارجي.`,
      };
    }
  }

  const intent = rawBody.intent;
  if (intent !== "educational_literature" && intent !== "admin_template") {
    return {
      ok: false,
      reasonAr: "محرك Gemini الخارجي محصور بالبحث العلمي التعليمي العام أو تنظيم القوالب الإدارية فقط.",
    };
  }

  const query = typeof rawBody.query === "string" ? rawBody.query.trim() : "";
  if (query.length < 3 || query.length > 800) {
    return { ok: false, reasonAr: "يجب أن يكون الاستعلام بين 3 و 800 حرف." };
  }

  for (const rule of PHI_AND_CLINICAL_PATTERNS) {
    if (rule.pattern.test(query)) {
      return { ok: false, reasonAr: rule.reasonAr };
    }
  }

  return { ok: true, intent, query };
}
