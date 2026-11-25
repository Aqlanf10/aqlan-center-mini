import { describe, expect, it } from "vitest";
import {
  buildDefaultOrthoPrivacyPolicy,
  ORTHO_PERMISSIONS,
  ORTHO_SECTIONS,
  parseOrthoPrivacyPolicy,
  resolveOrthoAccess,
  validateOrthoPolicyMutation,
  type OrthoSubject,
} from "@/lib/ortho-privacy";

const OWNER: OrthoSubject = { userId: 1, username: "owner", role: "admin", isActive: true, isOwner: true };
const DELEGATED_ADMIN: OrthoSubject = { userId: 2, username: "manager", role: "admin", isActive: true };
const DOCTOR: OrthoSubject = { userId: 10, username: "dr-ali", role: "doctor", isActive: true, branch: "taiz-main", partyId: 7 };
const ASSISTANT: OrthoSubject = { userId: 11, username: "asst-noura", role: "assistant", isActive: true, branch: "taiz-main" };
const CASHIER: OrthoSubject = { userId: 12, username: "cashier-1", role: "cashier", isActive: true };
const ACCOUNTANT: OrthoSubject = { userId: 13, username: "acct-1", role: "accountant", isActive: true };

describe("ortho-privacy pure policy engine", () => {
  it("denies all ortho access by default to cashier, accountant, and inactive users", () => {
    const policy = buildDefaultOrthoPrivacyPolicy(OWNER.userId);
    for (const subject of [CASHIER, ACCOUNTANT, { ...DOCTOR, isActive: false }]) {
      const access = resolveOrthoAccess(policy, subject);
      expect(access.moduleVisible).toBe(false);
      for (const perm of ORTHO_PERMISSIONS) expect(access.permissions[perm]).toBe(false);
      for (const sec of ORTHO_SECTIONS) expect(access.sections[sec]).toBe(false);
    }
  });

  it("enforces explicit deny over allow across role, branch, user, doctor, case, and patient scopes", () => {
    const base = buildDefaultOrthoPrivacyPolicy(OWNER.userId);
    const policy = {
      ...base,
      rules: [
        {
          id: "allow-doctor-finance-temp",
          effect: "allow" as const,
          target: { userIds: [DOCTOR.userId], patientIds: [501] },
          permissions: ["finance.view" as const, "photos.view" as const],
        },
        {
          id: "deny-branch-finance",
          effect: "deny" as const,
          target: { branches: ["taiz-main"] },
          permissions: ["finance.view" as const],
        },
        {
          id: "deny-case-photos",
          effect: "deny" as const,
          target: { orthoCaseIds: [99] },
          permissions: ["photos.view" as const],
        },
      ],
    };

    const accessCase99 = resolveOrthoAccess(policy, DOCTOR, { patientId: 501, orthoCaseId: 99 });
    expect(accessCase99.permissions["finance.view"]).toBe(false);
    expect(accessCase99.permissions["photos.view"]).toBe(false);

    const accessCase100 = resolveOrthoAccess(policy, DOCTOR, { patientId: 501, orthoCaseId: 100 });
    expect(accessCase100.permissions["finance.view"]).toBe(false);
    expect(accessCase100.permissions["photos.view"]).toBe(true);
  });

  it("completely hides module, sections, fields, and operations when module.visible is denied for a doctor", () => {
    const base = buildDefaultOrthoPrivacyPolicy(OWNER.userId);
    const policy = {
      ...base,
      rules: [
        {
          id: "hide-ortho-from-doctor",
          effect: "deny" as const,
          target: { userIds: [DOCTOR.userId] },
          permissions: ["module.visible" as const],
        },
      ],
    };
    const access = resolveOrthoAccess(policy, DOCTOR, { patientId: 101, orthoCaseId: 11 });
    expect(access.moduleVisible).toBe(false);
    expect(access.permissions["records.read"]).toBe(false);
    expect(access.permissions["photos.view"]).toBe(false);
    expect(access.sections.sessions).toBe(false);
    expect(access.fields.previousPhotos).toBe(false);
  });

  it("supports blind create for assistant: can capture/upload photos without viewing prior photos, diagnosis, plan, or finance", () => {
    const policy = buildDefaultOrthoPrivacyPolicy(OWNER.userId);
    const access = resolveOrthoAccess(policy, ASSISTANT, { patientId: 101 });
    expect(access.moduleVisible).toBe(true);
    expect(access.permissions["records.blind_create"]).toBe(true);
    expect(access.permissions["photos.capture"]).toBe(true);
    expect(access.permissions["photos.upload"]).toBe(true);
    expect(access.permissions["sessions.record"]).toBe(true);
    // Strict blind isolation
    expect(access.permissions["records.read"]).toBe(false);
    expect(access.permissions["photos.view"]).toBe(false);
    expect(access.permissions["photos.download"]).toBe(false);
    expect(access.permissions["diagnosis.approve"]).toBe(false);
    expect(access.permissions["plan.approve"]).toBe(false);
    expect(access.permissions["finance.view"]).toBe(false);
    expect(access.fields.previousPhotos).toBe(false);
    expect(access.sections.diagnosis).toBe(false);
    expect(access.sections.plan).toBe(false);
  });

  it("automatically expires temporary grants after expiresAt", () => {
    const base = buildDefaultOrthoPrivacyPolicy(OWNER.userId);
    const policy = {
      ...base,
      rules: [
        {
          id: "temp-grant-asst-view",
          effect: "allow" as const,
          target: { userIds: [ASSISTANT.userId], patientIds: [101] },
          permissions: ["photos.view" as const],
          fields: ["previousPhotos" as const],
          expiresAt: "2026-11-26T12:00:00.000Z",
        },
      ],
    };

    const beforeExpiry = resolveOrthoAccess(policy, ASSISTANT, { patientId: 101 }, Date.parse("2026-11-26T11:59:59.000Z"));
    expect(beforeExpiry.permissions["photos.view"]).toBe(true);
    expect(beforeExpiry.fields.previousPhotos).toBe(true);

    const afterExpiry = resolveOrthoAccess(policy, ASSISTANT, { patientId: 101 }, Date.parse("2026-11-26T12:00:00.000Z"));
    expect(afterExpiry.permissions["photos.view"]).toBe(false);
    expect(afterExpiry.fields.previousPhotos).toBe(false);
    expect(afterExpiry.expiredRuleIds).toContain("temp-grant-asst-view");
  });

  it("protects owner and prevents self-escalation or unauthorized delegation by delegated managers", () => {
    const current = {
      ...buildDefaultOrthoPrivacyPolicy(OWNER.userId),
      revision: 3,
      delegatedManagerUserIds: [DELEGATED_ADMIN.userId],
    };

    // Owner cannot be locked out even if a rule targets ownerUserId
    const ownerCheck = resolveOrthoAccess(
      {
        ...current,
        rules: [{ id: "bad", effect: "deny", target: { userIds: [OWNER.userId] }, permissions: ["module.visible"] }],
      },
      OWNER,
    );
    expect(ownerCheck.isOwner).toBe(true);
    expect(ownerCheck.moduleVisible).toBe(true);

    // Non-delegated doctor cannot edit policy
    const docAttempt = validateOrthoPolicyMutation({
      actor: DOCTOR,
      current,
      next: current,
      expectedRevision: 3,
      reason: "attempt",
    });
    expect(docAttempt.ok).toBe(false);

    // Delegated manager cannot target owner or self-escalate or change delegatedManagerUserIds
    const selfEsc = validateOrthoPolicyMutation({
      actor: DELEGATED_ADMIN,
      current,
      next: {
        ...current,
        rules: [{ id: "self", effect: "allow", target: { userIds: [DELEGATED_ADMIN.userId] }, permissions: ["records.delete"] }],
      },
      expectedRevision: 3,
      reason: "self escalation",
    });
    expect(selfEsc.ok).toBe(false);

    const touchOwner = validateOrthoPolicyMutation({
      actor: DELEGATED_ADMIN,
      current,
      next: {
        ...current,
        rules: [{ id: "owner-deny", effect: "deny", target: { userIds: [OWNER.userId] }, permissions: ["module.visible"] }],
      },
      expectedRevision: 3,
      reason: "touch owner",
    });
    expect(touchOwner.ok).toBe(false);

    // Stale revision rejected with 409
    const stale = validateOrthoPolicyMutation({
      actor: OWNER,
      current,
      next: current,
      expectedRevision: 2,
      reason: "valid owner update",
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.status).toBe(409);

    // Valid owner update increments revision
    const ok = validateOrthoPolicyMutation({
      actor: OWNER,
      current,
      next: current,
      expectedRevision: 3,
      reason: "تحديث قواعد الصلاحيات",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.persisted.revision).toBe(4);
  });

  it("rejects malformed rules during parsing", () => {
    const parsed = parseOrthoPrivacyPolicy({
      rules: [{ id: "empty-target", effect: "deny", target: {}, permissions: ["module.visible"] }],
    });
    expect(parsed.ok).toBe(false);
  });
});
