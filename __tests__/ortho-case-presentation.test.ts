import { describe, expect, it } from "vitest";
import { createDefaultOrthoWorkspace } from "@/lib/ortho-workspace-types";
import {
  buildCasePresentationDeck,
  generateEditablePptxBytes,
} from "@/lib/ortho-case-presentation";

describe("One-Click Case Presentation PPTX/PDF (Package 5)", () => {
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

    expect(diagSlide.bulletsAr.join(" ")).not.toContain("مسودة تشخيص سرية غير معتمدة");
    expect(planSlide.bulletsAr.join(" ")).not.toContain("مسودة خطة غير معتمدة");
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

    // Generate genuine OpenXML PPTX archive bytes
    const pptx = generateEditablePptxBytes(deck);
    expect(pptx.byteLength).toBeGreaterThan(2000);
    // ZIP local file header magic bytes PK\x03\x04
    expect(pptx[0]).toBe(0x50);
    expect(pptx[1]).toBe(0x4b);
    expect(pptx[2]).toBe(0x03);
    expect(pptx[3]).toBe(0x04);

    const decoded = new TextDecoder().decode(pptx);
    expect(decoded).toContain("[Content_Types].xml");
    expect(decoded).toContain("ppt/presentation.xml");
    expect(decoded).toContain("ppt/slides/slide1.xml");
    expect(decoded).toContain("ppt/slides/slide4.xml");
    expect(decoded).not.toContain("اسم مريض حقيقي سري");
    expect(decoded).not.toContain("P-SECRET-999");
  });
});
