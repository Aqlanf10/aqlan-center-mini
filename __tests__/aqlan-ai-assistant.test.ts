import { describe, expect, it } from "vitest";
import { createDefaultOrthoWorkspace } from "@/lib/ortho-workspace-types";
import {
  AQLAN_AI_BRAND,
  VERIFIED_ORTHO_REFERENCES,
  runLocalClinicalAssistant,
  validateExternalGeminiPayload,
} from "@/lib/aqlan-ai-local";

describe("AQLAN AI Assistant — عقلان المساعد الذكي (Package 6)", () => {
  it("uses the official approved branding", () => {
    expect(AQLAN_AI_BRAND.full).toBe("AQLAN AI Assistant — عقلان المساعد الذكي");
    expect(VERIFIED_ORTHO_REFERENCES.length).toBeGreaterThanOrEqual(6);
  });

  it("runs local clinical completeness audit and approved-only summary with zero external calls", () => {
    const rec = createDefaultOrthoWorkspace(12);
    rec.questionnaire.chiefComplaint = "ازدحام أمامي سفلي";
    rec.diagnosisSummary.finalDiagnosisAr = "مسودة غير معتمدة";
    rec.diagnosisSummary.approvedAt = null;

    const audit = runLocalClinicalAssistant("audit_completeness", rec);
    expect(audit.engine).toBe("local_clinical");
    expect(audit.itemsAr.join(" ")).toContain("24 معلمًا");
    expect(audit.disclaimerAr).toContain("لا يصدر قرارات تشخيصية");

    const approved = runLocalClinicalAssistant("approved_summary", rec);
    expect(approved.itemsAr.join(" ")).not.toContain("مسودة غير معتمدة");
    expect(approved.itemsAr.join(" ")).toContain("لم يُعتمد");

    const refs = runLocalClinicalAssistant("scientific_references", null);
    expect(refs.references?.some((r) => r.title.includes("Contemporary Orthodontics"))).toBe(true);
  });

  it("blocks ANY patient data, images, radiographs, or clinical prompts from external Gemini", () => {
    // 1. Forbidden structured field (patientId)
    expect(
      validateExternalGeminiPayload({
        intent: "educational_literature",
        query: "What is Bolton ratio?",
        patientId: 42,
      }).ok,
    ).toBe(false);

    // 2. Forbidden radiographs/photos field
    expect(
      validateExternalGeminiPayload({
        intent: "educational_literature",
        query: "Analyze cephalometric tracing",
        radiographs: ["ceph.jpg"],
      }).ok,
    ).toBe(false);

    // 3. Base64 image embedded in text
    expect(
      validateExternalGeminiPayload({
        intent: "educational_literature",
        query: "Check data:image/png;base64,iVBORw0KGgo=",
      }).ok,
    ).toBe(false);

    // 4. Arabic patient record phrase (even de-identified!)
    expect(
      validateExternalGeminiPayload({
        intent: "educational_literature",
        query: "اقترح خطة علاج لملف المريض ذي الازدحام الشديد",
      }).ok,
    ).toBe(false);

    // 5. Phone number or patient file ID
    expect(
      validateExternalGeminiPayload({
        intent: "admin_template",
        query: "Prepare reminder for P-1045 phone 777123456",
      }).ok,
    ).toBe(false);

    // 6. Unauthorized clinical intent
    expect(
      validateExternalGeminiPayload({
        intent: "clinical_diagnosis",
        query: "General orthodontic question",
      }).ok,
    ).toBe(false);
  });

  it("permits clean non-clinical educational literature and administrative template queries", () => {
    const edu = validateExternalGeminiPayload({
      intent: "educational_literature",
      query: "ما هي حدود استخدام مؤشر بونت وفق كتاب Contemporary Orthodontics مع المصدر والسنة؟",
    });
    expect(edu.ok).toBe(true);

    const admin = validateExternalGeminiPayload({
      intent: "admin_template",
      query: "رتّب قائمة تدقيق إدارية عامة لمتابعة مواعيد التثبيت الدورية في عيادة تقويم أسنان",
    });
    expect(admin.ok).toBe(true);
  });
});
