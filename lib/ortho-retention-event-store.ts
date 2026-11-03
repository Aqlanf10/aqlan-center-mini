/** Documentary physical-device history. No scheduling, finance, consent or case
 * lifecycle mutation. Existing mutable legacy retainer fields are not read as
 * evidence of a new device or delivery date. */
import type { DbClient } from "./db";
import { acknowledgeStoredRetentionCommand } from "./ortho-retention-command-ack";
import { authorizeJourney, assertJourneyCurrent, discoverJourneyOwner, journeyFail, journeyTransaction, lockJourneyOwner,
  type JourneyAuthority, type JourneyOwner, type JourneyOwnerInput } from "./ortho-case-journey-authority";
import { journeyId } from "./ortho-case-journey-records";
import { checkRetentionEventCommand } from "./ortho-retention-events";
import { decodeRetentionSavedContent, type RetentionSavedContent } from "./ortho-retention-history-store";
import { projectRetentionEventHistory } from "./ortho-retention-event-history";
import { insertJourneyRevision, journeyContentHash, journeyHistory, replayJourney, type JourneyRevision } from "./ortho-case-journey-history";
import { addStudySourceTargets, createStudyAssessmentAccess, lockStudySourceUnion, type StudyAssessmentAccess } from "./ortho-case-study-assessment-access";
function projection(revisions: JourneyRevision<RetentionSavedContent>[]) {
  const projected = projectRetentionEventHistory(revisions.map(r => ({ id: r.id, version: r.version, arch: r.content.arch,
    supersedesEntryId: r.content.supersedesEntryId, archCorrectionReason: r.content.archCorrectionReason, content: r.content.payload })));
  if (!projected.ok) journeyFail(409, projected.code); return projected.value;
}
async function prepare(client: DbClient, owner: JourneyOwner, authority: JourneyAuthority, contents: RetentionSavedContent[]) {
  const access = createStudyAssessmentAccess(), ids = [...new Set(contents.flatMap(c => c.payload.documentIds))];
  if (ids.length && !authority.canViewImages) journeyFail(403, "retention_images_restricted");
  addStudySourceTargets(access, ids.map(id => ({ kind: "document", id })));
  await lockStudySourceUnion(client, owner, authority, access); return access;
}
async function requireRead(client: DbClient, owner: JourneyOwner, authority: JourneyAuthority,
  contents: RetentionSavedContent[], access: StudyAssessmentAccess) {
  const ids = [...new Set(contents.flatMap(c => c.payload.documentIds))];
  if (ids.length && !authority.canViewImages) journeyFail(403, "retention_images_restricted");
  for (const id of ids.sort((a, b) => a - b)) {
    if (!access.current?.has(`document:${id}`)) journeyFail(403, "retention_document_unavailable");
    const row = (await client.query<{ id: number }>("SELECT id FROM patient_documents WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3 AND removed_at IS NULL", [id, owner.patientId, owner.orthoCaseId])).rows[0];
    if (!row) journeyFail(403, "retention_document_unavailable");
  }
  assertJourneyCurrent(authority);
}
export async function getOrthoRetentionEvents(input: JourneyOwnerInput & { revisionId?: number }) {
  return journeyTransaction(false, async client => {
    if (input.revisionId !== undefined && !journeyId(input.revisionId)) journeyFail(400, "invalid_retention_revision");
    const authority = await authorizeJourney(client, input, false), discovered = await discoverJourneyOwner(client, input);
    const preflight = await journeyHistory(client, "ortho_retention_entries", discovered, decodeRetentionSavedContent);
    // The returned device projection contains current events from the whole
    // history; authorize all of those source-bearing records, not just its head.
    const visible = projection(preflight.revisions);
    const selected = input.revisionId === undefined ? preflight.revisions[0] ?? null : preflight.revisions.find(r => r.id === input.revisionId) ?? null;
    if (input.revisionId !== undefined && !selected) journeyFail(404, "retention_revision_not_found");
    const readIds = new Set([...visible.currentEvents.map(r => r.id), ...(selected ? [selected.id] : [])]);
    const contents = preflight.revisions.filter(r => readIds.has(r.id)).map(r => r.content);
    const access = await prepare(client, discovered, authority, contents);
    const owner = await lockJourneyOwner(client, input, false);
    if (owner.clinicalCaseId !== discovered.clinicalCaseId) journeyFail(409, "retention_owner_changed");
    await requireRead(client, owner, authority, contents, access);
    return { ok: true as const, ...owner, revision: selected, devices: visible.devices, currentEvents: visible.currentEvents,
      canAppend: authority.canWrite, history: preflight.revisions.map(r => ({ id: r.id, version: r.version, predecessorId: r.predecessorId,
        createdAt: r.createdAt, contentHash: r.contentHash })) };
  });
}
export async function appendOrthoRetentionEvent(input: JourneyOwnerInput & { command: unknown }) {
  return journeyTransaction(true, async client => {
    const parsed = checkRetentionEventCommand(input.command); if (!parsed.ok) journeyFail(400, parsed.code);
    const command = parsed.value, authority = await authorizeJourney(client, input, true), discovered = await discoverJourneyOwner(client, input);
    const before = await journeyHistory(client, "ortho_retention_entries", discovered, decodeRetentionSavedContent);
    const priorProjection = projection(before.revisions);
    const fingerprint = journeyContentHash(command);
    const replayIndex = before.rows.findIndex(r => r.actor_user_id === authority.userId && r.command_id === command.clientRequestId);
    const old = replayIndex < 0 ? null : before.revisions[replayIndex], head = before.revisions[0] ?? null;
    const content: RetentionSavedContent = { arch: command.arch, supersedesEntryId: command.supersedesEntryId,
      archCorrectionReason: command.archCorrectionReason, payload: command.content };
    const contents = [head?.content, old?.content, ...(old ? [] : [content])].filter((c): c is RetentionSavedContent => c !== undefined);
    const access = await prepare(client, discovered, authority, contents), owner = await lockJourneyOwner(client, input, true);
    if (owner.clinicalCaseId !== discovered.clinicalCaseId) journeyFail(409, "retention_owner_changed");
    await requireRead(client, owner, authority, contents, access);
    const replay = replayJourney(before.rows, before.revisions, authority, command.clientRequestId, fingerprint);
    if (replay) {
      const acknowledgment = acknowledgeStoredRetentionCommand(before.rows[replayIndex], { revisionId: replay.id, actorId: authority.userId,
        commandId: command.clientRequestId, requestFingerprint: fingerprint });
      return { ok: true as const, replayed: true, revision: replay, acknowledgment };
    }
    const device = "device" in command.content ? command.content.device : null;
    const replaces = command.content.kind === "device_replacement" ? command.content.replaces : null;
    const target = device ?? replaces;
    if (target) {
      const current = priorProjection.devices.find(d => d.deviceId === target.deviceId);
      if (!current || current.lastEventId !== target.expectedDeviceRevisionId) journeyFail(409, "device_reference_changed");
    }
    if (replaces && command.supersedesEntryId === null && priorProjection.devices.some(d => d.replacedDeviceId === replaces.deviceId)) journeyFail(409, "device_already_replaced");
    const revision = await insertJourneyRevision(client, { table: "ortho_retention_entries", owner, authority, head,
      expectedHeadId: command.expectedHeadId, commandId: command.clientRequestId, fingerprint, reason: command.reason, content,
      retention: { arch: command.arch, kind: command.content.kind, supersedesEntryId: command.supersedesEntryId,
        deviceEntryId: device?.deviceId ?? null, replacesDeviceId: replaces?.deviceId ?? null,
        expectedDeviceRevisionId: device?.expectedDeviceRevisionId ?? replaces?.expectedDeviceRevisionId ?? null }, decode: decodeRetentionSavedContent });
    // Uses the actual inserted ID, not a fabricated future root. Invalid device
    // revision/replacement/correction rolls back its revision and audit together.
    projection([revision, ...before.revisions]);
    // Capture only this exact inserted command's canonical identity. Existing
    // GET/source projections stay unchanged, and no cross-actor history is exposed.
    const { rows: ackRows } = await client.query<{ id: unknown; actor_user_id: unknown; command_id: unknown; request_fingerprint: unknown }>(
      `SELECT id,actor_user_id,command_id,request_fingerprint FROM ortho_retention_entries
        WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3 AND clinical_case_id=$4`,
      [revision.id, owner.patientId, owner.orthoCaseId, owner.clinicalCaseId]);
    if (ackRows.length !== 1) journeyFail(500, "retention_acknowledgment_unavailable");
    const acknowledgment = acknowledgeStoredRetentionCommand(ackRows[0], { revisionId: revision.id, actorId: authority.userId,
      commandId: command.clientRequestId, requestFingerprint: fingerprint });
    assertJourneyCurrent(authority); return { ok: true as const, replayed: false, revision, acknowledgment };
  });
}
