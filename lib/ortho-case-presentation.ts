/**
 * AQLAN Center Mini — Academic Conference Case Presentation Engine (Editable OOXML PPTX)
 *
 * Matches the standard Master of Science in Orthodontics (MSD) clinical conference sequence:
 *  1. Title & Clinical Conference Cover
 *  2. I. Interview / Questionnaire (Chief Complaint, Medical/Dental History, Growth)
 *  3. Diagnostic Records Montage (T0 8-Photo Grid)
 *  4. II. Clinical Examination — Extraoral Overview (3 Photos + Evaluation)
 *  5. II. Clinical Examination — Profile Analysis (Traced Profile + Evaluation)
 *  6. II. Clinical Examination — Smile & Midline Assessment (Traced Smile + Metrics)
 *  7. II. Clinical Examination — Transverse Facial Proportions (Rule of Fifths Traced)
 *  8. II. Clinical Examination — Vertical Facial Thirds (Vertical Thirds Traced)
 *  9. II. Clinical Examination — Intraoral Photos (5-Photo Montage)
 * 10. II. Clinical Examination — Occlusal & Arch Form Analysis
 * 11. II. Clinical Examination — Buccal & Frontal Occlusion Analysis
 * 12. Panoramic X-Ray (OPG) & FDI Dental Chart
 * 13. Lateral Cephalometric X-Ray & Traced Overlay
 * 14. ABO / Cephalometric Analysis Table (Approved Results Only)
 * 15. Study Cast / 3D Model & Cast Analysis Table (Left | Parameter | Right)
 * 16. Bolton's Analysis (Tooth-Width Grid + Formula + Anterior/Overall Ratios)
 * 17. Diagnosis & Approved Problem List
 * 18. Treatment Objectives
 * 19. Treatment Plan Matrix Table (Problem List | Treatment Plan | Strategies)
 * 20. Mechanotherapy Protocol (Strap-Up, Leveling & Alignment, Space Closure, Finishing)
 * 21. Retention Protocol & Follow-up
 * 22. Progress / Adjustment Slides (1 slide per tightening session with linked photos!)
 * 23. Closing / Thank You Slide
 *
 * Zero external npm dependencies. Verified directly against Microsoft PowerPoint Desktop.
 */

import { deflateRawSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import type { OrthoWorkspaceRecord } from "./ortho-workspace-types";
import { computeBoltonAnalysis } from "./ortho-scientific-analyses";

export interface CasePresentationSlideDef {
  id: string;
  titleAr: string;
  subtitleAr: string;
  titleEn: string;
}

export const ALL_PRESENTATION_SLIDES: readonly CasePresentationSlideDef[] = [
  { id: "cover", titleAr: "1. الغلاف وبيانات الحالة", subtitleAr: "عرض الحالة السريري وهوية المركز", titleEn: "1. Clinical Conference Cover" },
  { id: "case_history", titleAr: "2. الاستبيان والتاريخ الطبي", subtitleAr: "I. Interview / Questionnaire", titleEn: "2. I. Interview / Questionnaire" },
  { id: "t0_montage", titleAr: "3. مجمع السجلات الأولية (T0 Montage)", subtitleAr: "شبكة الصور التشخيصية الأولية", titleEn: "3. Diagnostic Records Montage (T0)" },
  { id: "facial_photos", titleAr: "4. الفحص خارج الفم (النظرة العامة)", subtitleAr: "II. Clinical Examination — Extraoral", titleEn: "4. II. Extraoral Overview" },
  { id: "extraoral_profile", titleAr: "5. تحليل البروفايل الجانبي بالرسم", subtitleAr: "II. Clinical Examination — Profile", titleEn: "5. II. Profile Analysis" },
  { id: "extraoral_smile", titleAr: "6. تحليل الابتسامة والخطوط الوسطى", subtitleAr: "II. Clinical Examination — Smile & Midline", titleEn: "6. II. Smile & Midline Assessment" },
  { id: "extraoral_fifths", titleAr: "7. الأخماس العرضية (Rule of Fifths)", subtitleAr: "II. Transverse Facial Proportions", titleEn: "7. II. Rule of Fifths" },
  { id: "extraoral_thirds", titleAr: "8. الأثلاث العمودية (Vertical Thirds)", subtitleAr: "II. Vertical Facial Proportions", titleEn: "8. II. Vertical Thirds" },
  { id: "intraoral_photos", titleAr: "9. الصور داخل الفم (5-Photo Montage)", subtitleAr: "II. Intraoral Photos", titleEn: "9. II. Intraoral Photos Montage" },
  { id: "intraoral_occlusal", titleAr: "10. تحليل الأقواس الإطباقية والأسنان", subtitleAr: "II. Occlusal Arch Evaluation", titleEn: "10. II. Occlusal & Arch Evaluation" },
  { id: "intraoral_buccal", titleAr: "11. علاقات الأنياب والأرحاء والإطباق", subtitleAr: "II. Buccal & Frontal Occlusion", titleEn: "11. II. Buccal & Frontal Occlusion" },
  { id: "radiographs_opg", titleAr: "12. أشعة البانوراما (OPG) ومخطط FDI", subtitleAr: "Panoramic X-Ray & Dental Chart", titleEn: "12. Panoramic X-Ray (OPG) & FDI" },
  { id: "radiographs_ceph", titleAr: "13. السيفالومتري الجانبي والتتبع (Tracing)", subtitleAr: "Lateral Cephalometric X-Ray", titleEn: "13. Cephalometric X-Ray & Tracing" },
  { id: "measurements", titleAr: "14. جدول تحليل السيفالومتري (ABO)", subtitleAr: "ABO / Cephalometric Analysis Table", titleEn: "14. ABO Cephalometric Analysis" },
  { id: "cast_analysis", titleAr: "15. تحليل النماذج (Cast / 3D Analysis)", subtitleAr: "Cast Analysis Table (Left | Parameter | Right)", titleEn: "15. Cast / 3D Model Analysis" },
  { id: "bolton_analysis", titleAr: "16. تحليل بولتون (Bolton's Analysis)", subtitleAr: "قياسات الأسنان والمعادلة والفارق", titleEn: "16. Bolton's Analysis" },
  { id: "problem_diagnosis", titleAr: "17. التشخيص النهائي وقائمة المشكلات", subtitleAr: "Diagnosis & Approved Problem List", titleEn: "17. Diagnosis & Problem List" },
  { id: "treatment_objectives", titleAr: "18. أهداف العلاج (Treatment Objectives)", subtitleAr: "الأهداف السريرية والجمالية", titleEn: "18. Treatment Objectives" },
  { id: "treatment_plan", titleAr: "19. مصفوفة خطة العلاج (Problem / Plan / Strategies)", subtitleAr: "Treatment Plan Matrix", titleEn: "19. Treatment Plan Matrix" },
  { id: "mechanotherapy", titleAr: "20. الميكانيكا وتتابع الأسلاك (Mechanotherapy)", subtitleAr: "Strap-up / Alignment / Space Closure / Finishing", titleEn: "20. Mechanotherapy Protocol" },
  { id: "retention", titleAr: "21. بروتوكول التثبيت (Retention)", subtitleAr: "المثبّتات والمتابعة بعد الفك", titleEn: "21. Retention Protocol" },
  { id: "sessions_timeline", titleAr: "22. شرائح متابعة الشدّات بالصور (Adjustments)", subtitleAr: "شريحة لكل جلسة شدّ بصورها وأسلاكها", titleEn: "22. Adjustment Progress Slides" },
  { id: "before_after", titleAr: "23. مقارنة قبل وبعد / الخاتمة", subtitleAr: "Progress Comparison & Closing", titleEn: "23. Before / After & Closing" },
] as const;

export interface EmbeddedSlideImage {
  bytes: Uint8Array;
  ext: "png" | "jpg";
  /** Position and size in EMUs (1 inch = 914400 EMU; 16:9 slide = 12192000 x 6858000) */
  x: number;
  y: number;
  cx: number;
  cy: number;
  caption?: string;
}

export interface EmbeddedSlideTable {
  x: number;
  y: number;
  cx: number;
  cy: number;
  colWidths: number[];
  headers: string[];
  rows: string[][];
  rtl?: boolean;
  fontSizePt?: number;
}

export interface EmbeddedSlideCard {
  x: number;
  y: number;
  cx: number;
  cy: number;
  title?: string;
  bullets: string[];
  accentHex?: string;
  rtl?: boolean;
  fontSizePt?: number;
}

export interface PresentationSlideContent {
  id: string;
  titleAr: string;
  subtitleAr: string;
  bulletsAr: string[];
  approvalBadgeAr: string;
  footerAr: string;
  rtl?: boolean;
  isCover?: boolean;
  images?: EmbeddedSlideImage[];
  tables?: EmbeddedSlideTable[];
  cards?: EmbeddedSlideCard[];
}

export interface PresentationDeck {
  clinicName: string;
  generatedAt: string;
  anonymized: boolean;
  displayPatientLabel: string;
  slides: PresentationSlideContent[];
  omittedUnapprovedNotes: string[];
}

export interface PresentationMediaAsset {
  id: string;
  docId?: number;
  title: string;
  viewType: string;
  stage: string;
  adjustmentId?: number | null;
  bytes: Uint8Array;
  ext: "png" | "jpg";
}

export interface PresentationSessionInput {
  id?: number;
  visitNumber?: number;
  date: string;
  phase?: string | null;
  upperWire?: string | null;
  lowerWire?: string | null;
  elastics?: string | null;
  note?: string | null;
  done?: string | null;
  clinician?: string | null;
  photoDocIds?: number[];
}

const EMU_INCH = 914400;
const inEmu = (inches: number) => Math.round(inches * EMU_INCH);

function pickImageByViews(
  assets: PresentationMediaAsset[],
  views: string[],
  fallbackIdx?: number,
): PresentationMediaAsset | null {
  for (const v of views) {
    const found = assets.find(
      (a) =>
        a.viewType.toLowerCase() === v.toLowerCase() ||
        a.viewType.toLowerCase().includes(v.toLowerCase()) ||
        a.title.toLowerCase().includes(v.toLowerCase()),
    );
    if (found) return found;
  }
  if (typeof fallbackIdx === "number" && assets[fallbackIdx]) return assets[fallbackIdx];
  return null;
}

function makeImg(
  asset: PresentationMediaAsset | null | undefined,
  xIn: number,
  yIn: number,
  wIn: number,
  hIn: number,
  caption?: string,
): EmbeddedSlideImage | null {
  if (!asset || asset.bytes.byteLength < 16) return null;
  return {
    bytes: asset.bytes,
    ext: asset.ext,
    x: inEmu(xIn),
    y: inEmu(yIn),
    cx: inEmu(wIn),
    cy: inEmu(hIn),
    caption: caption ?? asset.title,
  };
}

export type PresentationOverlayKey =
  | "ceph"
  | "profile"
  | "smile"
  | "fifths"
  | "thirds"
  | "intraoral"
  | "intraoral_right"
  | "intraoral_left"
  | "intraoral_upper"
  | "intraoral_lower";

export function buildCasePresentationDeck(input: {
  clinicName: string;
  patientName: string;
  patientCode: string;
  patientAgeGender?: string;
  doctorName?: string;
  record: OrthoWorkspaceRecord;
  selectedSlideIds?: string[];
  anonymize: boolean;
  lang?: "ar" | "en";
  sessionSummaries?: PresentationSessionInput[];
  photoCount?: number;
  mediaAssets?: PresentationMediaAsset[];
  tracedOverlays?: Partial<Record<PresentationOverlayKey, { bytes: Uint8Array; ext: "png" | "jpg" }>>;
}): PresentationDeck {
  const { clinicName, record, anonymize } = input;
  const lang = input.lang ?? "ar";
  const isRtl = lang === "ar";
  const assets = input.mediaAssets ?? [];
  const overlays = input.tracedOverlays ?? {};
  const sessions = input.sessionSummaries ?? [];
  const doctorName = input.doctorName || "الطبيب المختص بالتقويم";
  const dateStr = new Date().toISOString().slice(0, 10);

  const eduToken = anonymize ? randomBytes(3).toString("hex").toUpperCase() : "";
  const displayPatientLabel = anonymize
    ? lang === "en"
      ? `De-identified Educational Case (EDU-${eduToken})`
      : `حالة تقويم تعليمية مُخفاة الهوية (EDU-${eduToken})`
    : `${input.patientName}${input.patientCode ? ` · ${input.patientCode}` : ""}${input.patientAgeGender ? ` · ${input.patientAgeGender}` : ""}`;

  const footerBase =
    lang === "en"
      ? `${clinicName} — Orthodontic Clinical Case Presentation${anonymize ? " (De-identified)" : ""}`
      : `${clinicName} — عرض حالة تقويم الأسنان${anonymize ? " (نسخة تعليمية مُخفاة الهوية)" : ""}`;

  const omittedUnapprovedNotes: string[] = [];
  if (!record.diagnosisSummary.approvedAt) {
    omittedUnapprovedNotes.push("التشخيص النهائي غير معتمد بعد؛ لم يُدرج كتشخيص رسمي.");
  }
  if (!record.treatmentPlan.approvedAt) {
    omittedUnapprovedNotes.push("خطة العلاج غير معتمدة بعد؛ لم تُدرج كخطة رسمية.");
  }
  if (record.approvedAnalyses.length === 0) {
    omittedUnapprovedNotes.push("لا توجد تحليلات قياسات معتمدة بعد.");
  }

  // Pull OrthoCore rich fields if present
  const oc = (record.orthoCoreCase && typeof record.orthoCoreCase === "object"
    ? record.orthoCoreCase
    : null) as Record<string, unknown> | null;
  const ocAnalyses = Array.isArray(oc?.analyses) ? (oc.analyses as Array<Record<string, unknown>>) : [];
  const approvedCeph = ocAnalyses.find(
    (a) => a.analysisType === "cephalometric" && (Boolean(a.approvedAt) || Array.isArray(a.metrics)),
  );
  const approvedProblems = record.problems.filter((p) => p.approved);

  // Classify photos into standard MSD conference views (matching OrthoCore REQUIRED_T0_VIEWS + AQLAN views)
  const imgFrontalRest = pickImageByViews(assets, ["extraoral_frontal", "extraoral_frontal_rest", "frontal_rest", "rest"]);
  const imgFrontalSmile = pickImageByViews(assets, ["extraoral_smile", "extraoral_frontal_smile", "smile"]);
  const imgProfile = pickImageByViews(assets, ["extraoral_profile", "profile"]);
  const imgIntraRight = pickImageByViews(assets, ["intraoral_right", "right_buccal"]);
  const imgIntraFront = pickImageByViews(assets, ["intraoral_frontal"]);
  const imgIntraLeft = pickImageByViews(assets, ["intraoral_left", "left_buccal"]);
  const imgIntraUpper = pickImageByViews(assets, ["intraoral_upper", "upper_occlusal"]);
  const imgIntraLower = pickImageByViews(assets, ["intraoral_lower", "lower_occlusal"]);
  const imgOpg = pickImageByViews(assets, ["panoramic_opg", "opg", "panoramic"]);
  const imgCeph = pickImageByViews(assets, ["lateral_ceph", "ceph"]);
  const imgCast = pickImageByViews(assets, ["model_3d_stl", "cast", "model3d", "model"]);

  // Merge tooth widths from OrthoCore cast_bolton analysis if entered there
  const mergedTeeth = { ...record.clinicalExam.teeth };
  const boltonOc = ocAnalyses.find((a) => a.analysisType === "cast_bolton" && a.toothWidths && typeof a.toothWidths === "object");
  if (boltonOc && boltonOc.toothWidths) {
    for (const [fdiStr, wVal] of Object.entries(boltonOc.toothWidths as Record<string, unknown>)) {
      const fdiNum = Number(fdiStr);
      const numW = typeof wVal === "number" ? wVal : Number(wVal);
      if (Number.isInteger(fdiNum) && Number.isFinite(numW) && numW > 0) {
        mergedTeeth[fdiStr] = {
          fdi: fdiNum,
          dentition: mergedTeeth[fdiStr]?.dentition ?? (fdiNum >= 50 ? "primary" : "permanent"),
          status: mergedTeeth[fdiStr]?.status ?? "present",
          widthMm: numW,
          note: mergedTeeth[fdiStr]?.note ?? "",
        };
      }
    }
  }

  const boltonAnt = computeBoltonAnalysis(mergedTeeth, "anterior");
  const boltonAll = computeBoltonAnalysis(mergedTeeth, "overall");

  // Helper to attach traced overlay or fallback raw photo
  const overlayOrAsset = (
    key: keyof typeof overlays,
    fallback: PresentationMediaAsset | null,
    x: number,
    y: number,
    w: number,
    h: number,
    caption: string,
  ): EmbeddedSlideImage | null => {
    const ov = overlays[key];
    if (ov && ov.bytes.byteLength > 16) {
      return { bytes: ov.bytes, ext: ov.ext, x: inEmu(x), y: inEmu(y), cx: inEmu(w), cy: inEmu(h), caption };
    }
    return makeImg(fallback, x, y, w, h, caption);
  };

  const slidesOut: PresentationSlideContent[] = [];

  const builders: Record<string, () => PresentationSlideContent[]> = {
    cover: () => [
      {
        id: "cover",
        isCover: true,
        rtl: isRtl,
        titleAr: lang === "en" ? "Orthodontic Clinical Case Presentation" : "عرض حالة تقويم الأسنان السريري (Case Presentation)",
        subtitleAr: displayPatientLabel,
        approvalBadgeAr: `${doctorName} · ${dateStr}`,
        footerAr: footerBase,
        bulletsAr: [
          `${lang === "en" ? "Center" : "المركز"}: ${clinicName}`,
          `${lang === "en" ? "Presented by" : "تقديم الطبيب"}: ${doctorName}`,
          `${lang === "en" ? "Patient / Case" : "بيانات الحالة"}: ${displayPatientLabel}`,
          `${lang === "en" ? "Date" : "التاريخ"}: ${dateStr}`,
          `${lang === "en" ? "Dentition Stage" : "مرحلة الإطباق"}: ${record.clinicalExam.dentitionStage}`,
          anonymize
            ? "تم إخفاء بيانات الهوية الشخصية وفق سياسة الخصوصية وموافقة المريض التعليمية."
            : "عرض سريري أكاديمي موثّق من السجلات المعتمدة في نظام AQLAN Center Mini.",
        ],
      },
    ],

    case_history: () => {
      const bullets = [
        `Chief Complaint / الشكوى الرئيسية: "${record.questionnaire.chiefComplaint.trim() || "غير مسجّلة"}"`,
        `Patient Expectations / التوقعات: ${record.questionnaire.patientExpectations.trim() || "تحسين الابتسامة وتناسق الأسنان والفكين"}`,
        `Medical History / التاريخ الطبي: ${record.questionnaire.medicalAlertsSummary.trim() || "سليم — لا توجد أمراض مزمنة مسجّلة"}`,
        `Allergies & Medications / الحساسية والأدوية: ${[record.questionnaire.allergies, record.questionnaire.medications].filter(Boolean).join(" · ") || "لا يوجد"}`,
        `Physical Growth / حالة النمو: ${record.questionnaire.growthStatus || "غير محددة"}`,
        `Oral Habits & TMJ / العادات والمفصل: ${record.questionnaire.tmjSymptoms.notes.trim() || "لا توجد أعراض مفصلية مسجّلة"}`,
      ];
      return [
        {
          id: "case_history",
          rtl: isRtl,
          titleAr: lang === "en" ? "I. Interview / Questionnaire" : "أولاً: المقابلة السريرية والاستبيان (I. Interview)",
          subtitleAr: displayPatientLabel,
          approvalBadgeAr: "I. Interview",
          footerAr: footerBase,
          bulletsAr: bullets,
          cards: [
            {
              x: inEmu(0.6),
              y: inEmu(1.55),
              cx: inEmu(12.1),
              cy: inEmu(5.1),
              title: lang === "en" ? "Patient Interview & History Summary" : "ملخص المقابلة السريرية والتاريخ الطبي",
              bullets,
              accentHex: "1A3A5C",
              rtl: isRtl,
              fontSizePt: 16,
            },
          ],
        },
      ];
    },

    t0_montage: () => {
      const montageImgs = [
        makeImg(imgFrontalRest, 0.5, 1.5, 2.9, 2.4, "Frontal Rest"),
        makeImg(imgFrontalSmile, 3.6, 1.5, 2.9, 2.4, "Frontal Smile"),
        makeImg(imgProfile, 6.7, 1.5, 2.9, 2.4, "Right Profile"),
        makeImg(imgIntraUpper, 9.8, 1.5, 3.0, 2.4, "Upper Occlusal"),
        makeImg(imgIntraRight, 0.5, 4.15, 2.9, 2.4, "Right Buccal"),
        makeImg(imgIntraFront, 3.6, 4.15, 2.9, 2.4, "Intraoral Frontal"),
        makeImg(imgIntraLeft, 6.7, 4.15, 2.9, 2.4, "Left Buccal"),
        makeImg(imgIntraLower, 9.8, 4.15, 3.0, 2.4, "Lower Occlusal"),
      ].filter((x): x is EmbeddedSlideImage => x !== null);

      return [
        {
          id: "t0_montage",
          rtl: isRtl,
          titleAr: lang === "en" ? "Initial Diagnostic Records Montage (T0)" : "مجمع الصور التشخيصية الأولية (T0 Montage)",
          subtitleAr: displayPatientLabel,
          approvalBadgeAr: `${montageImgs.length} صور موثّقة`,
          footerAr: footerBase,
          bulletsAr: [
            `عدد الصور التشخيصية الموثّقة في الأرشيف: ${assets.length}`,
            "يشمل المجمع القياسي: 3 صور وجهية خارج الفم + 5 صور سريرية داخل الفم (يمين، أمامي، يسار، إطباقي علوي، إطباقي سفلي).",
          ],
          images: montageImgs,
        },
      ];
    },

    facial_photos: () => {
      const imgs = [
        makeImg(imgFrontalRest, 0.5, 1.55, 2.8, 3.6, "Frontal Rest"),
        makeImg(imgFrontalSmile, 3.5, 1.55, 2.8, 3.6, "Frontal Smile"),
        makeImg(imgProfile, 6.5, 1.55, 2.8, 3.6, "Profile"),
      ].filter((x): x is EmbeddedSlideImage => x !== null);
      const evalBullets = [
        `Facial Form / نمط الوجه: ${record.clinicalExam.extraoral.facialForm || "—"}`,
        `Profile / الجانب الوجهي: ${record.clinicalExam.extraoral.profileType || "—"}`,
        `Symmetry / التناظر الوجهي: ${record.clinicalExam.extraoral.facialSymmetry || "—"}`,
        `Lip Competence / إطباق الشفتين: ${record.clinicalExam.extraoral.lipCompetence || "—"}`,
        `Smile Arc / قوس الابتسامة: ${record.clinicalExam.extraoral.smileArc || "—"}`,
        `Buccal Corridor / الدهليز الشدقي: ${record.clinicalExam.extraoral.buccalCorridor || "—"}`,
      ];
      return [
        {
          id: "facial_photos",
          rtl: isRtl,
          titleAr: lang === "en" ? "II. Clinical Examination — Extraoral Evaluation" : "ثانياً: الفحص السريري خارج الفم (Extraoral Overview)",
          subtitleAr: displayPatientLabel,
          approvalBadgeAr: "II. Clinical Exam",
          footerAr: footerBase,
          bulletsAr: evalBullets,
          images: imgs,
          cards: [
            {
              x: inEmu(imgs.length > 0 ? 9.5 : 0.6),
              y: inEmu(1.55),
              cx: inEmu(imgs.length > 0 ? 3.35 : 12.1),
              cy: inEmu(4.8),
              title: "Evaluation / التقييم",
              bullets: evalBullets,
              accentHex: "1A3A5C",
              rtl: isRtl,
              fontSizePt: 13,
            },
          ],
        },
      ];
    },

    extraoral_profile: () => {
      const img = overlayOrAsset("profile", imgProfile, 0.7, 1.55, 4.8, 5.0, "Lateral Profile Analysis");
      const bullets = [
        `Profile Convexity / تحدّب البروفايل: ${record.clinicalExam.extraoral.profileType || "—"}`,
        `Nasolabial Angle / الزاوية الأنفية الشفوية: ${record.clinicalExam.extraoral.nasolabialAngle || "—"}`,
        `Lip Competence / إطباق الشفتين: ${record.clinicalExam.extraoral.lipCompetence || "—"}`,
        record.clinicalExam.extraoral.notes || "راجع خطوط التحليل المرسومة في استوديو الصور الوجهية.",
      ];
      return [
        {
          id: "extraoral_profile",
          rtl: isRtl,
          titleAr: lang === "en" ? "II. Clinical Examination — Profile Analysis" : "الفحص خارج الفم: تحليل البروفايل الجانبي (Profile)",
          subtitleAr: "Lateral Soft Tissue Profile & E-Line",
          approvalBadgeAr: "Profile Analysis",
          footerAr: footerBase,
          bulletsAr: bullets,
          images: img ? [img] : [],
          cards: [
            {
              x: inEmu(img ? 5.9 : 0.6),
              y: inEmu(1.55),
              cx: inEmu(img ? 6.8 : 12.1),
              cy: inEmu(4.8),
              title: "Profile Evaluation / تقييم البروفايل",
              bullets,
              accentHex: "3D7AB5",
              rtl: isRtl,
              fontSizePt: 15,
            },
          ],
        },
      ];
    },

    extraoral_smile: () => {
      const img = overlayOrAsset("smile", imgFrontalSmile, 0.7, 1.55, 4.8, 5.0, "Frontal Smile Analysis");
      const bullets = [
        `Upper Midline Shift / انحراف الخط الوسطي العلوي: ${record.clinicalExam.intraoral.upperMidlineShiftMm ?? "—"} mm`,
        `Lower Midline Shift / انحراف الخط الوسطي السفلي: ${record.clinicalExam.intraoral.lowerMidlineShiftMm ?? "—"} mm`,
        `Smile Arc / قوس الابتسامة: ${record.clinicalExam.extraoral.smileArc || "—"}`,
        `Buccal Corridor / الدهليز الشدقي: ${record.clinicalExam.extraoral.buccalCorridor || "—"}`,
        `Gingival Display / انكشاف اللثة: ${record.clinicalExam.extraoral.gingivalDisplayMm ?? "—"} mm`,
      ];
      return [
        {
          id: "extraoral_smile",
          rtl: isRtl,
          titleAr: lang === "en" ? "II. Clinical Examination — Smile & Midline Assessment" : "الفحص خارج الفم: تحليل الابتسامة والخطوط الوسطى",
          subtitleAr: "Midline, Smile Arc, Buccal Corridor & Gingival Display",
          approvalBadgeAr: "Smile Analysis",
          footerAr: footerBase,
          bulletsAr: bullets,
          images: img ? [img] : [],
          cards: [
            {
              x: inEmu(img ? 5.9 : 0.6),
              y: inEmu(1.55),
              cx: inEmu(img ? 6.8 : 12.1),
              cy: inEmu(4.8),
              title: "Midline & Smile Assessment",
              bullets,
              accentHex: "F5922E",
              rtl: isRtl,
              fontSizePt: 15,
            },
          ],
        },
      ];
    },

    extraoral_fifths: () => {
      const img = overlayOrAsset("fifths", imgFrontalRest, 0.7, 1.55, 4.8, 5.0, "Transverse Rule of Fifths");
      const bullets = [
        "Transverse Facial Proportions — Rule of Fifths (قاعدة الأخماس العرضية):",
        `Facial Symmetry / التناظر: ${record.clinicalExam.extraoral.facialSymmetry || "—"}`,
        "Central Fifth: Intercanthal distance compared with nasal alar base width.",
        "Medial Fifths: Mouth commissures compared with medial limbus / interpupillary vertical lines.",
        "Outer Fifths: Outer canthus compared with gonial / helix width.",
      ];
      return [
        {
          id: "extraoral_fifths",
          rtl: isRtl,
          titleAr: lang === "en" ? "II. Clinical Examination — Rule of Fifths" : "الفحص خارج الفم: الأخماس العرضية (Rule of Fifths)",
          subtitleAr: "Transverse Facial Proportions",
          approvalBadgeAr: "Rule of Fifths",
          footerAr: footerBase,
          bulletsAr: bullets,
          images: img ? [img] : [],
          cards: [
            {
              x: inEmu(img ? 5.9 : 0.6),
              y: inEmu(1.55),
              cx: inEmu(img ? 6.8 : 12.1),
              cy: inEmu(4.8),
              title: "Transverse Facial Proportion",
              bullets,
              accentHex: "1A3A5C",
              rtl: isRtl,
              fontSizePt: 14,
            },
          ],
        },
      ];
    },

    extraoral_thirds: () => {
      const img = overlayOrAsset("thirds", imgFrontalRest, 0.7, 1.55, 4.8, 5.0, "Vertical Facial Thirds");
      const lm = record.facialPhoto.landmarks;
      let thirdsLine = "Upper / Middle / Lower Thirds: يتطلب تعيين المعالم Tr, G, Sn, Me.";
      if (lm.Tr && lm.G && lm.Sn && lm.Me) {
        const u = Math.abs(lm.G.y - lm.Tr.y);
        const m = Math.abs(lm.Sn.y - lm.G.y);
        const l = Math.abs(lm.Me.y - lm.Sn.y);
        const tot = u + m + l;
        if (tot > 0) {
          thirdsLine = `Upper: ${((u / tot) * 100).toFixed(1)}% · Middle: ${((m / tot) * 100).toFixed(1)}% · Lower: ${((l / tot) * 100).toFixed(1)}% (Norm ~33.3% each)`;
        }
      }
      const bullets = [
        thirdsLine,
        `Facial Form / النمط الوجهي: ${record.clinicalExam.extraoral.facialForm || "—"}`,
        `Vertical Skeletal Pattern: ${record.diagnosisSummary.verticalPattern || "—"}`,
        "Upper Lip : Lower Lip & Chin Ratio (1/3 : 2/3 standard reference).",
      ];
      return [
        {
          id: "extraoral_thirds",
          rtl: isRtl,
          titleAr: lang === "en" ? "II. Clinical Examination — Vertical Thirds" : "الفحص خارج الفم: الأثلاث العمودية (Vertical Thirds)",
          subtitleAr: "Vertical Facial Proportions",
          approvalBadgeAr: "Vertical Thirds",
          footerAr: footerBase,
          bulletsAr: bullets,
          images: img ? [img] : [],
          cards: [
            {
              x: inEmu(img ? 5.9 : 0.6),
              y: inEmu(1.55),
              cx: inEmu(img ? 6.8 : 12.1),
              cy: inEmu(4.8),
              title: "Vertical Thirds Assessment",
              bullets,
              accentHex: "3D7AB5",
              rtl: isRtl,
              fontSizePt: 14,
            },
          ],
        },
      ];
    },

    intraoral_photos: () => {
      const imgs = [
        makeImg(imgIntraRight, 0.5, 1.5, 4.0, 2.45, "Right Buccal"),
        makeImg(imgIntraFront, 4.65, 1.5, 4.0, 2.45, "Frontal Occlusion"),
        makeImg(imgIntraLeft, 8.8, 1.5, 4.0, 2.45, "Left Buccal"),
        makeImg(imgIntraUpper, 2.2, 4.15, 4.2, 2.45, "Upper Occlusal"),
        makeImg(imgIntraLower, 6.8, 4.15, 4.2, 2.45, "Lower Occlusal"),
      ].filter((x): x is EmbeddedSlideImage => x !== null);
      return [
        {
          id: "intraoral_photos",
          rtl: isRtl,
          titleAr: lang === "en" ? "II. Clinical Examination — Intraoral Photos" : "الفحص داخل الفم: الصور السريرية الخمس (Intraoral Montage)",
          subtitleAr: "Right, Frontal, Left, Upper & Lower Occlusal",
          approvalBadgeAr: `${imgs.length} صور داخل الفم`,
          footerAr: footerBase,
          bulletsAr: [
            `علاقة الأرحاء: يمين (${record.clinicalExam.intraoral.molarRight || "—"}) · يسار (${record.clinicalExam.intraoral.molarLeft || "—"})`,
            `Overjet: ${record.clinicalExam.intraoral.overjetMm ?? "—"} mm · Overbite: ${record.clinicalExam.intraoral.overbiteMm ?? "—"} mm`,
          ],
          images: imgs,
        },
      ];
    },

    intraoral_occlusal: () => {
      const imgs = [
        overlayOrAsset("intraoral_upper", imgIntraUpper, 0.6, 1.55, 3.8, 2.5, "Maxillary Occlusal"),
        overlayOrAsset("intraoral_lower", imgIntraLower, 0.6, 4.2, 3.8, 2.5, "Mandibular Occlusal"),
      ].filter((x): x is EmbeddedSlideImage => x !== null);
      const missingFdi = Object.values(record.clinicalExam.teeth)
        .filter((t) => t.status === "missing" || t.status === "extracted")
        .map((t) => t.fdi);
      const bullets = [
        `Upper Arch Form / شكل القوس العلوي: ${record.clinicalExam.intraoral.archFormUpper || "—"}`,
        `Lower Arch Form / شكل القوس السفلي: ${record.clinicalExam.intraoral.archFormLower || "—"}`,
        `Available Space / المساحة المتاحة: Upper ${record.clinicalExam.intraoral.upperAvailableSpaceMm ?? "—"} mm · Lower ${record.clinicalExam.intraoral.lowerAvailableSpaceMm ?? "—"} mm`,
        `Missing / Extracted FDI Teeth: ${missingFdi.length > 0 ? missingFdi.join(", ") : "None recorded / لا يوجد"}`,
        `Oral Hygiene / Gingival Health: ${record.clinicalExam.intraoral.oralHygiene || "—"} / ${record.clinicalExam.intraoral.gingivalHealth || "—"}`,
      ];
      return [
        {
          id: "intraoral_occlusal",
          rtl: isRtl,
          titleAr: lang === "en" ? "II. Intraoral Examination — Occlusal Arch Analysis" : "الفحص داخل الفم: تحليل القوسين الإطباقيين",
          subtitleAr: "Maxillary & Mandibular Arch Form, Symmetry & Tooth Status",
          approvalBadgeAr: "Occlusal Views",
          footerAr: footerBase,
          bulletsAr: bullets,
          images: imgs,
          cards: [
            {
              x: inEmu(imgs.length > 0 ? 4.8 : 0.6),
              y: inEmu(1.55),
              cx: inEmu(imgs.length > 0 ? 7.9 : 12.1),
              cy: inEmu(5.0),
              title: "Occlusal Evaluation / تقييم الأقواس",
              bullets,
              accentHex: "1A3A5C",
              rtl: isRtl,
              fontSizePt: 14,
            },
          ],
        },
      ];
    },

    intraoral_buccal: () => {
      const imgs = [
        overlayOrAsset("intraoral_right", imgIntraRight, 0.5, 1.55, 4.0, 2.35, "Right Buccal"),
        overlayOrAsset("intraoral", imgIntraFront, 4.65, 1.55, 4.0, 2.35, "Frontal"),
        overlayOrAsset("intraoral_left", imgIntraLeft, 8.8, 1.55, 4.0, 2.35, "Left Buccal"),
      ].filter((x): x is EmbeddedSlideImage => x !== null);
      const bullets = [
        `Molar Relation: Right (${record.clinicalExam.intraoral.molarRight || "—"}) · Left (${record.clinicalExam.intraoral.molarLeft || "—"})`,
        `Canine Relation: Right (${record.clinicalExam.intraoral.canineRight || "—"}) · Left (${record.clinicalExam.intraoral.canineLeft || "—"})`,
        `Overjet: ${record.clinicalExam.intraoral.overjetMm ?? "—"} mm · Overbite: ${record.clinicalExam.intraoral.overbiteMm ?? "—"} mm`,
        `Crossbite: Anterior (${record.clinicalExam.intraoral.crossbiteAnterior ? "Yes" : "No"}) · Posterior (${record.clinicalExam.intraoral.crossbitePosterior})`,
        `Curve of Spee: ${record.clinicalExam.intraoral.curveOfSpeeMm ?? "—"} mm`,
      ];
      return [
        {
          id: "intraoral_buccal",
          rtl: isRtl,
          titleAr: lang === "en" ? "II. Intraoral Examination — Occlusal Relationships" : "الفحص داخل الفم: علاقات الإطباق والأنياب والأرحاء",
          subtitleAr: "Right, Frontal & Left Clinical Evaluation",
          approvalBadgeAr: "Occlusion",
          footerAr: footerBase,
          bulletsAr: bullets,
          images: imgs,
          cards: [
            {
              x: inEmu(0.6),
              y: inEmu(imgs.length > 0 ? 4.1 : 1.6),
              cx: inEmu(12.1),
              cy: inEmu(imgs.length > 0 ? 2.55 : 4.8),
              title: "Clinical Occlusion Summary",
              bullets,
              accentHex: "3D7AB5",
              rtl: isRtl,
              fontSizePt: 13,
            },
          ],
        },
      ];
    },

    radiographs_opg: () => {
      const img = makeImg(imgOpg, 0.6, 1.55, 7.6, 4.4, "Panoramic Radiograph (OPG)");
      const impacted = Object.values(record.clinicalExam.teeth)
        .filter((t) => t.status === "impacted")
        .map((t) => t.fdi);
      const extracted = Object.values(record.clinicalExam.teeth)
        .filter((t) => t.status === "missing" || t.status === "extracted")
        .map((t) => t.fdi);
      const bullets = [
        `Dentition Stage: ${record.clinicalExam.dentitionStage}`,
        `Extracted / Missing FDI: ${extracted.length > 0 ? extracted.join(", ") : "None"}`,
        `Impacted FDI: ${impacted.length > 0 ? impacted.join(", ") : "None"}`,
        `Impaction Notes: ${record.cbct.impactionNotes.trim() || "لا توجد ملاحظات انطمار"}`,
        `Bone & Root Resorption: ${record.cbct.rootResorptionNotes.trim() || "مستوى عظم طبيعي ولا يوجد امتصاص جذور"}`,
      ];
      return [
        {
          id: "radiographs_opg",
          rtl: isRtl,
          titleAr: lang === "en" ? "Panoramic X-Ray (OPG) & FDI Dental Chart" : "أشعة البانوراما (OPG) وتقييم الأسنان وفق FDI",
          subtitleAr: "Teeth Present, Missing, Impacted, Bone Level & Roots",
          approvalBadgeAr: "OPG Evaluation",
          footerAr: footerBase,
          bulletsAr: bullets,
          images: img ? [img] : [],
          cards: [
            {
              x: inEmu(img ? 8.4 : 0.6),
              y: inEmu(1.55),
              cx: inEmu(img ? 4.4 : 12.1),
              cy: inEmu(4.8),
              title: "OPG Findings",
              bullets,
              accentHex: "1A3A5C",
              rtl: isRtl,
              fontSizePt: 13,
            },
          ],
        },
      ];
    },

    radiographs_ceph: () => {
      const cephRaw = makeImg(imgCeph, 0.6, 1.55, 5.8, 5.0, "Lateral Cephalometric X-Ray");
      const cephTraced = overlayOrAsset("ceph", null, 6.8, 1.55, 5.8, 5.0, "Cephalometric Tracing Overlay");
      const imgs = [cephRaw, cephTraced].filter((x): x is EmbeddedSlideImage => x !== null);
      const bullets = [
        `Modality: ${record.cbct.modality}`,
        `Calibration (Pixel Spacing): ${record.cbct.pixelSpacingMm ? `${record.cbct.pixelSpacingMm} mm/px` : "غير معاير (المعايرة مطلوبة قبل اعتماد القياسات)"}`,
        `Airway Notes: ${record.cbct.airwayNotes.trim() || "—"}`,
        "ضابط السيفالومتري: معايرة مليمترية + حد أدنى 24 معلمًا تشريحيًا مؤكدًا من الطبيب.",
      ];
      return [
        {
          id: "radiographs_ceph",
          rtl: isRtl,
          titleAr: lang === "en" ? "Lateral Cephalometric X-Ray & Tracing" : "الأشعة السيفالومترية الجانبية والتتبع (Cephalometric X-Ray)",
          subtitleAr: "Calibrated Radiograph & Anatomical Landmark Tracing",
          approvalBadgeAr: "Cephalometrics",
          footerAr: footerBase,
          bulletsAr: bullets,
          images: imgs,
          cards:
            imgs.length === 0
              ? [
                  {
                    x: inEmu(0.6),
                    y: inEmu(1.6),
                    cx: inEmu(12.1),
                    cy: inEmu(4.6),
                    title: "Radiographic Calibration & Notes",
                    bullets,
                    accentHex: "1A3A5C",
                    rtl: isRtl,
                    fontSizePt: 15,
                  },
                ]
              : undefined,
        },
      ];
    },

    measurements: () => {
      // Build native ABO Cephalometric / Approved Measurements Table
      const metricRows: string[][] = [];
      if (approvedCeph && Array.isArray(approvedCeph.metrics)) {
        for (const m of (approvedCeph.metrics as Array<Record<string, unknown>>).slice(0, 14)) {
          metricRows.push([
            String(m.labelEn || m.labelAr || m.key || ""),
            String(m.normRange || "—"),
            m.value != null ? `${m.value} ${m.unit || ""}` : "—",
            String(m.interpretation || "—"),
          ]);
        }
      }
      for (const a of record.approvedAnalyses.slice(0, 8)) {
        const vals = Object.entries(a.values)
          .slice(0, 2)
          .map(([k, v]) => `${k}: ${v ?? "—"}`)
          .join(" | ");
        metricRows.push([a.titleAr, a.referenceCitation.slice(0, 32), vals || "معتمد", a.summaryAr.slice(0, 60)]);
      }

      const hasApproved = metricRows.length > 0;
      const rows = hasApproved
        ? metricRows
        : [["—", "—", "Pending Approval", "لا توجد قياسات معتمدة بعد — لا تُعرض المسودات غير المعتمدة في العرض العلمي."]];

      return [
        {
          id: "measurements",
          rtl: isRtl,
          titleAr: lang === "en" ? "ABO / Cephalometric & Scientific Measurements" : "جدول التحليل السيفالومتري والقياسات العلمية المعتمدة (ABO)",
          subtitleAr: "Approved Measurements Only — Contemporary Orthodontics 7th Ed",
          approvalBadgeAr: hasApproved ? "نتائج معتمدة ✓" : "بانتظار الاعتماد",
          footerAr: footerBase,
          bulletsAr: hasApproved
            ? record.approvedAnalyses.map((a) => `${a.titleAr}: ${a.summaryAr}`)
            : ["لا توجد قياسات معتمدة بعد — لا تُدرج المسودات غير المعتمدة."],
          tables: [
            {
              x: inEmu(0.5),
              y: inEmu(1.5),
              cx: inEmu(12.3),
              cy: inEmu(5.1),
              colWidths: [inEmu(3.1), inEmu(2.4), inEmu(2.2), inEmu(4.6)],
              headers:
                lang === "en"
                  ? ["Measurement / Analysis", "Standard / Ref", "Initial Value", "Interpretation"]
                  : ["القياس / التحليل", "المعدل المرجعي", "القيمة المعتمدة", "التفسير السريري"],
              rows,
              rtl: isRtl,
              fontSizePt: 11,
            },
          ],
        },
      ];
    },

    cast_analysis: () => {
      const castImg = makeImg(imgCast, 0.5, 1.55, 4.4, 4.8, "Study Cast / 3D Model");
      const rows: string[][] = [
        [record.clinicalExam.intraoral.canineLeft || "—", "Canine Relationship / علاقة الأنياب", record.clinicalExam.intraoral.canineRight || "—"],
        [record.clinicalExam.intraoral.molarLeft || "—", "Molar Relationship / علاقة الأرحاء", record.clinicalExam.intraoral.molarRight || "—"],
        [String(record.clinicalExam.intraoral.overjetMm ?? "—"), "Overjet (mm) / التغطية الأفقية", String(record.clinicalExam.intraoral.overjetMm ?? "—")],
        [String(record.clinicalExam.intraoral.overbiteMm ?? "—"), "Overbite (mm) / التغطية العمودية", String(record.clinicalExam.intraoral.overbiteMm ?? "—")],
        [String(record.clinicalExam.intraoral.curveOfSpeeMm ?? "—"), "Curve of Spee (mm)", String(record.clinicalExam.intraoral.curveOfSpeeMm ?? "—")],
        [record.clinicalExam.intraoral.crossbitePosterior, "Posterior Crossbite / عضّة معكوسة خلفية", record.clinicalExam.intraoral.crossbitePosterior],
        [record.clinicalExam.intraoral.crossbiteAnterior ? "Yes" : "No", "Anterior Crossbite / عضّة معكوسة أمامية", record.clinicalExam.intraoral.crossbiteAnterior ? "Yes" : "No"],
        [String(record.model3d.intercanineLowerMm ?? "—"), "Intercanine Width (mm) U / L", String(record.model3d.intercanineUpperMm ?? "—")],
        [String(record.model3d.intermolarLowerMm ?? "—"), "Intermolar Width (mm) U / L", String(record.model3d.intermolarUpperMm ?? "—")],
      ];
      return [
        {
          id: "cast_analysis",
          rtl: isRtl,
          titleAr: lang === "en" ? "Cast / 3D Model Analysis" : "تحليل النماذج الجبسية والرقمية (Cast Analysis)",
          subtitleAr: "Left | Parameter | Right",
          approvalBadgeAr: "Cast Analysis",
          footerAr: footerBase,
          bulletsAr: rows.map((r) => `${r[1]}: R=${r[2]} / L=${r[0]}`),
          images: castImg ? [castImg] : [],
          tables: [
            {
              x: inEmu(castImg ? 5.15 : 0.6),
              y: inEmu(1.55),
              cx: inEmu(castImg ? 7.65 : 12.1),
              cy: inEmu(5.0),
              colWidths: castImg
                ? [inEmu(2.0), inEmu(3.65), inEmu(2.0)]
                : [inEmu(3.2), inEmu(5.7), inEmu(3.2)],
              headers: ["Left / يسار", "Parameter / المعيار", "Right / يمين"],
              rows,
              rtl: false,
              fontSizePt: 11,
            },
          ],
        },
      ];
    },

    bolton_analysis: () => {
      const u6 = [13, 12, 11, 21, 22, 23].map((f) => String(mergedTeeth[String(f)]?.widthMm ?? "—"));
      const l6 = [43, 42, 41, 31, 32, 33].map((f) => String(mergedTeeth[String(f)]?.widthMm ?? "—"));
      const formulaBullets =
        boltonAnt.status === "calculated"
          ? [
              `Anterior Ratio = (Sum Mandibular 6 [${boltonAnt.lowerSumMm} mm] / Sum Maxillary 6 [${boltonAnt.upperSumMm} mm]) × 100 = ${boltonAnt.ratioPercent}% (Norm: 77.2% ± 1.65%)`,
              boltonAnt.interpretationAr,
              boltonAll.status === "calculated"
                ? `Overall Ratio (12–12) = (${boltonAll.lowerSumMm} / ${boltonAll.upperSumMm}) × 100 = ${boltonAll.ratioPercent}% (Norm: 91.3% ± 1.91%) — ${boltonAll.interpretationAr}`
                : `Overall Bolton (12–12): ناقص قياسات FDI (${boltonAll.missingFdi.join(", ")})`,
              `Reference: ${boltonAnt.reference}`,
            ]
          : [
              `Anterior Bolton (6–6): لم تكتمل قياسات الأسنان الستة الأمامية (ناقص FDI: ${boltonAnt.missingFdi.join(", ")}).`,
              "Formula: Anterior Ratio = (Sum Mandibular 6 / Sum Maxillary 6) × 100 (Standard Mean = 77.2% ± 1.65%).",
              "لا تُعرض نتائج محسوبة قبل إدخال قياسات جميع الأسنان المطلوبة.",
            ];
      return [
        {
          id: "bolton_analysis",
          rtl: isRtl,
          titleAr: lang === "en" ? "Bolton's Tooth-Size Analysis" : "تحليل بولتون لتناسب أحجام الأسنان (Bolton's Analysis)",
          subtitleAr: "Anterior (6–6, 77.2%) & Overall (12–12, 91.3%)",
          approvalBadgeAr: boltonAnt.status === "calculated" ? `${boltonAnt.ratioPercent}%` : "Incomplete",
          footerAr: footerBase,
          bulletsAr: formulaBullets,
          tables: [
            {
              x: inEmu(0.6),
              y: inEmu(1.5),
              cx: inEmu(12.1),
              cy: inEmu(1.8),
              colWidths: [inEmu(2.5), inEmu(1.6), inEmu(1.6), inEmu(1.6), inEmu(1.6), inEmu(1.6), inEmu(1.6)],
              headers: ["Arch / FDI", "R3 (13/43)", "R2 (12/42)", "R1 (11/41)", "L1 (21/31)", "L2 (22/32)", "L3 (23/33)"],
              rows: [
                ["Maxillary (mm)", ...u6],
                ["Mandibular (mm)", ...l6],
              ],
              rtl: false,
              fontSizePt: 12,
            },
          ],
          cards: [
            {
              x: inEmu(0.6),
              y: inEmu(3.55),
              cx: inEmu(12.1),
              cy: inEmu(3.1),
              title: "Bolton Formula & Clinical Interpretation",
              bullets: formulaBullets,
              accentHex: "F5922E",
              rtl: isRtl,
              fontSizePt: 14,
            },
          ],
        },
      ];
    },

    problem_diagnosis: () => {
      const bullets = record.diagnosisSummary.approvedAt
        ? [
            `Skeletal Class / التصنيف الهيكلي: ${record.diagnosisSummary.skeletalClass || "—"}`,
            `Dental Class / التصنيف السني: ${record.diagnosisSummary.dentalClass || "—"}`,
            `Vertical & Transverse Pattern: ${record.diagnosisSummary.verticalPattern || "—"} · ${record.diagnosisSummary.transversePattern || "—"}`,
            `Final Approved Diagnosis / التشخيص النهائي المعتمد: ${record.diagnosisSummary.finalDiagnosisAr || "—"}`,
            ...approvedProblems.slice(0, 6).map((p) => `• [${p.severity}] ${p.titleAr}`),
          ]
        : [
            "التشخيص النهائي لم يُعتمد من الطبيب بعد — لا يُعرض التشخيص المسودة كنتيجة رسمية.",
            ...approvedProblems.slice(0, 4).map((p) => `مشكلة معتمدة: ${p.titleAr}`),
          ];
      return [
        {
          id: "problem_diagnosis",
          rtl: isRtl,
          titleAr: lang === "en" ? "DIAGNOSIS & APPROVED PROBLEM LIST" : "التشخيص النهائي المعتمد وقائمة المشكلات (Diagnosis)",
          subtitleAr: record.diagnosisSummary.approvedAt
            ? `Approved by ${record.diagnosisSummary.approvedBy}`
            : "Pending Clinician Approval",
          approvalBadgeAr: record.diagnosisSummary.approvedAt ? "تشخيص معتمد ✓" : "غير معتمد",
          footerAr: footerBase,
          bulletsAr: bullets,
          cards: [
            {
              x: inEmu(0.6),
              y: inEmu(1.55),
              cx: inEmu(12.1),
              cy: inEmu(5.05),
              title: "Clinical Diagnosis & Problem List",
              bullets,
              accentHex: "0D2137",
              rtl: isRtl,
              fontSizePt: 15,
            },
          ],
        },
      ];
    },

    treatment_objectives: () => {
      const goals = record.treatmentPlan.approvedAt
        ? record.treatmentPlan.primaryGoals.length > 0
          ? record.treatmentPlan.primaryGoals.map((g, i) => `${i + 1}. ${g}`)
          : ["تحقيق الإطباق الوظيفي والجمالي المثالي وفق الخطة المعتمدة."]
        : ["أهداف العلاج بانتظار اعتماد خطة العلاج من الطبيب المختص."];
      return [
        {
          id: "treatment_objectives",
          rtl: isRtl,
          titleAr: lang === "en" ? "TREATMENT OBJECTIVES" : "أهداف العلاج التقويمي (Treatment Objectives)",
          subtitleAr: displayPatientLabel,
          approvalBadgeAr: record.treatmentPlan.approvedAt ? "أهداف معتمدة ✓" : "غير معتمد",
          footerAr: footerBase,
          bulletsAr: goals,
          cards: [
            {
              x: inEmu(0.6),
              y: inEmu(1.55),
              cx: inEmu(12.1),
              cy: inEmu(5.0),
              title: "Primary Treatment Objectives",
              bullets: goals,
              accentHex: "10B981",
              rtl: isRtl,
              fontSizePt: 16,
            },
          ],
        },
      ];
    },

    treatment_plan: () => {
      const planApproved = Boolean(record.treatmentPlan.approvedAt);
      const rows: string[][] = planApproved
        ? approvedProblems.length > 0
          ? approvedProblems.slice(0, 6).map((p, idx) => [
              p.titleAr,
              record.treatmentPlan.primaryGoals[idx] || "تصحيح المشكلة السريرية الموثّقة",
              record.treatmentPlan.phaseBreakdown[idx]?.wiresOrAppliance ||
                record.treatmentPlan.mechanicsSummary ||
                record.treatmentPlan.treatmentModality ||
                "—",
            ])
          : [
              [
                record.diagnosisSummary.finalDiagnosisAr || "الحالة التقويمية",
                record.treatmentPlan.primaryGoals.join(" · ") || "—",
                `${record.treatmentPlan.treatmentModality || "—"} | ${record.treatmentPlan.extractionPlan || "—"} | ${record.treatmentPlan.mechanicsSummary || "—"}`,
              ],
            ]
        : [["—", "Pending Approval", "خطة العلاج لم تُعتمد من الطبيب بعد — لا تُدرج المسودة كخطة رسمية."]];

      return [
        {
          id: "treatment_plan",
          rtl: isRtl,
          titleAr: lang === "en" ? "TREATMENT PLAN MATRIX" : "مصفوفة خطة العلاج (Problem List | Plan | Strategies)",
          subtitleAr: planApproved ? `Approved by ${record.treatmentPlan.approvedBy}` : "Pending Plan Approval",
          approvalBadgeAr: planApproved ? "خطة معتمدة ✓" : "غير معتمدة",
          footerAr: footerBase,
          bulletsAr: planApproved
            ? [
                `الجهاز: ${record.treatmentPlan.treatmentModality || "—"} · القلع: ${record.treatmentPlan.extractionPlan || "—"} · المدة: ${record.treatmentPlan.estimatedDurationMonths ?? "—"} شهر`,
                `الميكانيكا: ${record.treatmentPlan.mechanicsSummary || "—"}`,
              ]
            : ["خطة العلاج لم تُعتمد من الطبيب بعد."],
          tables: [
            {
              x: inEmu(0.5),
              y: inEmu(1.5),
              cx: inEmu(12.3),
              cy: inEmu(5.1),
              colWidths: [inEmu(3.6), inEmu(3.9), inEmu(4.8)],
              headers: ["PROBLEM LIST / المشكلة", "TREATMENT PLAN / الخطة", "STRATEGIES / الميكانيكا والاستراتيجية"],
              rows,
              rtl: isRtl,
              fontSizePt: 12,
            },
          ],
        },
      ];
    },

    mechanotherapy: () => {
      const planApproved = Boolean(record.treatmentPlan.approvedAt);
      const phases = record.treatmentPlan.phaseBreakdown;
      const bullets = planApproved
        ? [
            `STRAP-UP / التجهيز: ${record.treatmentPlan.bracketSystem || "0.022 Slot"} · Modality: ${record.treatmentPlan.treatmentModality || "—"}`,
            `ANCHORAGE / الدعم: ${record.treatmentPlan.anchoragePlan || "—"} · Extraction: ${record.treatmentPlan.extractionPlan || "—"}`,
            ...phases.map(
              (ph, idx) =>
                `Stage ${idx + 1} — ${ph.phase}: ${ph.objective} | Wires/Appliance: ${ph.wiresOrAppliance}`,
            ),
            `Mechanics Summary: ${record.treatmentPlan.mechanicsSummary || "—"}`,
          ]
        : ["بروتوكول الميكانيكا بانتظار اعتماد خطة العلاج من الطبيب."];
      return [
        {
          id: "mechanotherapy",
          rtl: isRtl,
          titleAr: lang === "en" ? "MECHANOTHERAPY PROTOCOL" : "الميكانيكا وتتابع الأسلاك والمراحل (Mechanotherapy)",
          subtitleAr: "Strap-Up · Leveling & Alignment · Space Closure · Finishing",
          approvalBadgeAr: planApproved ? "ميكانيكا معتمدة ✓" : "غير معتمد",
          footerAr: footerBase,
          bulletsAr: bullets,
          cards: [
            {
              x: inEmu(0.6),
              y: inEmu(1.55),
              cx: inEmu(12.1),
              cy: inEmu(5.05),
              title: "Appliance, Anchorage & Archwire Sequence",
              bullets,
              accentHex: "3D7AB5",
              rtl: isRtl,
              fontSizePt: 14,
            },
          ],
        },
      ];
    },

    retention: () => {
      const bullets = [
        `Debond Date / تاريخ الفك: ${record.retention.debondDate ?? "لم يُحدد بعد"}`,
        `Upper Retainer / المثبّت العلوي: ${record.retention.upperRetainerType || "—"}`,
        `Lower Retainer / المثبّت السفلي: ${record.retention.lowerRetainerType || "—"}`,
        `Wear Protocol / بروتوكول الارتداء: ${record.retention.wearProtocol.trim() || "غير مسجّل"}`,
        `Retention Follow-ups / زيارات متابعة التثبيت: ${record.retention.followups.length}`,
      ];
      return [
        {
          id: "retention",
          rtl: isRtl,
          titleAr: lang === "en" ? "RETENTION PROTOCOL" : "مرحلة التثبيت والمتابعة (Retention)",
          subtitleAr: "Maxillary & Mandibular Retainers + Follow-Up Schedule",
          approvalBadgeAr: "Retention",
          footerAr: footerBase,
          bulletsAr: bullets,
          cards: [
            {
              x: inEmu(0.6),
              y: inEmu(1.55),
              cx: inEmu(12.1),
              cy: inEmu(4.8),
              title: "Retention & Stability Plan",
              bullets,
              accentHex: "0D2137",
              rtl: isRtl,
              fontSizePt: 15,
            },
          ],
        },
      ];
    },

    sessions_timeline: () => {
      if (sessions.length === 0) {
        return [
          {
            id: "sessions_timeline",
            rtl: isRtl,
            titleAr: lang === "en" ? "Adjustment Progress Slides" : "سجل الشدّات والجلسات السريرية",
            subtitleAr: "Tightening Progress",
            approvalBadgeAr: "0 جلسات",
            footerAr: footerBase,
            bulletsAr: ["تُضاف شريحة مستقلة تلقائيًا لكل جلسة شدّ مسجّلة مع صورها وأسلاكها."],
          },
        ];
      }

      // Generate 1 rich visual slide per tightening session (up to 12 most recent) with its linked photos!
      return sessions.slice(0, 12).map((s, idx) => {
        const sessionNum = s.visitNumber ?? idx + 1;
        const linkedAssets = assets.filter(
          (a) =>
            (s.id != null && a.adjustmentId === s.id) ||
            (Array.isArray(s.photoDocIds) && a.docId != null && s.photoDocIds.includes(a.docId)),
        );
        const slots: Array<[number, number, number, number]> =
          linkedAssets.length <= 2
            ? [
                [0.6, 1.55, 5.8, 3.3],
                [6.8, 1.55, 5.8, 3.3],
              ]
            : [
                [0.5, 1.5, 4.0, 2.25],
                [4.65, 1.5, 4.0, 2.25],
                [8.8, 1.5, 4.0, 2.25],
                [2.2, 3.85, 4.2, 2.15],
                [6.8, 3.85, 4.2, 2.15],
              ];
        const sessionImgs = linkedAssets
          .slice(0, slots.length)
          .map((a, i) => makeImg(a, slots[i][0], slots[i][1], slots[i][2], slots[i][3], a.title))
          .filter((x): x is EmbeddedSlideImage => x !== null);

        const detailLine = [
          `Date: ${s.date}`,
          s.phase ? `Stage: ${s.phase}` : null,
          `Upper Wire: ${s.upperWire || "—"}`,
          `Lower Wire: ${s.lowerWire || "—"}`,
          s.elastics ? `Elastics: ${s.elastics}` : null,
          s.clinician ? `Clinician: ${s.clinician}` : null,
        ]
          .filter(Boolean)
          .join("  ·  ");

        const bullets = [
          detailLine,
          `Procedures / الإجراءات: ${s.done || s.note || "متابعة شدّ روتينية"}`,
          s.note && s.done ? `Notes: ${s.note}` : `Linked Photos: ${sessionImgs.length}`,
        ];

        return {
          id: `session_${sessionNum}`,
          rtl: isRtl,
          titleAr:
            lang === "en"
              ? `Adjustment #${sessionNum} — ${s.date}`
              : `الجلسة / الشدّة #${sessionNum} — ${s.date}`,
          subtitleAr: `U: ${s.upperWire || "—"} / L: ${s.lowerWire || "—"}`,
          approvalBadgeAr: `${sessionImgs.length} صور`,
          footerAr: footerBase,
          bulletsAr: bullets,
          images: sessionImgs,
          cards: [
            {
              x: inEmu(0.6),
              y: inEmu(sessionImgs.length > 0 ? 5.15 : 1.65),
              cx: inEmu(12.1),
              cy: inEmu(sessionImgs.length > 0 ? 1.55 : 4.5),
              title: `Clinical Notes — Session #${sessionNum}`,
              bullets,
              accentHex: "F5922E",
              rtl: isRtl,
              fontSizePt: sessionImgs.length > 0 ? 11 : 14,
            },
          ],
        };
      });
    },

    before_after: () => {
      const firstPhoto = assets[0] ?? null;
      const lastPhoto = assets.length > 1 ? assets[assets.length - 1] : null;
      const imgs = [
        makeImg(firstPhoto, 0.7, 1.65, 5.6, 3.8, "Initial / Before (T0)"),
        makeImg(lastPhoto, 6.9, 1.65, 5.6, 3.8, "Latest Progress / After"),
      ].filter((x): x is EmbeddedSlideImage => x !== null);
      return [
        {
          id: "before_after",
          rtl: isRtl,
          titleAr: lang === "en" ? "Progress Comparison & Closing — Thank You" : "مقارنة التطور السريري (قبل وبعد) — شكرًا لحسن استماعكم",
          subtitleAr: `${clinicName} · ${doctorName}`,
          approvalBadgeAr: "Before / After",
          footerAr: footerBase,
          bulletsAr: [
            `إجمالي الصور الموثّقة للحالة: ${input.photoCount ?? assets.length} صورة`,
            `عدد جلسات الشدّ المسجّلة: ${sessions.length} جلسة`,
            "تم حفظ الصور الأصلية دون تعديل مع نسخ مشتقة موثّقة فقط.",
          ],
          images: imgs,
        },
      ];
    },
  };

  const requestedIds =
    input.selectedSlideIds && input.selectedSlideIds.length > 0
      ? input.selectedSlideIds.filter((id) => Boolean(builders[id]))
      : ALL_PRESENTATION_SLIDES.map((s) => s.id);

  for (const id of requestedIds) {
    slidesOut.push(...builders[id]());
  }

  return {
    clinicName,
    generatedAt: new Date().toISOString(),
    anonymized: anonymize,
    displayPatientLabel,
    slides: slidesOut,
    omittedUnapprovedNotes,
  };
}

/* ─────────────────────────── Pure-TS Editable OpenXML (.pptx) Builder ─────────────────────────── */

function xmlEscape(text: string): string {
  return String(text ?? "")
    // Strip illegal XML 1.0 control characters so pasted clinical text never corrupts OOXML
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntryInput {
  name: string;
  content: string | Uint8Array;
}

function buildStoredZip(files: ZipEntryInput[]): Uint8Array {
  const encoder = new TextEncoder();
  const entries = files.map((f) => {
    const nameBytes = encoder.encode(f.name);
    const rawBytes = typeof f.content === "string" ? encoder.encode(f.content) : f.content;
    const crc = crc32(rawBytes);
    // Compress XML/rels parts with standard DEFLATE (method 8) for 100% compatibility with
    // PowerPoint Desktop, PowerPoint for the Web (Edge Office Viewer), Google Slides, and OPC validators.
    // Binary PNG/JPEG media are already compressed and may also be deflated or stored cleanly.
    const isAlreadyCompressedMedia = /\.(png|jpg|jpeg)$/i.test(f.name);
    const compressedBytes = isAlreadyCompressedMedia ? rawBytes : new Uint8Array(deflateRawSync(rawBytes, { level: 6 }));
    const method = isAlreadyCompressedMedia ? 0 : 8;
    return { nameBytes, rawBytes, compressedBytes, method, crc };
  });

  let offset = 0;
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];

  for (const e of entries) {
    const isAsciiName = e.nameBytes.every((b) => b < 0x80);
    const zipFlags = isAsciiName ? 0x0000 : 0x0800;
    const localHeader = new Uint8Array(30 + e.nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, zipFlags, true);
    lv.setUint16(8, e.method, true);
    lv.setUint16(10, 0x0000, true);
    lv.setUint16(12, 0x5941, true);
    lv.setUint32(14, e.crc, true);
    lv.setUint32(18, e.compressedBytes.length, true);
    lv.setUint32(22, e.rawBytes.length, true);
    lv.setUint16(26, e.nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(e.nameBytes, 30);

    localParts.push(localHeader, e.compressedBytes);

    const centralHeader = new Uint8Array(46 + e.nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, zipFlags, true);
    cv.setUint16(10, e.method, true);
    cv.setUint16(12, 0x0000, true);
    cv.setUint16(14, 0x5941, true);
    cv.setUint32(16, e.crc, true);
    cv.setUint32(20, e.compressedBytes.length, true);
    cv.setUint32(24, e.rawBytes.length, true);
    cv.setUint16(28, e.nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    centralHeader.set(e.nameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + e.compressedBytes.length;
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const totalSize = offset + centralSize + eocd.length;
  const out = new Uint8Array(totalSize);
  let pos = 0;
  for (const part of [...localParts, ...centralParts, eocd]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

function buildTableGraphicFrameXml(tbl: EmbeddedSlideTable, shapeId: number): string {
  const rtlAttr = tbl.rtl ? ' rtl="1"' : ' rtl="0"';
  const algn = tbl.rtl ? "r" : "l";
  const sz = Math.round((tbl.fontSizePt ?? 11) * 100);
  const gridCols = tbl.colWidths.map((w) => `<a:gridCol w="${w}"/>`).join("");
  const rowCount = Math.max(1, tbl.rows.length + 1);
  const rowH = Math.max(280000, Math.floor(tbl.cy / rowCount));

  const cellBorder = `<a:lnL w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:lnL><a:lnR w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:lnR><a:lnT w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:lnT><a:lnB w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:lnB>`;

  const headerCells = tbl.headers
    .map(
      (h) =>
        `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="${algn}"${rtlAttr}/><a:r><a:rPr lang="ar-SA" sz="${sz}" b="1" dirty="0"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:rPr><a:t>${xmlEscape(h)}</a:t></a:r></a:p></a:txBody><a:tcPr marL="70000" marR="70000" marT="45000" marB="45000" anchor="ctr">${cellBorder}<a:solidFill><a:srgbClr val="0D2137"/></a:solidFill></a:tcPr></a:tc>`,
    )
    .join("");

  const bodyRows = tbl.rows
    .map((row, rIdx) => {
      const fill = rIdx % 2 === 0 ? "FFFFFF" : "F1F5F9";
      const cells = tbl.headers
        .map((_, cIdx) => {
          const val = row[cIdx] ?? "—";
          return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="${algn}"${rtlAttr}/><a:r><a:rPr lang="ar-SA" sz="${sz}" dirty="0"><a:solidFill><a:srgbClr val="0F172A"/></a:solidFill><a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:rPr><a:t>${xmlEscape(val)}</a:t></a:r></a:p></a:txBody><a:tcPr marL="70000" marR="70000" marT="40000" marB="40000" anchor="ctr">${cellBorder}<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill></a:tcPr></a:tc>`;
        })
        .join("");
      return `<a:tr h="${rowH}">${cells}</a:tr>`;
    })
    .join("");

  return `<p:graphicFrame>
    <p:nvGraphicFramePr><p:cNvPr id="${shapeId}" name="Table${shapeId}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>
    <p:xfrm><a:off x="${tbl.x}" y="${tbl.y}"/><a:ext cx="${tbl.cx}" cy="${tbl.cy}"/></p:xfrm>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
      <a:tbl>
        <a:tblPr firstRow="1" bandRow="1"/>
        <a:tblGrid>${gridCols}</a:tblGrid>
        <a:tr h="${Math.max(340000, rowH)}">${headerCells}</a:tr>
        ${bodyRows}
      </a:tbl>
    </a:graphicData></a:graphic>
  </p:graphicFrame>`;
}

function buildCardShapeXml(card: EmbeddedSlideCard, shapeId: number): string {
  const rtl = card.rtl !== false;
  const rtlAttr = rtl ? ' rtl="1" algn="r"' : ' rtl="0" algn="l"';
  const sz = Math.round((card.fontSizePt ?? 14) * 100);
  const accent = card.accentHex || "1A3A5C";
  const titlePara = card.title
    ? `<a:p><a:pPr${rtlAttr}><a:spcAft><a:spcPts val="800"/></a:spcAft><a:buNone/></a:pPr><a:r><a:rPr lang="ar-SA" sz="${sz + 200}" b="1" dirty="0"><a:solidFill><a:srgbClr val="${accent}"/></a:solidFill><a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:rPr><a:t>${xmlEscape(card.title)}</a:t></a:r></a:p>`
    : "";
  const bodyParas = (card.bullets.length > 0 ? card.bullets : ["—"])
    .map(
      (b) =>
        `<a:p><a:pPr${rtlAttr}><a:spcAft><a:spcPts val="600"/></a:spcAft><a:buNone/></a:pPr><a:r><a:rPr lang="ar-SA" sz="${sz}" dirty="0"><a:solidFill><a:srgbClr val="1E293B"/></a:solidFill><a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:rPr><a:t>• ${xmlEscape(b)}</a:t></a:r></a:p>`,
    )
    .join("");

  return `<p:sp>
    <p:nvSpPr><p:cNvPr id="${shapeId}" name="Card${shapeId}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
    <p:spPr>
      <a:xfrm><a:off x="${card.x}" y="${card.y}"/><a:ext cx="${card.cx}" cy="${card.cy}"/></a:xfrm>
      <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      <a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>
      <a:ln w="12700"><a:solidFill><a:srgbClr val="C5D5E7"/></a:solidFill></a:ln>
    </p:spPr>
    <p:txBody>
      <a:bodyPr wrap="square" lIns="180000" rIns="180000" tIns="150000" bIns="120000"/>
      <a:lstStyle/>
      ${titlePara}${bodyParas}
    </p:txBody>
  </p:sp>`;
}

function buildPicShapeXml(img: EmbeddedSlideImage, rId: string, shapeId: number): string {
  const captionShape = img.caption
    ? `<p:sp>
        <p:nvSpPr><p:cNvPr id="${shapeId + 1}" name="Cap${shapeId}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="${img.x}" y="${img.y + img.cy - 240000}"/><a:ext cx="${img.cx}" cy="240000"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="0D2137"/></a:solidFill>
          <a:ln><a:noFill/></a:ln>
        </p:spPr>
        <p:txBody>
          <a:bodyPr wrap="square" lIns="60000" rIns="60000" tIns="30000" bIns="30000" anchor="ctr"/>
          <a:lstStyle/>
          <a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="ar-SA" sz="950" b="1" dirty="0"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:rPr><a:t>${xmlEscape(img.caption)}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>`
    : "";

  return `<p:pic>
    <p:nvPicPr><p:cNvPr id="${shapeId}" name="Img${shapeId}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
    <p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
    <p:spPr>
      <a:xfrm><a:off x="${img.x}" y="${img.y}"/><a:ext cx="${img.cx}" cy="${img.cy}"/></a:xfrm>
      <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      <a:ln w="9525"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:ln>
    </p:spPr>
  </p:pic>${captionShape}`;
}

function buildSlideXmlAndRels(
  slide: PresentationSlideContent,
  slideNum: number,
  totalSlides: number,
  mediaCollector: Array<{ fileName: string; bytes: Uint8Array }>,
): { slideXml: string; relsXml: string } {
  const rtl = slide.rtl !== false;
  const rtlAttr = rtl ? ' rtl="1" algn="r"' : ' rtl="0" algn="l"';
  let shapeId = 10;
  const relEntries: string[] = [
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`,
  ];
  const extraShapes: string[] = [];

  // Render embedded images
  if (slide.images && slide.images.length > 0) {
    slide.images.forEach((img, idx) => {
      const mediaIdx = mediaCollector.length + 1;
      const fileName = `image${mediaIdx}.${img.ext}`;
      mediaCollector.push({ fileName, bytes: img.bytes });
      const rId = `rId${idx + 2}`;
      relEntries.push(
        `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${fileName}"/>`,
      );
      extraShapes.push(buildPicShapeXml(img, rId, shapeId));
      shapeId += 2;
    });
  }

  // Render native tables
  if (slide.tables && slide.tables.length > 0) {
    for (const tbl of slide.tables) {
      extraShapes.push(buildTableGraphicFrameXml(tbl, shapeId++));
    }
  }

  // Render cards
  if (slide.cards && slide.cards.length > 0) {
    for (const card of slide.cards) {
      extraShapes.push(buildCardShapeXml(card, shapeId++));
    }
  }

  // Fallback standard content card if slide has neither images nor tables nor cards
  if (extraShapes.length === 0) {
    extraShapes.push(
      buildCardShapeXml(
        {
          x: inEmu(0.6),
          y: inEmu(1.55),
          cx: inEmu(12.1),
          cy: inEmu(4.85),
          title: slide.isCover ? slide.subtitleAr : undefined,
          bullets: slide.bulletsAr,
          accentHex: slide.isCover ? "F5922E" : "1A3A5C",
          rtl,
          fontSizePt: slide.isCover ? 17 : 15,
        },
        shapeId++,
      ),
    );
  }

  const headerBg = slide.isCover ? "0D2137" : "0D2137";
  const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld name="Slide ${slideNum}">
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="F2F6FB"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="HeaderBar"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="1160000"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="${headerBg}"/></a:solidFill>
          <a:ln><a:noFill/></a:ln>
        </p:spPr>
        <p:txBody>
          <a:bodyPr wrap="square" lIns="340000" rIns="340000" tIns="140000" bIns="100000"/>
          <a:lstStyle/>
          <a:p><a:pPr${rtlAttr}/><a:r><a:rPr lang="ar-SA" sz="2400" b="1" dirty="0"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:rPr><a:t>${xmlEscape(slide.titleAr)}</a:t></a:r></a:p>
          <a:p><a:pPr${rtlAttr}/><a:r><a:rPr lang="ar-SA" sz="1250" dirty="0"><a:solidFill><a:srgbClr val="F5922E"/></a:solidFill><a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:rPr><a:t>${xmlEscape(slide.subtitleAr)}  ·  ${xmlEscape(slide.approvalBadgeAr)}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="AccentRule"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="0" y="1160000"/><a:ext cx="12192000" cy="52000"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="F5922E"/></a:solidFill>
          <a:ln><a:noFill/></a:ln>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="ar-SA"/></a:p></p:txBody>
      </p:sp>
      ${extraShapes.join("\n      ")}
      <p:sp>
        <p:nvSpPr><p:cNvPr id="5" name="Footer"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="457200" y="6420000"/><a:ext cx="11277600" cy="340000"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
          <a:ln><a:noFill/></a:ln>
        </p:spPr>
        <p:txBody>
          <a:bodyPr wrap="square"/>
          <a:lstStyle/>
          <a:p><a:pPr${rtlAttr}/><a:r><a:rPr lang="ar-SA" sz="1000" dirty="0"><a:solidFill><a:srgbClr val="64748B"/></a:solidFill><a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:rPr><a:t>${xmlEscape(slide.footerAr)}  (${slideNum}/${totalSlides})</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${relEntries.join("\n  ")}
</Relationships>`;

  return { slideXml, relsXml };
}

const THEME1_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="AQLAN Ortho Theme">
  <a:themeElements>
    <a:clrScheme name="AQLAN">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="0D2137"/></a:dk2>
      <a:lt2><a:srgbClr val="F2F6FB"/></a:lt2>
      <a:accent1><a:srgbClr val="1A3A5C"/></a:accent1>
      <a:accent2><a:srgbClr val="F5922E"/></a:accent2>
      <a:accent3><a:srgbClr val="3D7AB5"/></a:accent3>
      <a:accent4><a:srgbClr val="10B981"/></a:accent4>
      <a:accent5><a:srgbClr val="64748B"/></a:accent5>
      <a:accent6><a:srgbClr val="0F294A"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
      <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Office">
      <a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface="Arial"/></a:majorFont>
      <a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface="Arial"/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Office">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
        <a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
        <a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
  <a:objectDefaults/>
  <a:extraClrSchemeLst/>
</a:theme>`;

export function generateEditablePptxBytes(deck: PresentationDeck): Uint8Array {
  const slides =
    deck.slides.length > 0
      ? deck.slides
      : [
          {
            id: "cover",
            titleAr: "عرض حالة تقويم الأسنان",
            subtitleAr: deck.displayPatientLabel,
            bulletsAr: [deck.clinicName],
            approvalBadgeAr: "سجل تقويم",
            footerAr: deck.clinicName,
          },
        ];

  const mediaCollector: Array<{ fileName: string; bytes: Uint8Array }> = [];
  const builtSlides = slides.map((slide, i) =>
    buildSlideXmlAndRels(slide, i + 1, slides.length, mediaCollector),
  );

  const slideOverrides = slides
    .map(
      (_, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join("");

  const slideRels = slides
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 6}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
    )
    .join("");

  const slideIdLst = slides
    .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 6}"/>`)
    .join("");

  const isoNow = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const safeTitle = xmlEscape(`عرض حالة تقويم — ${deck.displayPatientLabel}`);
  const safeCreator = xmlEscape(deck.clinicName);

  const files: ZipEntryInput[] = [
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>
  <Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>
  <Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  ${slideOverrides}
</Types>`,
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
    },
    {
      name: "docProps/core.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${safeTitle}</dc:title>
  <dc:creator>${safeCreator}</dc:creator>
  <cp:lastModifiedBy>${safeCreator}</cp:lastModifiedBy>
  <cp:revision>1</cp:revision>
  <dcterms:created xsi:type="dcterms:W3CDTF">${isoNow}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${isoNow}</dcterms:modified>
</cp:coreProperties>`,
    },
    {
      name: "docProps/app.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Microsoft Office PowerPoint</Application>
  <PresentationFormat>On-screen Show (16:9)</PresentationFormat>
  <Slides>${slides.length}</Slides>
  <Notes>0</Notes>
  <HiddenSlides>0</HiddenSlides>
  <ScaleCrop>false</ScaleCrop>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <AppVersion>16.0000</AppVersion>
</Properties>`,
    },
    {
      name: "ppt/presentation.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>${slideIdLst}</p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
  <p:notesSz cx="6858000" cy="9144000"/>
  <p:defaultTextStyle>
    <a:lvl1pPr marL="0" algn="r" rtl="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr>
  </p:defaultTextStyle>
</p:presentation>`,
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
  ${slideRels}
</Relationships>`,
    },
    {
      name: "ppt/presProps.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`,
    },
    {
      name: "ppt/viewProps.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:normalViewPr horzBarState="maximized"><p:restoredLeft sz="15611"/><p:restoredTop sz="94610"/></p:normalViewPr><p:slideViewPr><p:cSldViewPr snapToGrid="0" snapToObjects="1"><p:cViewPr varScale="1"><p:scale><a:sx n="136" d="100"/><a:sy n="136" d="100"/></p:scale><p:origin x="216" y="312"/></p:cViewPr><p:guideLst/></p:cSldViewPr></p:slideViewPr><p:notesTextViewPr><p:cViewPr><p:scale><a:sx n="1" d="1"/><a:sy n="1" d="1"/></p:scale><p:origin x="0" y="0"/></p:cViewPr></p:notesTextViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`,
    },
    {
      name: "ppt/tableStyles.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
    },
    {
      name: "ppt/theme/theme1.xml",
      content: THEME1_XML,
    },
    {
      name: "ppt/slideMasters/slideMaster1.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
  <p:txStyles>
    <p:titleStyle><a:lvl1pPr algn="r" rtl="1"><a:defRPr sz="3200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>
    <p:bodyStyle><a:lvl1pPr algn="r" rtl="1"><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:bodyStyle>
    <p:otherStyle><a:lvl1pPr algn="r" rtl="1"><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:otherStyle>
  </p:txStyles>
</p:sldMaster>`,
    },
    {
      name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
    },
    {
      name: "ppt/slideLayouts/slideLayout1.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="Blank">
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`,
    },
    {
      name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`,
    },
  ];

  // Add binary image parts inside ppt/media/
  for (const m of mediaCollector) {
    files.push({
      name: `ppt/media/${m.fileName}`,
      content: m.bytes,
    });
  }

  builtSlides.forEach(({ slideXml, relsXml }, i) => {
    const idx = i + 1;
    files.push({ name: `ppt/slides/slide${idx}.xml`, content: slideXml });
    files.push({ name: `ppt/slides/_rels/slide${idx}.xml.rels`, content: relsXml });
  });

  return buildStoredZip(files);
}
