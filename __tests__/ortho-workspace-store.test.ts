import { describe, expect, it } from "vitest";
import {
  DECIDUOUS_FDI_TEETH,
  ORTHO_WORKSPACE_TABS,
  PERMANENT_FDI_TEETH,
  computeOrthoWorkspaceCompleteness,
  createDefaultOrthoWorkspace,
} from "@/lib/ortho-workspace-types";
import { filterWorkspaceByPrivacy, workspaceStorageKey } from "@/lib/ortho-workspace-store";
import {
  buildDefaultOrthoPrivacyPolicy,
  resolveOrthoAccess,
} from "@/lib/ortho-privacy";

describe("Unified Advanced Orthodontic Workspace (Package 3)", () => {
  it("preserves exact OrthoCore 10-tab sequential clinical ordering", () => {
    expect(ORTHO_WORKSPACE_TABS.map((t) => t.id)).toEqual([
      "overview",
      "questionnaire",
      "exam",
      "media",
      "analysis",
      "diagnosis",
      "plan",
      "sessions",
      "retention",
      "reports",
    ]);
  });

  it("includes full FDI permanent (32) and deciduous (20) tooth charts", () => {
    expect(PERMANENT_FDI_TEETH).toHaveLength(32);
    expect(DECIDUOUS_FDI_TEETH).toHaveLength(20);
    expect(PERMANENT_FDI_TEETH).toContain(11);
    expect(PERMANENT_FDI_TEETH).toContain(48);
    expect(DECIDUOUS_FDI_TEETH).toContain(55);
    expect(DECIDUOUS_FDI_TEETH).toContain(85);
  });

  it("computes workspace completeness deterministically", () => {
    const rec = createDefaultOrthoWorkspace(101);
    expect(computeOrthoWorkspaceCompleteness(rec).percent).toBe(0);

    rec.questionnaire.chiefComplaint = "ازدحام أمامي";
    rec.clinicalExam.extraoral.profileType = "convex";
    rec.clinicalExam.intraoral.molarRight = "Class II div 1";
    rec.clinicalExam.teeth["11"] = { fdi: 11, dentition: "permanent", status: "present", widthMm: 8.5 };
    const mid = computeOrthoWorkspaceCompleteness(rec);
    expect(mid.completedCount).toBe(4);
    expect(mid.percent).toBe(50);
  });

  it("strips unauthorized clinical sections and fields server-side via filterWorkspaceByPrivacy", () => {
    const rec = createDefaultOrthoWorkspace(55);
    rec.questionnaire.chiefComplaint = "بروز علوي";
    rec.questionnaire.medicalAlertsSummary = "حساسية بنسلين";
    rec.clinicalExam.extraoral.notes = "ملاحظة سريرية حساسة";
    rec.diagnosisSummary.finalDiagnosisAr = "Class II Skeletal";
    rec.treatmentPlan.mechanicsSummary = "Fixed MBT + TADs";
    rec.retention.wearProtocol = "Essix 22h/day";
    rec.presentation.presenterNotes = "ملاحظة داخلية خاصة";

    const policy = buildDefaultOrthoPrivacyPolicy(1);
    // Receptionist should not see clinical diagnosis/plan/retention/exam/medicalHistory
    const access = resolveOrthoAccess(
      policy,
      {
        userId: 9,
        username: "reception1",
        role: "reception",
        isActive: true,
        branch: null,
        partyId: null,
        isOwner: false,
      },
      { patientId: 55 },
    );

    const { filtered, hiddenSections } = filterWorkspaceByPrivacy(rec, access);
    expect(hiddenSections).toContain("diagnosis");
    expect(hiddenSections).toContain("plan");
    expect(hiddenSections).toContain("retention");
    expect(filtered.diagnosisSummary.finalDiagnosisAr).toBe("");
    expect(filtered.treatmentPlan.mechanicsSummary).toBe("");
    expect(filtered.retention.wearProtocol).toBe("");
    expect(filtered.questionnaire.medicalAlertsSummary).toBe("");
    expect(filtered.clinicalExam.extraoral.notes).toBe("");
    expect(filtered.presentation.presenterNotes).toBe("");
  });

  it("generates stable PostgreSQL settings storage keys per patient", () => {
    expect(workspaceStorageKey(42)).toBe("ortho.workspace.v1.p.42");
  });
});
