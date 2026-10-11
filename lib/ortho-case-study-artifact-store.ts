/** Internal artifact lifecycle only. Callers still need a reviewed worker and
 * verified output receipt before finalization; no HTTP endpoint accepts storage
 * keys, file hashes or a client assertion of successful rendering. */
import { randomUUID } from "node:crypto";
import { insertAuditRow, type DbClient } from "./db";
import { assertJourneyCurrent, journeyFail, journeyTransaction, type JourneyAuthority, type JourneyOwner, type JourneyOwnerInput } from "./ortho-case-journey-authority";
import { lockCurrentStudyExport } from "./ortho-case-study-export-access";
import { readLockedArtifactHistory, publicArtifactStatus, type ArtifactManifestIdentity } from "./ortho-case-study-artifact-history";
import { STUDY_ARTIFACT_LIMITS, type ArtifactFailure, type ArtifactFormat, type StudyArtifactEvent } from "./ortho-case-study-artifact-chain";
import { journeyContentHash } from "./ortho-case-journey-hash";
import { journeyId } from "./ortho-case-journey-records";
type Scope = JourneyOwnerInput & { manifestId: number };
type Command = { commandId: string; format: ArtifactFormat; expectedHeadId: number | null };
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
function command(value: Command) {
  if (!value || typeof value.commandId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(value.commandId)
    || value.format !== "pptx" && value.format !== "pdf" || value.expectedHeadId !== null && !journeyId(value.expectedHeadId)) journeyFail(400, "invalid_artifact_command");
}
async function serverNow(client: DbClient) {
  const { rows: [row] } = await client.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now");
  if (!(row?.now instanceof Date) || !Number.isSafeInteger(row.now.getTime())) journeyFail(500, "invalid_artifact_clock"); return row.now.getTime();
}
async function append(client: DbClient, owner: JourneyOwner, authority: JourneyAuthority,
  event: Omit<StudyArtifactEvent, "id">, commandId: string, fingerprint: string): Promise<number> {
  const artifact = event.artifact;
  const { rows: [row] } = await client.query<{ id: number }>(`INSERT INTO ortho_case_study_artifact_events
    (patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,manifest_id,manifest_sha256,rendering_contract_sha256,format,
     version,predecessor_id,attempt_id,attempt_actor_user_id,actor_user_id,created_at,transition,command_id,request_fingerprint,
     lease_token,lease_until,operation_deadline,failure_code,storage_key,file_sha256,size_bytes,mime_type)
    VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id`,
  [owner.patientId, owner.orthoCaseId, owner.clinicalCaseId, event.manifestId, event.manifestHash, event.renderingContractHash, event.format,
    event.version, event.predecessorId, event.attemptId, event.attemptActorId, event.actorId, new Date(event.createdAtMs), event.transition,
    commandId, fingerprint, event.leaseToken, event.leaseUntilMs === null ? null : new Date(event.leaseUntilMs),
    event.operationDeadlineMs === null ? null : new Date(event.operationDeadlineMs), event.failureCode,
    artifact?.storageKey ?? null, artifact?.sha256 ?? null, artifact?.bytes ?? null, artifact?.mimeType ?? null]);
  if (!row || !journeyId(row.id)) journeyFail(500, "artifact_append_failed");
  await insertAuditRow(client, { action: "ortho.study_artifact", entity: "ortho_case_study_artifact_events", entityId: row.id,
    entityLabel: `تصدير دراسة التقويم #${owner.orthoCaseId}`, actor: authority.name, actorRole: authority.session.role,
    details: { patientId: owner.patientId, orthoCaseId: owner.orthoCaseId, manifestId: event.manifestId,
      format: event.format, transition: event.transition, version: event.version, attemptActorId: event.attemptActorId } });
  return row.id;
}
function replayIndex(rows: { actor_user_id: unknown; command_id: unknown; request_fingerprint: unknown }[], actorId: number, commandId: string, fingerprint: string) {
  const index = rows.findIndex(row => row.actor_user_id === actorId && row.command_id === commandId);
  if (index >= 0 && rows[index].request_fingerprint !== fingerprint) journeyFail(409, "artifact_command_conflict"); return index;
}
function belongs(manifest: ArtifactManifestIdentity, format: ArtifactFormat) {
  if (!manifest.formats.includes(format)) journeyFail(409, "artifact_format_not_selected");
}
/** Trusted request-bound pipeline claims only after the exact immutable manifest
 * and all verified derivative records already exist. A lost commit must be read
 * back with this same command before any worker is started. */
