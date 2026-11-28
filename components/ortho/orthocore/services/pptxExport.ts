"use client";

import type { ClinicSettings, Language, MediaRecord, PatientCase } from "../types/ortho";
import {
  renderCephalometricTracingImage,
  renderPhotoAnalysisImage,
} from "./canvasTracingRenderer";

export interface PresentationSlideConfig {
  id: string;
  labelAr: string;
  labelEn: string;
  enabled: boolean;
}

export const DEFAULT_SLIDES: PresentationSlideConfig[] = [
  { id: "cover", labelAr: "1. الغلاف وبيانات الحالة والطبيب", labelEn: "1. Clinical Conference Cover", enabled: true },
  { id: "case_history", labelAr: "2. الاستبيان والتاريخ الطبي (I. Interview)", labelEn: "2. I. Interview / Questionnaire", enabled: true },
  { id: "t0_montage", labelAr: "3. مجمع السجلات الأولية (T0 8-Photo Montage)", labelEn: "3. Diagnostic Records Montage (T0)", enabled: true },
  { id: "facial_photos", labelAr: "4. الفحص خارج الفم — النظرة العامة", labelEn: "4. II. Extraoral Overview (3 Photos)", enabled: true },
  { id: "extraoral_profile", labelAr: "5. تحليل البروفايل الجانبي بالرسم", labelEn: "5. II. Profile Analysis (Traced)", enabled: true },
  { id: "extraoral_smile", labelAr: "6. تحليل الابتسامة والخطوط الوسطى", labelEn: "6. II. Smile & Midline Assessment", enabled: true },
  { id: "extraoral_fifths", labelAr: "7. الأخماس العرضية للوجه (Rule of Fifths)", labelEn: "7. II. Transverse Rule of Fifths", enabled: true },
  { id: "extraoral_thirds", labelAr: "8. الأثلاث العمودية للوجه (Vertical Thirds)", labelEn: "8. II. Vertical Facial Thirds", enabled: true },
  { id: "intraoral_photos", labelAr: "9. مجمع الصور داخل الفم (5-Photo Montage)", labelEn: "9. II. Intraoral Photos Montage", enabled: true },
  { id: "intraoral_occlusal", labelAr: "10. تحليل الأقواس الإطباقية وشكل القوس", labelEn: "10. II. Occlusal & Arch Evaluation", enabled: true },
  { id: "intraoral_buccal", labelAr: "11. علاقات الأنياب والأرحاء والإطباق", labelEn: "11. II. Buccal & Frontal Occlusion", enabled: true },
  { id: "radiographs_opg", labelAr: "12. أشعة البانوراما (OPG) ومخطط FDI", labelEn: "12. Panoramic X-Ray (OPG) & FDI Chart", enabled: true },
  { id: "radiographs_ceph", labelAr: "13. السيفالومتري الجانبي والتتبع (Tracing)", labelEn: "13. Lateral Ceph X-Ray & Traced Overlay", enabled: true },
  { id: "measurements", labelAr: "14. جدول تحليل السيفالومتري (ABO Table)", labelEn: "14. ABO / Cephalometric Analysis Table", enabled: true },
  { id: "cast_analysis", labelAr: "15. تحليل النماذج (Cast / 3D Analysis Table)", labelEn: "15. Cast / 3D Model Analysis Table", enabled: true },
  { id: "bolton_analysis", labelAr: "16. تحليل بولتون (Bolton's Grid & Formula)", labelEn: "16. Bolton's Analysis Grid & Formula", enabled: true },
  { id: "problem_diagnosis", labelAr: "17. التشخيص النهائي وقائمة المشكلات", labelEn: "17. Diagnosis & Approved Problem List", enabled: true },
  { id: "treatment_objectives", labelAr: "18. أهداف العلاج (Treatment Objectives)", labelEn: "18. Treatment Objectives", enabled: true },
  { id: "treatment_plan", labelAr: "19. مصفوفة خطة العلاج (Problem / Plan / Strategies)", labelEn: "19. Treatment Plan Matrix", enabled: true },
  { id: "mechanotherapy", labelAr: "20. الميكانيكا وتتابع الأسلاك (Mechanotherapy)", labelEn: "20. Mechanotherapy Protocol", enabled: true },
  { id: "retention", labelAr: "21. بروتوكول التثبيت والمتابعة (Retention)", labelEn: "21. Retention Protocol", enabled: true },
  { id: "sessions_timeline", labelAr: "22. شرائح متابعة الشدّات بالصور (شريحة لكل شدّة)", labelEn: "22. Adjustment Progress Slides (Per Visit)", enabled: true },
  { id: "before_after", labelAr: "23. مقارنة التطور (قبل وبعد) والخاتمة", labelEn: "23. Progress Comparison & Closing", enabled: true },
];

