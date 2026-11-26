/**
 * AQLAN Center Mini — One-Click Case Presentation Engine (Approved-Only + Editable PPTX)
 *
 * Guarantees:
 * 1. ONLY approved clinical analyses, approved problems, approved diagnosis, and approved plans
 *    are included as official clinical findings. Unapproved drafts are NEVER presented as valid results.
 * 2. Anonymization mode scrubs patient full name and file code across every slide & metadata field.
 * 3. Generates a genuine, editable OpenXML PowerPoint (.pptx) archive (16:9 widescreen, RTL Arabic)
 *    using zero external dependencies so it stays completely deterministic and lockfile-safe.
 */

import type { OrthoWorkspaceRecord } from "./ortho-workspace-types";

export interface CasePresentationSlideDef {
  id: string;
  titleAr: string;
  subtitleAr: string;
}

export const ALL_PRESENTATION_SLIDES: readonly CasePresentationSlideDef[] = [
  { id: "cover", titleAr: "غلاف عرض الحالة", subtitleAr: "هوية مركز الدكتور عقلان وبيانات الحالة" },
  { id: "case_history", titleAr: "الشكوى الرئيسية والتاريخ الطبي", subtitleAr: "الاستبيان والعادات الفموية والمفصل الفكي" },
  { id: "facial_photos", titleAr: "التحليل الوجهي والصور خارج الفم", subtitleAr: "الفحص خارج الفم ونسب الأثلاث الوجهية" },
  { id: "intraoral_photos", titleAr: "الفحص داخل الفم والإطباق", subtitleAr: "علاقة الأرحاء والأنياب وOverjet/Overbite" },
  { id: "radiographs_ceph", titleAr: "الأشعة والسيفالومتري وCBCT", subtitleAr: "ضابط المعايرة والمعالم التشريحية" },
  { id: "measurements", titleAr: "القياسات والتحليلات المعتمدة", subtitleAr: "Bolton / Moyers / Tanaka-Johnston / Nance / Pont / Ashley Howe" },
  { id: "problem_diagnosis", titleAr: "قائمة المشكلات والتشخيص المعتمد", subtitleAr: "المشكلات المعتمدة والتشخيص التقويمي النهائي" },
  { id: "treatment_plan", titleAr: "أهداف وخطة العلاج والميكانيكا", subtitleAr: "الأهداف العلاجية والجهاز ومراحل التنفيذ" },
  { id: "sessions_timeline", titleAr: "مسار الشدّات والجلسات", subtitleAr: "تتابع الجلسات وتطور الأسلاك" },
  { id: "before_after", titleAr: "مقارنة قبل وبعد", subtitleAr: "ملخص التحسّن السريري والتوثيق البصري" },
  { id: "retention", titleAr: "مرحلة التثبيت والمتابعة", subtitleAr: "نوع المثبّت وبروتوكول الارتداء وزيارات المتابعة" },
] as const;

export interface PresentationSlideContent {
  id: string;
  titleAr: string;
  subtitleAr: string;
  bulletsAr: string[];
  approvalBadgeAr: string;
  footerAr: string;
}

export interface PresentationDeck {
  clinicName: string;
  generatedAt: string;
  anonymized: boolean;
  displayPatientLabel: string;
  slides: PresentationSlideContent[];
  omittedUnapprovedNotes: string[];
}

