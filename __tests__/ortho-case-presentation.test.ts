import { describe, expect, it } from "vitest";
import { createDefaultOrthoWorkspace } from "@/lib/ortho-workspace-types";
import {
  ALL_PRESENTATION_SLIDES,
  buildCasePresentationDeck,
  generateEditablePptxBytes,
  type PresentationMediaAsset,
} from "@/lib/ortho-case-presentation";

// Valid minimal 1x1 PNG bytes for synthetic image embedding verification
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

describe("Academic Conference Case Presentation PPTX/PDF (Package 5)", () => {
  it("never presents unapproved draft diagnosis or treatment plan as official findings", () => {
    const rec = createDefaultOrthoWorkspace(77);
    rec.diagnosisSummary.finalDiagnosisAr = "مسودة تشخيص سرية غير معتمدة";
    rec.diagnosisSummary.approvedAt = null;
    rec.treatmentPlan.mechanicsSummary = "مسودة خطة غير معتمدة";
    rec.treatmentPlan.approvedAt = null;

    const deck = buildCasePresentationDeck({
      clinicName: "مركز الدكتور عقلان",
      patientName: "مريض افتراضي",
      patientCode: "P-9001",
      record: rec,
      anonymize: false,
    });

    const diagSlide = deck.slides.find((s) => s.id === "problem_diagnosis")!;
    const planSlide = deck.slides.find((s) => s.id === "treatment_plan")!;

    expect(JSON.stringify(diagSlide)).not.toContain("مسودة تشخيص سرية غير معتمدة");
    expect(JSON.stringify(planSlide)).not.toContain("مسودة خطة غير معتمدة");
    expect(deck.omittedUnapprovedNotes.length).toBeGreaterThanOrEqual(2);
  });

  it("includes approved diagnosis, plan, and analyses and scrubs patient identity when anonymized", () => {
    const rec = createDefaultOrthoWorkspace(88);
    rec.questionnaire.chiefComplaint = "ازدحام سفلي";
    rec.diagnosisSummary.finalDiagnosisAr = "Class I Crowding — معتمد";
    rec.diagnosisSummary.approvedBy = "dr_aqlan";
    rec.diagnosisSummary.approvedAt = "2026-11-25T10:00:00Z";
    rec.treatmentPlan.treatmentModality = "fixed_metallic";
    rec.treatmentPlan.primaryGoals = ["فك الازدحام وتصحيح الخط الوسطي"];
    rec.treatmentPlan.approvedBy = "dr_aqlan";
    rec.treatmentPlan.approvedAt = "2026-11-25T10:05:00Z";
    rec.approvedAnalyses.push({
      id: "an-1",
      type: "bolton",
      titleAr: "تحليل بولتون الأمامي",
      summaryAr: "متوازن 77.2%",
      values: { ratioPercent: 77.2 },
      approvedBy: "dr_aqlan",
      approvedAt: "2026-11-25T09:50:00Z",
      referenceCitation: "Bolton 1962",
    });

    const deck = buildCasePresentationDeck({
      clinicName: "مركز الدكتور عقلان",
      patientName: "اسم مريض حقيقي سري",
      patientCode: "P-SECRET-999",
      record: rec,
      selectedSlideIds: ["cover", "measurements", "problem_diagnosis", "treatment_plan"],
      anonymize: true,
    });

    expect(deck.slides.map((s) => s.id)).toEqual([
      "cover",
      "measurements",
      "problem_diagnosis",
      "treatment_plan",
    ]);

    const allText = JSON.stringify(deck);
    expect(allText).not.toContain("اسم مريض حقيقي سري");
    expect(allText).not.toContain("P-SECRET-999");
    expect(allText).toContain("Class I Crowding — معتمد");
    expect(allText).toContain("تحليل بولتون الأمامي");

    const pptx = generateEditablePptxBytes(deck);
    expect(pptx.byteLength).toBeGreaterThan(2000);
    expect(pptx[0]).toBe(0x50);
    expect(pptx[1]).toBe(0x4b);
    expect(pptx[2]).toBe(0x03);
    expect(pptx[3]).toBe(0x04);

    const decoded = new TextDecoder().decode(pptx);
    expect(decoded).toContain("[Content_Types].xml");
    expect(decoded).toContain("ppt/presentation.xml");
    expect(decoded).toContain("ppt/theme/theme1.xml");
    expect(decoded).toContain("ppt/viewProps.xml");
    expect(decoded).toContain("<p:origin ");
    expect(decoded).toContain("ppt/slides/slide1.xml");
    expect(decoded).toContain("ppt/slides/slide4.xml");
    expect(decoded).not.toContain("اسم مريض حقيقي سري");
    expect(decoded).not.toContain("P-SECRET-999");
  });

  it("embeds real clinical photos, traced overlays, native PowerPoint tables, and per-adjustment slides in full MSD conference order", () => {
    const rec = createDefaultOrthoWorkspace(99);
    rec.diagnosisSummary.finalDiagnosisAr = "Skeletal Class I with Moderate Crowding";
    rec.diagnosisSummary.approvedBy = "dr_demo";
    rec.diagnosisSummary.approvedAt = "2026-11-26T10:00:00Z";
    rec.treatmentPlan.primaryGoals = ["Align arches", "Correct overjet and overbite"];
    rec.treatmentPlan.approvedBy = "dr_demo";
    rec.treatmentPlan.approvedAt = "2026-11-26T10:05:00Z";
    rec.problems.push({
      id: "prob-1",
      category: "dental",
      titleAr: "Moderate lower anterior crowding (-4.5 mm)",
      detailsAr: "Arch length discrepancy -4.5 mm",
      severity: "moderate",
      source: "manual",
      approved: true,
    });

    const mediaAssets: PresentationMediaAsset[] = [
      { id: "m1", docId: 101, title: "Frontal Rest", viewType: "extraoral_frontal_rest", stage: "T0", bytes: TINY_PNG, ext: "png" },
      { id: "m2", docId: 102, title: "Frontal Smile", viewType: "extraoral_frontal_smile", stage: "T0", bytes: TINY_PNG, ext: "png" },
      { id: "m3", docId: 103, title: "Right Profile", viewType: "extraoral_profile", stage: "T0", bytes: TINY_PNG, ext: "png" },
      { id: "m4", docId: 104, title: "Intraoral Frontal", viewType: "intraoral_frontal", stage: "T0", adjustmentId: 501, bytes: TINY_PNG, ext: "png" },
      { id: "m5", docId: 105, title: "OPG", viewType: "opg", stage: "T0", bytes: TINY_PNG, ext: "png" },
      { id: "m6", docId: 106, title: "Lateral Ceph", viewType: "lateral_ceph", stage: "T0", bytes: TINY_PNG, ext: "png" },
    ];

    const deck = buildCasePresentationDeck({
      clinicName: "AQLAN Orthodontic Center",
      patientName: "Synthetic Conference Case",
      patientCode: "P-CONF-01",
      patientAgeGender: "19y / F",
      doctorName: "Dr. Saleem Ortho (Test)",
      record: rec,
      anonymize: false,
      lang: "en",
      mediaAssets,
      tracedOverlays: {
        ceph: { bytes: TINY_PNG, ext: "png" },
        profile: { bytes: TINY_PNG, ext: "png" },
      },
      sessionSummaries: [
        {
          id: 501,
          visitNumber: 1,
          date: "2026-10-28",
          phase: "aligning",
          upperWire: "0.014 NiTi",
          lowerWire: "0.014 NiTi",
          done: "Initial bonding U/L 6-6",
          photoDocIds: [104],
        },
        {
          id: 502,
          visitNumber: 2,
          date: "2026-11-27",
          phase: "aligning",
          upperWire: "0.016 NiTi",
          lowerWire: "0.016 NiTi",
          done: "Wire progression",
          photoDocIds: [],
        },
      ],
    });

    // Full 23 sections + 1 extra slide because there are 2 tightening sessions (23 - 1 + 2 = 24)
    expect(ALL_PRESENTATION_SLIDES.length).toBe(23);
    expect(deck.slides.length).toBe(24);
    expect(deck.slides.some((s) => s.id === "session_1")).toBe(true);
    expect(deck.slides.some((s) => s.id === "session_2")).toBe(true);

    const pptx = generateEditablePptxBytes(deck);
    const decoded = new TextDecoder().decode(pptx);
    expect(decoded).toContain("ppt/media/image1.png");
    expect(decoded).toContain("<p:pic>");
    expect(decoded).toContain("<a:tbl>");
    expect(decoded).toContain("ppt/slides/slide24.xml");
  });
});
