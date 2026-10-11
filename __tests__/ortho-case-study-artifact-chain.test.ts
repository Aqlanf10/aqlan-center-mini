import { describe, expect, it } from "vitest";
import { checkStudyArtifactChain, type StudyArtifactEvent } from "../lib/ortho-case-study-artifact-chain";
const queued: StudyArtifactEvent = { id: 1, manifestId: 11, manifestHash: "a".repeat(64), renderingContractHash: "b".repeat(64),
  format: "pptx", version: 1, predecessorId: null, attemptId: "00000000-0000-4000-8000-000000000001", attemptActorId: 7, actorId: 7,
  transition: "queued", createdAtMs: 1000, leaseToken: null, leaseUntilMs: null, operationDeadlineMs: null, failureCode: null, artifact: null };
const claimed: StudyArtifactEvent = { ...queued, id: 2, version: 2, predecessorId: 1, transition: "claimed", createdAtMs: 1001,
  leaseToken: "00000000-0000-4000-8000-000000000002", leaseUntilMs: 2000, operationDeadlineMs: 10000 };
const completed: StudyArtifactEvent = { ...claimed, id: 3, version: 3, predecessorId: 2, transition: "completed", createdAtMs: 1500,
  artifact: { sha256: "c".repeat(64), storageKey: `cc/cc/${"c".repeat(64)}.pptx`, bytes: 100,
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" } };
const expired: StudyArtifactEvent = { ...claimed, id: 3, version: 3, predecessorId: 2, transition: "expired", createdAtMs: 2000,
  failureCode: "lease_expired", actorId: 8 };
function refused(events: StudyArtifactEvent[], code: string) { expect(checkStudyArtifactChain(events)).toEqual({ ok: false, code }); }
describe("append-only artifact lease evidence (authority remains a store gate)", () => {
  it("requires queue and claim to commit together", () => refused([queued], "artifact_claim_missing"));
  it("accepts an exact owned active attempt", () => expect(checkStudyArtifactChain([queued, claimed])).toEqual({ ok: true, value: claimed }));
  it("binds completed output to the exact manifest, format and content-addressed artifact", () => {
    expect(checkStudyArtifactChain([queued, claimed, completed])).toEqual({ ok: true, value: completed });
    refused([queued, claimed, { ...completed, manifestHash: "d".repeat(64) }], "artifact_scope_changed");
    refused([queued, claimed, { ...completed, artifact: { ...completed.artifact!, bytes: 33554433 } }], "invalid_artifact_output");
  });
  it("does not publish at or after expiry", () => refused([queued, claimed, { ...completed, createdAtMs: 2000 }], "artifact_lease_expired"));
  it("preserves the old attempt owner and token when another authorized actor records expiry", () => {
    expect(checkStudyArtifactChain([queued, claimed, expired])).toEqual({ ok: true, value: expired });
    refused([queued, claimed, { ...expired, attemptActorId: 8 }], "invalid_artifact_lease");
    refused([queued, claimed, { ...expired, leaseToken: "00000000-0000-4000-8000-000000000009" }], "artifact_lease_lost");
  });
  it("refuses recovery before server expiry", () => refused([queued, claimed, { ...expired, createdAtMs: 1999 }], "artifact_lease_not_expired"));
  it("never transfers completion privilege to the recovery actor", () => refused([queued, claimed, { ...completed, actorId: 8 }], "artifact_attempt_owner_required"));
  it("renews only a live lease within its original operation cap", () => {
    const renewed: StudyArtifactEvent = { ...claimed, id: 3, version: 3, predecessorId: 2, transition: "renewed", createdAtMs: 1500, leaseUntilMs: 3000 };
    expect(checkStudyArtifactChain([queued, claimed, renewed])).toEqual({ ok: true, value: renewed });
    refused([queued, claimed, { ...renewed, operationDeadlineMs: 11000 }], "artifact_lease_lost");
    refused([queued, claimed, { ...renewed, leaseUntilMs: 11000 }], "invalid_artifact_lease");
  });
  it("permits a fresh owner-bound attempt only after explicit terminal expiry", () => {
    const next: StudyArtifactEvent = { ...queued, id: 4, version: 4, predecessorId: 3, attemptId: "00000000-0000-4000-8000-000000000003",
      actorId: 8, attemptActorId: 8, createdAtMs: 2001 };
    const claim: StudyArtifactEvent = { ...claimed, id: 5, version: 5, predecessorId: 4, attemptId: next.attemptId,
      actorId: 8, attemptActorId: 8, createdAtMs: 2002, leaseUntilMs: 3000, operationDeadlineMs: 11000,
      leaseToken: "00000000-0000-4000-8000-000000000004" };
    expect(checkStudyArtifactChain([queued, claimed, expired, next, claim])).toEqual({ ok: true, value: claim });
    refused([queued, claimed, { ...next, id: 3, version: 3, predecessorId: 2 }], "invalid_artifact_retry");
  });
  it("never retries or adds a second publication after completion", () => refused([queued, claimed, completed,
    { ...queued, id: 4, version: 4, predecessorId: 3, createdAtMs: 2000 }], "invalid_artifact_retry"));
  it("refuses skipped versions and reused attempt roots", () => {
    refused([queued, { ...claimed, version: 3 }], "invalid_artifact_lineage");
    refused([queued, claimed, expired, { ...queued, id: 4, version: 4, predecessorId: 3, createdAtMs: 2000 }], "invalid_artifact_retry");
  });
});