export function buildCasePresentationDeck(input: {
  clinicName: string;
  patientName: string;
  patientCode: string;
  record: OrthoWorkspaceRecord;
  selectedSlideIds?: string[];
  anonymize: boolean;
  sessionSummaries?: Array<{ date: string; upperWire?: string | null; lowerWire?: string | null; note?: string | null }>;
  photoCount?: number;
}): PresentationDeck {
  const { clinicName, record, anonymize } = input;
  const displayPatientLabel = anonymize
    ? `حالة تقويم تعليمية مُخفاة الهوية (مرجع داخلي #EDU-${record.patientId})`
    : `${input.patientName}${input.patientCode ? ` · ملف ${input.patientCode}` : ""}`;

  const footerBase = `${clinicName} — عرض حالة تقويم أسنان${anonymize ? " (نسخة تعليمية مُخفاة الهوية)" : ""}`;
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

  const approvedProblems = record.problems.filter((p) => p.approved);

  const slideBuilders: Record<string, () => PresentationSlideContent> = {
    cover: () => ({
      id: "cover",
      titleAr: "عرض حالة تقويم الأسنان (Case Presentation)",
      subtitleAr: displayPatientLabel,
      bulletsAr: [
        `المركز: ${clinicName}`,
        `مرحلة الإطباق: ${record.clinicalExam.dentitionStage === "permanent" ? "أسنان دائمة" : record.clinicalExam.dentitionStage === "mixed" ? "إطباق مختلط" : "أسنان لبنية"}`,
        `عدد التحليلات المعتمدة: ${record.approvedAnalyses.length}`,
        `عدد المشكلات المعتمدة: ${approvedProblems.length}`,
        anonymize
          ? "تم إخفاء جميع بيانات الهوية الشخصية للمريض وفق سياسة الخصوصية والموافقة التعليمية."
          : "وثيقة سريرية داخلية محمية بسياسة خصوصية المركز.",
      ],
      approvalBadgeAr: "سجل تقويم موحّد",
      footerAr: footerBase,
    }),

    case_history: () => ({
      id: "case_history",
      titleAr: "الشكوى الرئيسية والتاريخ الطبي",
      subtitleAr: "بيانات الاستبيان السريري",
      bulletsAr: [
        `الشكوى الرئيسية: ${record.questionnaire.chiefComplaint.trim() || "غير مسجّلة"}`,
        `توقعات المريض: ${record.questionnaire.patientExpectations.trim() || "غير مسجّلة"}`,
        `حالة النمو: ${record.questionnaire.growthStatus || "غير محددة"}`,
        `التنبيهات الطبية والحساسية: ${record.questionnaire.medicalAlertsSummary.trim() || record.questionnaire.allergies.trim() || "لا توجد تنبيهات مدوّنة"}`,
        `أعراض المفصل الفكي (TMJ): ${
          record.questionnaire.tmjSymptoms.clicking ||
          record.questionnaire.tmjSymptoms.pain ||
          record.questionnaire.tmjSymptoms.limitedOpening ||
          record.questionnaire.tmjSymptoms.deviation
            ? "موجودة — راجع تفاصيل الفحص"
            : "لا توجد أعراض مسجّلة"
        }`,
      ],
      approvalBadgeAr: "بيانات الاستبيان",
      footerAr: footerBase,
    }),

    facial_photos: () => ({
      id: "facial_photos",
      titleAr: "التحليل الوجهي والفحص خارج الفم",
      subtitleAr: "الخصائص الوجهية والابتسامة",
      bulletsAr: [
        `نمط الوجه: ${record.clinicalExam.extraoral.facialForm || "غير محدد"}`,
        `الجانب الوجهي (Profile): ${record.clinicalExam.extraoral.profileType || "غير محدد"}`,
        `إطباق الشفتين: ${record.clinicalExam.extraoral.lipCompetence || "غير محدد"}`,
        `قوس الابتسامة: ${record.clinicalExam.extraoral.smileArc || "غير محدد"}`,
        `معالم تحليل الصور الوجهية المسجّلة: ${Object.keys(record.facialPhoto.landmarks).length} معلم`,
      ],
      approvalBadgeAr: "فحص خارج الفم",
      footerAr: footerBase,
    }),

    intraoral_photos: () => ({
      id: "intraoral_photos",
      titleAr: "الفحص داخل الفم والإطباق",
      subtitleAr: "العلاقات السنية والأقواس",
      bulletsAr: [
        `علاقة الأرحاء: يمين (${record.clinicalExam.intraoral.molarRight || "—"}) · يسار (${record.clinicalExam.intraoral.molarLeft || "—"})`,
        `Overjet: ${record.clinicalExam.intraoral.overjetMm ?? "—"} مم · Overbite: ${record.clinicalExam.intraoral.overbiteMm ?? "—"} مم`,
        `العضّة المعكوسة الخلفية: ${record.clinicalExam.intraoral.crossbitePosterior}`,
        `Curve of Spee: ${record.clinicalExam.intraoral.curveOfSpeeMm ?? "—"} مم`,
        `عدد الصور الموثّقة في الأرشيف: ${input.photoCount ?? 0} صورة`,
      ],
      approvalBadgeAr: "فحص داخل الفم",
      footerAr: footerBase,
    }),

    radiographs_ceph: () => ({
      id: "radiographs_ceph",
      titleAr: "الأشعة والسيفالومتري وCBCT",
      subtitleAr: "تقييم المعايرة والأشعة المعتمدة",
      bulletsAr: [
        `نوع الشععة المسجّل: ${record.cbct.modality}`,
        `معايرة Pixel Spacing: ${record.cbct.pixelSpacingMm ? `${record.cbct.pixelSpacingMm} mm/px` : "غير معاير (لا تُعرض قياسات مليمترية)"}`,
        `الأسنان المنطمرة: ${record.cbct.impactionNotes.trim() || "لا توجد ملاحظات"}`,
        `امتصاص الجذور والعظم: ${record.cbct.rootResorptionNotes.trim() || "لا توجد ملاحظات"}`,
        `مجرى الهواء (Airway): ${record.cbct.airwayNotes.trim() || "لا توجد ملاحظات"}`,
      ],
      approvalBadgeAr: "توثيق شعاعي",
      footerAr: footerBase,
    }),

    measurements: () => ({
      id: "measurements",
      titleAr: "القياسات والتحليلات العلمية المعتمدة",
      subtitleAr: "تُعرض النتائج المعتمدة من الطبيب فقط",
      bulletsAr:
        record.approvedAnalyses.length > 0
          ? record.approvedAnalyses.slice(0, 6).map(
              (a) => `${a.titleAr}: ${a.summaryAr} [معتمد بواسطة ${a.approvedBy}]`,
            )
          : ["لا توجد قياسات أو تحليلات معتمدة بعد — لا تُدرج المسودات غير المعتمدة في العرض."],
      approvalBadgeAr: record.approvedAnalyses.length > 0 ? "نتائج معتمدة ✓" : "بانتظار الاعتماد",
      footerAr: footerBase,
    }),

    problem_diagnosis: () => ({
      id: "problem_diagnosis",
      titleAr: "قائمة المشكلات والتشخيص النهائي المعتمد",
      subtitleAr: "المشكلات المعتمدة والتصنيف التشخيصي",
      bulletsAr: record.diagnosisSummary.approvedAt
        ? [
            `التشخيص النهائي المعتمد: ${record.diagnosisSummary.finalDiagnosisAr || "—"}`,
            `التصنيف الهيكلي: ${record.diagnosisSummary.skeletalClass || "—"} · السني: ${record.diagnosisSummary.dentalClass || "—"}`,
            `النمط العمودي: ${record.diagnosisSummary.verticalPattern || "—"} · العرضي: ${record.diagnosisSummary.transversePattern || "—"}`,
            ...approvedProblems.slice(0, 4).map((p) => `مشكلة معتمدة (${p.severity}): ${p.titleAr}`),
          ]
        : [
            "التشخيص النهائي لم يُعتمد من الطبيب بعد — لا يُعرض التشخيص المسودة كنتيجة رسمية.",
            ...(approvedProblems.length > 0
              ? approvedProblems.slice(0, 3).map((p) => `مشكلة معتمدة: ${p.titleAr}`)
              : []),
          ],
      approvalBadgeAr: record.diagnosisSummary.approvedAt
        ? `معتمد بواسطة ${record.diagnosisSummary.approvedBy}`
        : "غير معتمد",
      footerAr: footerBase,
    }),

    treatment_plan: () => ({
      id: "treatment_plan",
      titleAr: "أهداف وخطة العلاج والأجهزة والميكانيكا",
      subtitleAr: "الخطة المعتمدة ومراحل التنفيذ",
      bulletsAr: record.treatmentPlan.approvedAt
        ? [
            `الجهاز العلاجي: ${record.treatmentPlan.treatmentModality || "—"} · القلع: ${record.treatmentPlan.extractionPlan || "—"}`,
            `الدعم (Anchorage): ${record.treatmentPlan.anchoragePlan || "—"} · المدة التقديرية: ${record.treatmentPlan.estimatedDurationMonths ?? "—"} شهر`,
            `الأهداف: ${record.treatmentPlan.primaryGoals.join(" | ") || "—"}`,
            `الميكانيكا: ${record.treatmentPlan.mechanicsSummary || "—"}`,
            ...record.treatmentPlan.phaseBreakdown
              .slice(0, 3)
              .map((ph) => `مرحلة ${ph.phase}: ${ph.objective} (${ph.wiresOrAppliance})`),
          ]
        : ["خطة العلاج لم تُعتمد من الطبيب بعد — لا تُدرج المسودة غير المعتمدة في العرض الرسمي."],
      approvalBadgeAr: record.treatmentPlan.approvedAt
        ? `خطة معتمدة بواسطة ${record.treatmentPlan.approvedBy}`
        : "غير معتمدة",
      footerAr: footerBase,
    }),

    sessions_timeline: () => ({
      id: "sessions_timeline",
      titleAr: "التسلسل الزمني للشدّات والجلسات",
      subtitleAr: "تطور الأسلاك والإجراءات اليومية",
      bulletsAr:
        input.sessionSummaries && input.sessionSummaries.length > 0
          ? input.sessionSummaries.slice(0, 6).map(
              (s, idx) =>
                `جلسة #${idx + 1} (${s.date}): سلك علوي ${s.upperWire || "—"} / سفلي ${s.lowerWire || "—"}${s.note ? ` — ${s.note}` : ""}`,
            )
          : ["يتم تجميع جلسات الشدّ تلقائيًا من سجل الشدّات اليومي الموحّد عند تسجيلها."],
      approvalBadgeAr: "سجل الجلسات",
      footerAr: footerBase,
    }),

    before_after: () => ({
      id: "before_after",
      titleAr: "مقارنة التطور السريري (قبل وبعد)",
      subtitleAr: "توثيق الصور المربوطة بالشدّات",
      bulletsAr: [
        `إجمالي الصور المرتبطة بملف الحالة: ${input.photoCount ?? 0} صورة`,
        "يُحفظ الأصل دائمًا دون تعديل وتُنشأ نسخ مشتقة عند القص أو تصحيح الإضاءة فقط.",
        "راجع أداة مقارنة الجلسات في تبويب «الشدّات والجلسات» لعرض الصور المتقابلة بدقة كاملة.",
      ],
      approvalBadgeAr: "توثيق بصري آمن",
      footerAr: footerBase,
    }),

    retention: () => ({
      id: "retention",
      titleAr: "مرحلة التثبيت والمتابعة (Retention)",
      subtitleAr: "المثبّتات وزيارات ما بعد الفك",
      bulletsAr: [
        `تاريخ فك التقويم: ${record.retention.debondDate ?? "لم يُحدد بعد"}`,
        `المثبّت العلوي: ${record.retention.upperRetainerType || "—"} · المثبّت السفلي: ${record.retention.lowerRetainerType || "—"}`,
        `بروتوكول الارتداء: ${record.retention.wearProtocol.trim() || "غير مسجّل"}`,
        `زيارات متابعة التثبيت: ${record.retention.followups.length} زيارة`,
      ],
      approvalBadgeAr: "بروتوكول التثبيت",
      footerAr: footerBase,
    }),
  };

  const orderedIds =
    input.selectedSlideIds && input.selectedSlideIds.length > 0
      ? input.selectedSlideIds.filter((id) => Boolean(slideBuilders[id]))
      : ALL_PRESENTATION_SLIDES.map((s) => s.id);

  return {
    clinicName,
    generatedAt: new Date().toISOString(),
    anonymized: anonymize,
    displayPatientLabel,
    slides: orderedIds.map((id) => slideBuilders[id]()),
    omittedUnapprovedNotes,
  };
}