function findMediaForAnalysis(
  patient: PatientCase,
  linkedMediaId: string | undefined,
  fallbackViews: string[],
): MediaRecord | undefined {
  if (linkedMediaId) {
    const exact = patient.media.find((m) => m.id === linkedMediaId);
    if (exact) return exact;
  }
  for (const v of fallbackViews) {
    const found = patient.media.find(
      (m) =>
        m.viewType.toLowerCase() === v.toLowerCase() ||
        m.viewType.toLowerCase().includes(v.toLowerCase()),
    );
    if (found) return found;
  }
  return undefined;
}

async function buildClientTracedOverlays(
  patient: PatientCase,
  lang: Language,
  anonymize: boolean,
): Promise<Record<string, string>> {
  const overlays: Record<string, string> = {};
  if (typeof document === "undefined") return overlays;
  const cache = new Map<string, string | null>();
  const isAr = lang === "ar";

  // 1. Cephalometric Traced Overlay
  try {
    const cephAnalysis = patient.analyses.find(
      (a) => a.analysisType === "cephalometric" && Object.keys(a.landmarks || {}).length > 0,
    );
    if (cephAnalysis) {
      const cephMedia = findMediaForAnalysis(patient, cephAnalysis.linkedMediaId, [
        "lateral_ceph",
        "ceph",
      ]);
      const dataUrl = await renderCephalometricTracingImage(cephMedia, cephAnalysis, cache, isAr);
      if (dataUrl) overlays.ceph = dataUrl;
    }
  } catch {
    // Non-blocking
  }

  // 2. Profile Traced Overlay
  try {
    const profileAnalysis = patient.analyses.find(
      (a) =>
        a.analysisType === "photo_analysis" &&
        a.photoViewMode === "profile" &&
        Object.keys(a.landmarks || {}).length > 0,
    );
    if (profileAnalysis) {
      const media = findMediaForAnalysis(patient, profileAnalysis.linkedMediaId, [
        "extraoral_profile",
        "profile",
      ]);
      const dataUrl = await renderPhotoAnalysisImage(media, "profile", profileAnalysis, cache, {
        anonymize,
      });
      if (dataUrl) overlays.profile = dataUrl;
    }
  } catch {
    // ignore
  }

  // 3. Smile Traced Overlay
  try {
    const smileAnalysis = patient.analyses.find(
      (a) =>
        a.analysisType === "photo_analysis" &&
        a.photoViewMode === "smile" &&
        Object.keys(a.landmarks || {}).length > 0,
    );
    if (smileAnalysis) {
      const media = findMediaForAnalysis(patient, smileAnalysis.linkedMediaId, [
        "extraoral_smile",
        "extraoral_frontal_smile",
        "smile",
      ]);
      const dataUrl = await renderPhotoAnalysisImage(media, "smile", smileAnalysis, cache, {
        anonymize,
      });
      if (dataUrl) overlays.smile = dataUrl;
    }
  } catch {
    // ignore
  }

  // 4. Frontal Rule of Fifths & Vertical Thirds Overlays
  try {
    const frontalAnalysis = patient.analyses.find(
      (a) =>
        a.analysisType === "photo_analysis" &&
        a.photoViewMode === "frontal" &&
        Object.keys(a.landmarks || {}).length > 0,
    );
    if (frontalAnalysis) {
      const media = findMediaForAnalysis(patient, frontalAnalysis.linkedMediaId, [
        "extraoral_frontal",
        "extraoral_frontal_rest",
        "frontal_rest",
      ]);
      const fifthsUrl = await renderPhotoAnalysisImage(media, "frontal", frontalAnalysis, cache, {
        anonymize,
        frontalVariant: "fifths",
      });
      if (fifthsUrl) overlays.fifths = fifthsUrl;

      const thirdsUrl = await renderPhotoAnalysisImage(media, "frontal", frontalAnalysis, cache, {
        anonymize,
        frontalVariant: "thirds",
      });
      if (thirdsUrl) overlays.thirds = thirdsUrl;
    }
  } catch {
    // ignore
  }

  // 5. Intraoral Traced Overlays (Frontal, Right, Left, Upper Occlusal, Lower Occlusal)
  const intraModes: Array<{
    mode: "intraoral_frontal" | "intraoral_right" | "intraoral_left" | "intraoral_upper" | "intraoral_lower";
    key: string;
    views: string[];
  }> = [
    { mode: "intraoral_frontal", key: "intraoral", views: ["intraoral_frontal"] },
    { mode: "intraoral_right", key: "intraoral_right", views: ["intraoral_right", "right_buccal"] },
    { mode: "intraoral_left", key: "intraoral_left", views: ["intraoral_left", "left_buccal"] },
    { mode: "intraoral_upper", key: "intraoral_upper", views: ["intraoral_upper", "upper_occlusal"] },
    { mode: "intraoral_lower", key: "intraoral_lower", views: ["intraoral_lower", "lower_occlusal"] },
  ];

  for (const item of intraModes) {
    try {
      const analysis = patient.analyses.find(
        (a) =>
          a.analysisType === "photo_analysis" &&
          a.photoViewMode === item.mode &&
          Object.keys(a.landmarks || {}).length > 0,
      );
      if (analysis) {
        const media = findMediaForAnalysis(patient, analysis.linkedMediaId, item.views);
        const dataUrl = await renderPhotoAnalysisImage(media, item.mode, analysis, cache, {
          anonymize: false,
        });
        if (dataUrl) overlays[item.key] = dataUrl;
      }
    } catch {
      // ignore
    }
  }

  return overlays;
}

