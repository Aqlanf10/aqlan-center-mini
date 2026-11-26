"use client";

import type { ClinicSettings, Language, PatientCase } from "../types/ortho";

export interface PresentationSlideConfig {
  id: string;
  labelAr: string;
  labelEn: string;
  enabled: boolean;
}

export const DEFAULT_SLIDES: PresentationSlideConfig[] = [
  { id: "cover", labelAr: "1. الغلاف وبيانات الحالة والطبيب", labelEn: "1. Title & Conference Cover Slide", enabled: true },
  { id: "case_history", labelAr: "2. المقابلة السريرية والاستبيان (Interview)", labelEn: "2. Interview & Patient Questionnaire", enabled: true },
  { id: "facial_photos", labelAr: "3. الفحص خارج الفم والتحليل الوجهي", labelEn: "3. Extraoral & Facial Analysis", enabled: true },
  { id: "intraoral_photos", labelAr: "4. الفحص داخل الفم والإطباق والأقواس", labelEn: "4. Intraoral Exam & Occlusion", enabled: true },
  { id: "radiographs_ceph", labelAr: "5. الأشعة والسيفالومتري وCBCT", labelEn: "5. Radiographs, Ceph & CBCT", enabled: true },
  { id: "measurements", labelAr: "6. القياسات والتحليلات العلمية المعتمدة", labelEn: "6. Approved Scientific Measurements", enabled: true },
  { id: "problem_diagnosis", labelAr: "7. قائمة المشكلات والتشخيص النهائي المعتمد", labelEn: "7. Problem List & Approved Diagnosis", enabled: true },
  { id: "treatment_plan", labelAr: "8. أهداف وخطة العلاج والأجهزة والميكانيكا", labelEn: "8. Treatment Plan & Mechanics", enabled: true },
  { id: "sessions_timeline", labelAr: "9. مسار الشدّات والجلسات وتطور الأسلاك", labelEn: "9. Tightening Sessions Timeline", enabled: true },
  { id: "before_after", labelAr: "10. مقارنة التطور (قبل وبعد)", labelEn: "10. Before & After Progress", enabled: true },
  { id: "retention", labelAr: "11. مرحلة التثبيت والمتابعة (Retention)", labelEn: "11. Retention & Follow-up", enabled: true },
];

export async function exportCaseToPowerPoint(opts: {
  patient: PatientCase;
  settings: ClinicSettings;
  lang: Language;
  slides: PresentationSlideConfig[];
  anonymize?: boolean;
  excludeInternalNotes?: boolean;
  selectedMediaIds?: string[];
}): Promise<void> {
  const numericId = Number(String(opts.patient.id).replace(/\D/g, "")) || 0;
  if (numericId <= 0) {
    throw new Error("معرّف المريض غير صالح لتصدير العرض التقديمي.");
  }

  const selectedSlideIds = opts.slides.filter((s) => s.enabled).map((s) => s.id);
  const res = await fetch(`/api/ortho/presentation/${numericId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      format: "pptx",
      anonymize: opts.anonymize === true,
      selectedSlideIds,
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
    ? `AQLAN-Ortho-Case-EDU-${numericId}.pptx`
    : `AQLAN-Ortho-Case-${opts.patient.caseNumber || numericId}.pptx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