/* ─────────────────────────── Pure-TS Editable OpenXML (.pptx) Builder ─────────────────────────── */

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// CRC-32 table for standard ZIP archive headers
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

function buildStoredZip(files: Array<{ name: string; content: string }>): Uint8Array {
  const encoder = new TextEncoder();
  const entries = files.map((f) => {
    const nameBytes = encoder.encode(f.name);
    const dataBytes = encoder.encode(f.content);
    return { nameBytes, dataBytes, crc: crc32(dataBytes) };
  });

  let offset = 0;
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];

  for (const e of entries) {
    const localHeader = new Uint8Array(30 + e.nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // Local file header signature
    lv.setUint16(4, 20, true); // Version needed (2.0)
    lv.setUint16(6, 0, true); // General purpose bit flag (ASCII OPC entry names)
    lv.setUint16(8, 0, true); // Compression method 0 (stored)
    lv.setUint16(10, 0x0000, true); // DOS time
    lv.setUint16(12, 0x5941, true); // Valid DOS date
    lv.setUint32(14, e.crc, true);
    lv.setUint32(18, e.dataBytes.length, true);
    lv.setUint32(22, e.dataBytes.length, true);
    lv.setUint16(26, e.nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(e.nameBytes, 30);

    localParts.push(localHeader, e.dataBytes);

    const centralHeader = new Uint8Array(46 + e.nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true); // Central directory signature
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0x0000, true);
    cv.setUint16(14, 0x5941, true);
    cv.setUint32(16, e.crc, true);
    cv.setUint32(20, e.dataBytes.length, true);
    cv.setUint32(24, e.dataBytes.length, true);
    cv.setUint16(28, e.nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    centralHeader.set(e.nameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + e.dataBytes.length;
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

function buildSlideXml(slide: PresentationSlideContent, slideNum: number, totalSlides: number): string {
  const safeBullets = slide.bulletsAr.length > 0 ? slide.bulletsAr : ["—"];
  const bulletsXml = safeBullets
    .map(
      (line) =>
        `<a:p><a:pPr rtl="1" algn="r"><a:spcAft><a:spcPts val="1000"/></a:spcAft><a:buNone/></a:pPr><a:r><a:rPr lang="ar-SA" sz="1800" dirty="0"><a:solidFill><a:srgbClr val="1E293B"/></a:solidFill><a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:rPr><a:t>• ${xmlEscape(line)}</a:t></a:r></a:p>`,
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld name="Slide ${slideNum}">
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="F2F6FB"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="HeaderBar"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="1200000"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="0D2137"/></a:solidFill>
          <a:ln><a:noFill/></a:ln>
        </p:spPr>
        <p:txBody>
          <a:bodyPr wrap="square" lIns="360000" rIns="360000" tIns="160000" bIns="120000"/>
          <a:lstStyle/>
          <a:p><a:pPr rtl="1" algn="r"/><a:r><a:rPr lang="ar-SA" sz="2600" b="1" dirty="0"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:rPr><a:t>${xmlEscape(slide.titleAr)}</a:t></a:r></a:p>
          <a:p><a:pPr rtl="1" algn="r"/><a:r><a:rPr lang="ar-SA" sz="1300" dirty="0"><a:solidFill><a:srgbClr val="F5922E"/></a:solidFill><a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:rPr><a:t>${xmlEscape(slide.subtitleAr)}  ·  ${xmlEscape(slide.approvalBadgeAr)}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="AccentRule"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="0" y="1200000"/><a:ext cx="12192000" cy="55000"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="F5922E"/></a:solidFill>
          <a:ln><a:noFill/></a:ln>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="ar-SA"/></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="4" name="ContentBox"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="457200" y="1500000"/><a:ext cx="11277600" cy="4600000"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>
          <a:ln w="12700"><a:solidFill><a:srgbClr val="C5D5E7"/></a:solidFill></a:ln>
        </p:spPr>
        <p:txBody>
          <a:bodyPr wrap="square" lIns="300000" rIns="300000" tIns="240000" bIns="240000"/>
          <a:lstStyle/>
          ${bulletsXml}
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="5" name="Footer"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="457200" y="6280000"/><a:ext cx="11277600" cy="380000"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
          <a:ln><a:noFill/></a:ln>
        </p:spPr>
        <p:txBody>
          <a:bodyPr wrap="square"/>
          <a:lstStyle/>
          <a:p><a:pPr rtl="1" algn="r"/><a:r><a:rPr lang="ar-SA" sz="1100" dirty="0"><a:solidFill><a:srgbClr val="64748B"/></a:solidFill><a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:rPr><a:t>${xmlEscape(slide.footerAr)}  (${slideNum}/${totalSlides})</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
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

  const slideOverrides = slides
    .map(
      (_, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join("");

  const slideRels = slides
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 5}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
    )
    .join("");

  const slideIdLst = slides
    .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 5}"/>`)
    .join("");

  const isoNow = new Date().toISOString();
  const safeTitle = xmlEscape(`عرض حالة تقويم — ${deck.displayPatientLabel}`);
  const safeCreator = xmlEscape(deck.clinicName);

  const files: Array<{ name: string; content: string }> = [
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
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

  slides.forEach((slide, i) => {
    const idx = i + 1;
    files.push({
      name: `ppt/slides/slide${idx}.xml`,
      content: buildSlideXml(slide, idx, slides.length),
    });
    files.push({
      name: `ppt/slides/_rels/slide${idx}.xml.rels`,
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`,
    });
  });

  return buildStoredZip(files);
}