export async function claimStudyArtifact(input: Scope & { command: Command; leaseMs: number }) {
  return journeyTransaction(true, async client => {
    command(input.command);
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1000 || input.leaseMs > STUDY_ARTIFACT_LIMITS.operationMs) journeyFail(400, "invalid_artifact_lease_duration");
    const { owner, authority, manifest } = await lockCurrentStudyExport(client, input, true); belongs(manifest, input.command.format);
    const prior = await readLockedArtifactHistory(client, owner, manifest, input.command.format);
    const fingerprint = journeyContentHash({ operation: "claim", ...input.command, leaseMs: input.leaseMs });
    const replay = replayIndex(prior.rows, authority.userId, input.command.commandId, fingerprint);
    if (replay >= 0) {
      const event = prior.events[replay], now = await serverNow(client);
      if (prior.head?.id !== event.id || event.transition !== "claimed" || event.leaseUntilMs === null || now >= event.leaseUntilMs) journeyFail(409, "artifact_claim_no_longer_current");
      assertJourneyCurrent(authority); return { ok: true as const, replayed: true, lease: event };
    }
    if ((prior.head?.id ?? null) !== input.command.expectedHeadId) journeyFail(409, "artifact_head_changed");
    if (prior.head && prior.head.transition !== "failed" && prior.head.transition !== "expired") journeyFail(409, "artifact_attempt_already_exists");
    if (prior.events.length + 2 > STUDY_ARTIFACT_LIMITS.events) journeyFail(409, "artifact_history_limit");
    const now = await serverNow(client), attemptId = randomUUID();
    const queued: Omit<StudyArtifactEvent, "id"> = { manifestId: manifest.id, manifestHash: manifest.contentHash,
      renderingContractHash: manifest.renderingContractHash, format: input.command.format, version: (prior.head?.version ?? 0) + 1,
      predecessorId: prior.head?.id ?? null, attemptId, attemptActorId: authority.userId, actorId: authority.userId, transition: "queued",
      createdAtMs: now, leaseToken: null, leaseUntilMs: null, operationDeadlineMs: null, failureCode: null, artifact: null };
    const queueId = await append(client, owner, authority, queued, randomUUID(), journeyContentHash({ operation: "queue", attemptId }));
    await append(client, owner, authority, { ...queued, version: queued.version + 1, predecessorId: queueId, transition: "claimed",
      leaseToken: randomUUID(), leaseUntilMs: now + input.leaseMs, operationDeadlineMs: now + STUDY_ARTIFACT_LIMITS.operationMs }, input.command.commandId, fingerprint);
    const final = await readLockedArtifactHistory(client, owner, manifest, input.command.format);
    assertJourneyCurrent(authority); return { ok: true as const, replayed: false, lease: final.head! };
  });
}
/** Recovery is a new, fully authorized actor event. It preserves the previous
 * attempt owner/token and never returns the old private lease or clinical body. */
