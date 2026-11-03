/** Pure checks used after current patient/section/export authority and manifest
 * locks. Passing them never authorizes access or publishes an artifact. */
import { journeyHash, journeyId, type Checked } from "./ortho-case-journey-records";
export type ArtifactFormat = "pptx" | "pdf";
export type ArtifactTransition = "queued" | "claimed" | "renewed" | "failed" | "expired" | "completed";
export type ArtifactFailure = "render_failed" | "capability_unavailable" | "resource_limit" | "authority_retired" | "lease_expired" | "output_invalid";
export interface StudyArtifactEvent {
  id: number; manifestId: number; manifestHash: string; renderingContractHash: string; format: ArtifactFormat;
  version: number; predecessorId: number | null; attemptId: string; attemptActorId: number; actorId: number;
  transition: ArtifactTransition; createdAtMs: number; leaseToken: string | null;
  leaseUntilMs: number | null; operationDeadlineMs: number | null; failureCode: ArtifactFailure | null;
  artifact: { storageKey: string; sha256: string; bytes: number; mimeType: string } | null;
}
export const STUDY_ARTIFACT_LIMITS = Object.freeze({ bytes: 32 * 1024 * 1024, operationMs: 15 * 60_000, events: 5000 });
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const stamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const no = (code: string): Checked<never> => ({ ok: false, code });
export function checkStudyArtifactChain(events: readonly StudyArtifactEvent[]): Checked<StudyArtifactEvent | null> {
  if (events.length > STUDY_ARTIFACT_LIMITS.events) return no("artifact_history_limit");
  let previous: StudyArtifactEvent | null = null;
  const identities = new Set<number>(), attempts = new Set<string>();
  for (const event of events) {
    if (!journeyId(event.id) || identities.has(event.id) || !journeyId(event.manifestId) || !journeyHash(event.manifestHash)
      || !journeyHash(event.renderingContractHash) || event.format !== "pdf" && event.format !== "pptx"
      || !journeyId(event.version) || !journeyId(event.actorId) || !journeyId(event.attemptActorId) || !uuid(event.attemptId)
      || !stamp(event.createdAtMs) || !["queued", "claimed", "renewed", "failed", "expired", "completed"].includes(event.transition)) return no("invalid_artifact_event");
    identities.add(event.id);
    if (event.version !== (previous?.version ?? 0) + 1 || event.predecessorId !== (previous?.id ?? null)) return no("invalid_artifact_lineage");
    if (previous && (event.manifestId !== previous.manifestId || event.manifestHash !== previous.manifestHash
      || event.renderingContractHash !== previous.renderingContractHash || event.format !== previous.format
      || event.createdAtMs < previous.createdAtMs)) return no("artifact_scope_changed");
    if (event.transition !== "expired" && event.actorId !== event.attemptActorId) return no("artifact_attempt_owner_required");
    if (event.transition === "queued") {
      if (attempts.has(event.attemptId) || previous && previous.transition !== "failed" && previous.transition !== "expired"
        || event.leaseToken !== null || event.leaseUntilMs !== null || event.operationDeadlineMs !== null) return no("invalid_artifact_retry");
      attempts.add(event.attemptId);
    } else {
      if (!previous || event.attemptId !== previous.attemptId || event.attemptActorId !== previous.attemptActorId
        || !uuid(event.leaseToken) || !stamp(event.leaseUntilMs) || !stamp(event.operationDeadlineMs)
        || event.leaseUntilMs > event.operationDeadlineMs) return no("invalid_artifact_lease");
      if (event.transition === "claimed") {
        if (previous.transition !== "queued" || event.leaseUntilMs <= event.createdAtMs || event.operationDeadlineMs <= event.createdAtMs
          || event.operationDeadlineMs > event.createdAtMs + STUDY_ARTIFACT_LIMITS.operationMs) return no("invalid_artifact_claim");
      } else {
        if (previous.transition !== "claimed" && previous.transition !== "renewed"
          || event.leaseToken !== previous.leaseToken || event.operationDeadlineMs !== previous.operationDeadlineMs) return no("artifact_lease_lost");
        if (event.transition === "renewed") {
          if (event.createdAtMs >= previous.leaseUntilMs! || event.leaseUntilMs <= previous.leaseUntilMs!) return no("invalid_artifact_renewal");
        } else {
          if (event.leaseUntilMs !== previous.leaseUntilMs) return no("artifact_terminal_lease_changed");
          if (event.transition === "expired") {
            if (event.createdAtMs < previous.leaseUntilMs! || event.failureCode !== "lease_expired") return no("artifact_lease_not_expired");
          } else if (event.createdAtMs >= previous.leaseUntilMs!) return no("artifact_lease_expired");
        }
      }
    }
    if (event.transition === "failed" || event.transition === "expired") {
      if (typeof event.failureCode !== "string" || !["render_failed", "capability_unavailable", "resource_limit", "authority_retired", "lease_expired", "output_invalid"].includes(event.failureCode)) return no("invalid_artifact_failure");
    } else if (event.failureCode !== null) return no("unexpected_artifact_failure");
    if (event.transition === "completed") {
      const artifact = event.artifact;
      if (!artifact || !journeyHash(artifact.sha256) || !journeyId(artifact.bytes) || artifact.bytes > STUDY_ARTIFACT_LIMITS.bytes
        || artifact.storageKey !== `${artifact.sha256.slice(0, 2)}/${artifact.sha256.slice(2, 4)}/${artifact.sha256}.${event.format}`
        || artifact.mimeType !== (event.format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation")) return no("invalid_artifact_output");
    } else if (event.artifact !== null) return no("unexpected_artifact_output");
    previous = event;
  }
  // The store appends both rows within one transaction and the deferred SQL
  // constraint independently rejects an orphan queue at commit.
  if (previous?.transition === "queued") return no("artifact_claim_missing");
  return { ok: true, value: previous };
}
