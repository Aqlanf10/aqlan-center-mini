import { describe, expect, it } from "vitest";
import { followupCoverageJournal, restoreFollowupCoverage, readFollowupCoverageReceipt, isFollowupCoverageRejection, type FollowupCoverageAttempt } from "../lib/ortho-followup-coverage-recovery";
const attempt: FollowupCoverageAttempt = { actor: "synthetic-admin", patientId: 1, orthoCaseId: 2, command: {
  schemaVersion: 1, commandId: "12345678-1234-4123-8123-123456789012", expectedRevisionId: null,
  source: { patientId: 1, orthoCaseId: 2, clinicalCaseId: 3, planId: 4, planItemId: 5, invoiceId: 6 },
  expectedSourceFingerprint: "a".repeat(64), scope: "routine_adjustments", decision: "included", reason: "Synthetic agreed scope",
} };
const receipt = () => ({ id: "9", version: 1, supersedesRevisionId: null, source: { ...attempt.command.source }, sourceFingerprint: attempt.command.expectedSourceFingerprint,
  decision: "included", reason: attempt.command.reason, createdAt: "2026-10-26T00:00:00Z", createdBy: attempt.actor, commandId: attempt.command.commandId });
const rejection = () => ({ state: "rejected", rejection: { terminal: true, commandId: attempt.command.commandId, actor: attempt.actor,
  patientId: 1, orthoCaseId: 2, code: "source_changed", message: "Synthetic source change", rejectedAt: "2026-10-26T00:00:00Z", command: structuredClone(attempt.command) } });
describe("durable exact orthodontic scope recovery", () => {
  it("round trips only the exact actor/patient/case and immutable body", () => {
    const saved = followupCoverageJournal(attempt);
    expect(restoreFollowupCoverage(saved, attempt.actor, 1)).toEqual(attempt);
    expect(restoreFollowupCoverage(saved, "other", 1)).toBeNull();expect(restoreFollowupCoverage(saved, attempt.actor, 2)).toBeNull();
    expect(restoreFollowupCoverage({ ...saved, payload: "{}" }, attempt.actor, 1)).toBeNull();
    expect(restoreFollowupCoverage({ ...saved, key: "another-command" }, attempt.actor, 1)).toBeNull();
  });
  it("accepts a fully matching receipt, never merely a matching key", () => {
    expect(readFollowupCoverageReceipt(receipt(), attempt)).toEqual(receipt());
    expect(readFollowupCoverageReceipt({ commandId: attempt.command.commandId }, attempt)).toBeNull();
  });
  it.each(["patientId", "orthoCaseId", "clinicalCaseId", "planId", "planItemId", "invoiceId"])("rejects changed receipt source %s", key => {
    const r = receipt();r.source = { ...r.source, [key]: 99 };expect(readFollowupCoverageReceipt(r, attempt)).toBeNull();
  });
  it.each(["sourceFingerprint", "decision", "reason", "createdBy", "commandId", "supersedesRevisionId", "createdAt"])("rejects changed receipt %s", key => {
    expect(readFollowupCoverageReceipt({ ...receipt(), [key]: "different" }, attempt)).toBeNull();
  });
  it("requires exact permanent rejection identity and canonical original command", () => {
    expect(isFollowupCoverageRejection(rejection(), attempt)).toBe(true);
    for (const [key, value] of Object.entries({ terminal: false, actor: "other", patientId: 2, orthoCaseId: 3, commandId: "other", code: "forbidden", rejectedAt: "invalid" })) {
      expect(isFollowupCoverageRejection({ state: "rejected", rejection: { ...rejection().rejection, [key]: value } }, attempt)).toBe(false);
    }
    const altered = rejection();altered.rejection.command.reason = "A different request";expect(isFollowupCoverageRejection(altered, attempt)).toBe(false);
    expect(isFollowupCoverageRejection({ state: "unresolved" }, attempt)).toBe(false);
  });
});
