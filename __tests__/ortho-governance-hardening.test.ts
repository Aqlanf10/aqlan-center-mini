import { describe, expect, it } from "vitest";
import {
  buildDefaultOrthoPrivacyPolicy,
  resolveOrthoAccess,
  type OrthoSubject,
} from "@/lib/ortho-privacy";
import { createDefaultOrthoWorkspace } from "@/lib/ortho-workspace-types";
import { filterWorkspaceByPrivacy, workspaceScopeKey } from "@/lib/ortho-workspace-store";
import { validateExternalGeminiPayload } from "@/lib/aqlan-ai-local";
import { ORTHO_AUXILIARY_KEYS, ORTHO_AUXILIARY_LABEL } from "@/lib/ortho-auxiliaries";

describe("Orthodontic Governance, Privacy Precedence & Zero-Leak Scrubbing", () => {
  it("scopes workspace storage deterministically per (patientId, orthoCaseId)", () => {
    expect(workspaceScopeKey(null)).toBe("intake");
    expect(workspaceScopeKey(undefined)).toBe("intake");
    expect(workspaceScopeKey(42)).toBe("case:42");
  });

  it("enforces explicit Deny > explicit Allow > Role default > Fail-closed", () => {
    const policy = buildDefaultOrthoPrivacyPolicy(1);
    policy.rules.push(
      {
        id: "allow-user-7",
        effect: "allow",
        target: { userIds: [7] },
        permissions: ["records.read", "photos.view"],
        sections: ["media"],
      },
      {
        id: "deny-user-7-photos",
        effect: "deny",
        target: { userIds: [7] },
        permissions: ["photos.view"],
        sections: ["media"],
      },
    );

    const subject: OrthoSubject = {
      userId: 7,
      username: "dr.test",
      role: "doctor",
      isActive: true,
      isOwner: false,
    };

    const access = resolveOrthoAccess(policy, subject, {}, Date.parse("2026-11-27T10:00:00Z"));
    expect(access.permissions["records.read"]).toBe(true);
    expect(access.permissions["photos.view"]).toBe(false);
    expect(access.sections["media"]).toBe(false);
  });

  it("automatically expires temporary allow rules by server clock", () => {
    const policy = buildDefaultOrthoPrivacyPolicy(1);
    policy.roleDefaults.reception.permissions["records.reopen"] = false;
    policy.rules.push({
      id: "temp-allow",
      effect: "allow",
      target: { userIds: [11] },
      permissions: ["presentation.create"],
      expiresAt: "2026-11-27T08:00:00Z",
    });

    const subject: OrthoSubject = {
      userId: 11,
      username: "rec.test",
      role: "reception",
      isActive: true,
      isOwner: false,
    };

    const beforeExpiry = resolveOrthoAccess(policy, subject, {}, Date.parse("2026-11-27T07:30:00Z"));
    expect(beforeExpiry.permissions["presentation.create"]).toBe(true);

    const afterExpiry = resolveOrthoAccess(policy, subject, {}, Date.parse("2026-11-27T08:01:00Z"));
    expect(afterExpiry.permissions["presentation.create"]).toBe(false);
    expect(afterExpiry.expiredRuleIds).toContain("temp-allow");
  });

  it("deeply scrubs orthoCoreCase and blind-create payloads with zero leakage", () => {
    const policy = buildDefaultOrthoPrivacyPolicy(1);
    policy.roleDefaults.assistant = {
      permissions: { "module.visible": true, "records.blind_create": true },
      sections: { overview: true, medical_history: true, exam: true },
      fields: { medicalHistory: true },
    };

    const subject: OrthoSubject = {
      userId: 12,
      username: "asst.test",
      role: "assistant",
      isActive: true,
      isOwner: false,
    };

    const access = resolveOrthoAccess(policy, subject);
    expect(access.permissions["records.read"]).toBe(false);
    expect(access.permissions["records.blind_create"]).toBe(true);

    const record = createDefaultOrthoWorkspace(101, 5);
    record.questionnaire.chiefComplaint = "بروز شديد في الأسنان الأمامية";
    record.diagnosisSummary.finalDiagnosisAr = "صنف ثانٍ هيكلي";
    record.orthoCoreCase = {
      secretDiagnosis: "بيانات سريرية مخفية",
      media: [{ id: "m1", url: "/api/documents/99" }],
    };

    const { filtered } = filterWorkspaceByPrivacy(record, access);
    expect(filtered.questionnaire.chiefComplaint).toBe("");
    expect(filtered.diagnosisSummary.finalDiagnosisAr).toBe("");
    expect(filtered.orthoCoreCase ?? null).toBeNull();
  });

  it("deeply strips hidden sections inside orthoCoreCase when records.read is granted but media/finance/diagnosis are denied", () => {
    const policy = buildDefaultOrthoPrivacyPolicy(1);
    policy.roleDefaults.doctor = {
      permissions: { "module.visible": true, "records.read": true },
      sections: {
        overview: true,
        medical_history: true,
        exam: true,
        media: false,
        ceph: false,
        photo_analysis: false,
        model3d: false,
        measurements: false,
        diagnosis: false,
        plan: false,
        sessions: true,
        retention: true,
        reports: false,
        ai_assistant: false,
      },
      fields: {
        medicalHistory: true,
        clinicalNotes: false,
        previousPhotos: false,
        financialBalances: false,
        internalNotes: false,
        identityFields: true,
      },
    };

    const access = resolveOrthoAccess(policy, {
      userId: 9,
      username: "dr.limited",
      role: "doctor",
      isActive: true,
      isOwner: false,
    });

    const record = createDefaultOrthoWorkspace(202, 8);
    record.orthoCoreCase = {
      patientName: "مريض اختبار",
      media: [{ id: "photo-1", viewType: "frontal" }],
      cephAnalyses: [{ id: "ceph-1" }],
      analyses: [{ id: "an-1" }],
      problems: [{ id: "prob-1" }],
      diagnosis: { skeletalClass: "II" },
      treatmentPlan: { goals: ["retraction"] },
      financialSummary: { total: 500000 },
      privateNotes: "ملاحظة خاصة بالطبيب المالك",
    };

    const { filtered } = filterWorkspaceByPrivacy(record, access);
    const core = filtered.orthoCoreCase as Record<string, unknown>;
    expect(core).toBeTruthy();
    expect(core.media).toEqual([]);
    expect(core.cephAnalyses).toEqual([]);
    expect(core.analyses).toEqual([]);
    expect(core.problems).toEqual([]);
    expect(core.diagnosis).toBeUndefined();
    expect(core.treatmentPlan).toBeUndefined();
    expect(core.financialSummary).toBeUndefined();
    expect(core.privateNotes).toBe("");
  });

  it("enforces Structural Zero-PHI on external AI queries", () => {
    expect(
      validateExternalGeminiPayload({
        intent: "educational_literature",
        query: "What is Bolton anterior ratio mean and standard deviation?",
        patientId: 15,
      }),
    ).toEqual({
      ok: false,
      code: "PHI_EXTERNAL_BLOCKED",
      reasonAr: expect.stringContaining("patientId"),
    });

    expect(
      validateExternalGeminiPayload({
        intent: "educational_literature",
        query: "راجع حالة المريض رقم BRW-07429 واقترح خطة القلع",
      }),
    ).toEqual({
      ok: false,
      code: "PHI_EXTERNAL_BLOCKED",
      reasonAr: expect.any(String),
    });

    expect(
      validateExternalGeminiPayload({
        intent: "educational_literature",
        query: "Explain Moyers probability table assumptions in mixed dentition",
      }),
    ).toEqual({
      ok: true,
      intent: "educational_literature",
      query: "Explain Moyers probability table assumptions in mixed dentition",
    });
  });

  it("provides the 17-item clinical orthodontic auxiliaries catalog (proposal 0132)", () => {
    expect(ORTHO_AUXILIARY_KEYS.length).toBe(17);
    expect(ORTHO_AUXILIARY_LABEL.power_chain).toBe("Power Chain");
    expect(ORTHO_AUXILIARY_LABEL.tad).toBe("TAD / Mini-screw");
  });
});