export async function exportCaseToPowerPoint(opts: {
  patient: PatientCase;
  settings: ClinicSettings;
  lang: Language;
  slides: PresentationSlideConfig[];
  anonymize?: boolean;
  excludeInternalNotes?: boolean;
  selectedMediaIds?: string[];
  orthoCaseId: number | null;
}): Promise<void> {
  const numericId = Number(String(opts.patient.id).replace(/\D/g, "")) || 0;
  if (numericId <= 0) {
    throw new Error("معرّف المريض غير صالح لتصدير العرض التقديمي.");
  }

  const selectedSlideIds = opts.slides.filter((s) => s.enabled).map((s) => s.id);
  const tracedOverlays = opts.selectedMediaIds === undefined ? await buildClientTracedOverlays(
    opts.patient,
    opts.lang,
    opts.anonymize === true,
  ) : undefined;

  const res = await fetch(`/api/ortho/presentation/${numericId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      format: "pptx",
      orthoCaseId: opts.orthoCaseId,
      anonymize: opts.anonymize === true,
      lang: opts.lang,
      selectedSlideIds,
      selectedMediaIds: opts.selectedMediaIds,
      tracedOverlays,
    }),
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message || "تعذّر تصدير ملف PowerPoint (.pptx).");
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = opts.anonymize
    ? `AQLAN-Ortho-Case-EDU.pptx`
    : `AQLAN-Ortho-Case-${opts.patient.caseNumber || numericId}.pptx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