export async function expireStudyArtifact(input: Scope & { command: Command }) {
  return journeyTransaction(true, async client => {
    command(input.command);
    const { owner, authority, manifest } = await lockCurrentStudyExport(client, input, true); belongs(manifest, input.command.format);
    const prior = await readLockedArtifactHistory(client, owner, manifest, input.command.format);
    const fingerprint = journeyContentHash({ operation: "expire", ...input.command });
    const replay = replayIndex(prior.rows, authority.userId, input.command.commandId, fingerprint);
    if (replay >= 0) { assertJourneyCurrent(authority); return { ok: true as const, replayed: true, status: publicArtifactStatus(prior.events[replay]) }; }
    const head = prior.head;
    if (!head || head.id !== input.command.expectedHeadId || head.transition !== "claimed" && head.transition !== "renewed") journeyFail(409, "artifact_head_changed");
    const now = await serverNow(client);
    if (head.leaseUntilMs === null || now < head.leaseUntilMs) journeyFail(409, "artifact_lease_not_expired");
    if (prior.events.length + 1 > STUDY_ARTIFACT_LIMITS.events) journeyFail(409, "artifact_history_limit");
    await append(client, owner, authority, { ...head, version: head.version + 1, predecessorId: head.id,
      transition: "expired", actorId: authority.userId, createdAtMs: now, failureCode: "lease_expired" }, input.command.commandId, fingerprint);
    const final = await readLockedArtifactHistory(client, owner, manifest, input.command.format);
    assertJourneyCurrent(authority); return { ok: true as const, replayed: false, status: publicArtifactStatus(final.head) };
  });
}
/** The current owner may renew or record an explicit failure. Completion is
 * deliberately a separate verified-worker finalization boundary, still pending. */
export async function progressStudyArtifact(input: Scope & { command: Command; leaseToken: string;
  update: { kind: "renew"; leaseMs: number } | { kind: "fail"; failureCode: ArtifactFailure } }) {
  return journeyTransaction(true, async client => {
    command(input.command); if (!uuid(input.leaseToken)) journeyFail(400, "invalid_artifact_token");
    if (input.update.kind === "renew") {
      if (!Number.isSafeInteger(input.update.leaseMs) || input.update.leaseMs < 1000 || input.update.leaseMs > STUDY_ARTIFACT_LIMITS.operationMs) journeyFail(400, "invalid_artifact_lease_duration");
    } else if (input.update.kind !== "fail" || !["render_failed", "capability_unavailable", "resource_limit", "authority_retired", "output_invalid"].includes(input.update.failureCode)) journeyFail(400, "invalid_artifact_failure");
    const { owner, authority, manifest } = await lockCurrentStudyExport(client, input, true); belongs(manifest, input.command.format);
    const prior = await readLockedArtifactHistory(client, owner, manifest, input.command.format);
    const fingerprint = journeyContentHash({ operation: "progress", ...input.command, update: input.update, leaseToken: input.leaseToken });
    const replay = replayIndex(prior.rows, authority.userId, input.command.commandId, fingerprint);
    if (replay >= 0) { assertJourneyCurrent(authority); return { ok: true as const, replayed: true, status: publicArtifactStatus(prior.events[replay]) }; }
    const head = prior.head, now = await serverNow(client);
    if (!head || head.id !== input.command.expectedHeadId || head.transition !== "claimed" && head.transition !== "renewed"
      || head.attemptActorId !== authority.userId || head.leaseToken !== input.leaseToken || head.leaseUntilMs === null || now >= head.leaseUntilMs
      || head.operationDeadlineMs === null) journeyFail(409, "artifact_lease_lost");
    if (prior.events.length + 1 > STUDY_ARTIFACT_LIMITS.events) journeyFail(409, "artifact_history_limit");
    const leaseUntilMs = input.update.kind === "renew" ? now + input.update.leaseMs : head.leaseUntilMs;
    if (leaseUntilMs > head.operationDeadlineMs || input.update.kind === "renew" && leaseUntilMs <= head.leaseUntilMs) journeyFail(409, "artifact_operation_cap");
    await append(client, owner, authority, { ...head, version: head.version + 1, predecessorId: head.id, actorId: authority.userId,
      transition: input.update.kind === "renew" ? "renewed" : "failed", createdAtMs: now, leaseUntilMs,
      failureCode: input.update.kind === "fail" ? input.update.failureCode : null }, input.command.commandId, fingerprint);
    const final = await readLockedArtifactHistory(client, owner, manifest, input.command.format);
    assertJourneyCurrent(authority); return { ok: true as const, replayed: false, status: publicArtifactStatus(final.head) };
  });
}
