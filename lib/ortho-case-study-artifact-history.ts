import type { DbClient } from "./db";
import { journeyFail, type JourneyOwner } from "./ortho-case-journey-authority";
import { journeyHash, journeyId } from "./ortho-case-journey-records";
import { checkStudyArtifactChain, STUDY_ARTIFACT_LIMITS, type ArtifactFormat, type ArtifactFailure, type ArtifactTransition, type StudyArtifactEvent } from "./ortho-case-study-artifact-chain";
export interface ArtifactManifestIdentity {
  id: number; patientId: number; orthoCaseId: number; clinicalCaseId: number;
  contentHash: string; renderingContractHash: string; formats: ArtifactFormat[];
}
export interface StudyArtifactRow extends Record<string, unknown> {
  id: unknown; patient_id: unknown; recorded_patient_id: unknown; ortho_case_id: unknown; clinical_case_id: unknown;
  manifest_id: unknown; manifest_sha256: unknown; rendering_contract_sha256: unknown; format: unknown;
  version: unknown; predecessor_id: unknown; attempt_id: unknown; transition: unknown;
  actor_user_id: unknown; attempt_actor_user_id: unknown; created_at: unknown; command_id: unknown; request_fingerprint: unknown;
  lease_token: unknown; lease_until: unknown; operation_deadline: unknown; failure_code: unknown;
  storage_key: unknown; file_sha256: unknown; size_bytes: unknown; mime_type: unknown;
}
function stamp(raw: unknown): number {
  const ms = raw instanceof Date ? raw.getTime() : typeof raw === "string" ? Date.parse(raw) : NaN;
  if (!Number.isSafeInteger(ms) || ms < 0) journeyFail(500, "invalid_artifact_timestamp"); return ms;
}
export function decodeArtifactRows(rows: readonly StudyArtifactRow[], owner: JourneyOwner, manifest: ArtifactManifestIdentity,
  format: ArtifactFormat): { events: StudyArtifactEvent[]; head: StudyArtifactEvent | null } {
  if (manifest.patientId !== owner.patientId || manifest.orthoCaseId !== owner.orthoCaseId || manifest.clinicalCaseId !== owner.clinicalCaseId
    || !manifest.formats.includes(format)) journeyFail(500, "invalid_artifact_manifest_scope");
  const commands = new Set<string>();
  const events = rows.map(row => {
    if (row.patient_id !== owner.patientId || row.ortho_case_id !== owner.orthoCaseId || row.clinical_case_id !== owner.clinicalCaseId
      || !journeyId(row.recorded_patient_id) || row.manifest_id !== manifest.id || row.manifest_sha256 !== manifest.contentHash
      || row.rendering_contract_sha256 !== manifest.renderingContractHash || row.format !== format
      || !journeyId(row.id) || !journeyId(row.version) || !journeyId(row.actor_user_id) || !journeyId(row.attempt_actor_user_id)
      || !(row.predecessor_id === null || journeyId(row.predecessor_id)) || typeof row.attempt_id !== "string"
      || typeof row.transition !== "string" || !["queued", "claimed", "renewed", "failed", "expired", "completed"].includes(row.transition)
      || typeof row.command_id !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(row.command_id) || !journeyHash(row.request_fingerprint)
      || !(row.lease_token === null || typeof row.lease_token === "string")
      || !(row.failure_code === null || typeof row.failure_code === "string")) journeyFail(500, "invalid_artifact_row");
    const command = `${row.actor_user_id}:${row.command_id}`;
    if (commands.has(command)) journeyFail(500, "duplicate_artifact_command"); commands.add(command);
    let artifact: StudyArtifactEvent["artifact"] = null;
    if (row.storage_key !== null) {
      if (typeof row.storage_key !== "string" || !journeyHash(row.file_sha256) || !journeyId(row.size_bytes) || typeof row.mime_type !== "string") journeyFail(500, "invalid_artifact_output");
      artifact = { storageKey: row.storage_key, sha256: row.file_sha256, bytes: row.size_bytes, mimeType: row.mime_type };
    } else if (row.file_sha256 !== null || row.size_bytes !== null || row.mime_type !== null) journeyFail(500, "incomplete_artifact_output");
    const event: StudyArtifactEvent = { id: row.id, manifestId: manifest.id, manifestHash: manifest.contentHash,
      renderingContractHash: manifest.renderingContractHash, format, version: row.version, predecessorId: row.predecessor_id,
      attemptId: row.attempt_id, attemptActorId: row.attempt_actor_user_id, actorId: row.actor_user_id,
      transition: row.transition as ArtifactTransition, createdAtMs: stamp(row.created_at), leaseToken: row.lease_token,
      leaseUntilMs: row.lease_until === null ? null : stamp(row.lease_until), operationDeadlineMs: row.operation_deadline === null ? null : stamp(row.operation_deadline),
      failureCode: row.failure_code as ArtifactFailure | null, artifact };
    return event;
  });
  const checked = checkStudyArtifactChain(events); if (!checked.ok) journeyFail(500, checked.code);
  return { events, head: checked.value };
}
/** Caller holds canonical authority/case locks and this exact manifest row. */
export async function readLockedArtifactHistory(client: DbClient, owner: JourneyOwner, manifest: ArtifactManifestIdentity, format: ArtifactFormat) {
  const { rows: [size] } = await client.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM ortho_case_study_artifact_events WHERE manifest_id=$1 AND format=$2", [manifest.id, format]);
  if (!size || !/^\d+$/.test(size.n)) journeyFail(500, "invalid_artifact_history_size");
  if (BigInt(size.n) > BigInt(STUDY_ARTIFACT_LIMITS.events)) journeyFail(409, "artifact_history_limit");
  const { rows } = await client.query<StudyArtifactRow>(
    "SELECT * FROM ortho_case_study_artifact_events WHERE manifest_id=$1 AND format=$2 ORDER BY version", [manifest.id, format]);
  return { rows, ...decodeArtifactRows(rows, owner, manifest, format) };
}

/** Deliberately excludes lease token, private path, command fingerprints and all
 * clinical projection content. Only an already authorized status route uses it. */
export function publicArtifactStatus(head: StudyArtifactEvent | null) {
  return head ? { version: head.version, state: head.transition, format: head.format, createdAt: new Date(head.createdAtMs).toISOString(),
    failureCode: head.failureCode, output: head.artifact ? { sha256: head.artifact.sha256, bytes: head.artifact.bytes, mimeType: head.artifact.mimeType } : null } : null;
}
