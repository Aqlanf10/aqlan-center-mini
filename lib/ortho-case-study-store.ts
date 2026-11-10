import type { DbClient } from "./db";
import type { StudySaveCommand } from "./ortho-case-study";
import type { JourneyAuthority } from "./ortho-case-journey-authority";
import { assertJourneyCurrent, authorizeJourney, discoverJourneyOwner, journeyFail, journeyTransaction, lockJourneyOwner,
  type JourneyOwnerInput } from "./ortho-case-journey-authority";
import { isAvailableStudySourceKind } from "./ortho-case-study";
import { journeyId } from "./ortho-case-journey-records";
import { captureStudySources, lockStudyExternalSources, type StudyExternalSources } from "./ortho-case-study-sources";
import { decodeStudySavedContent, type StudySavedContent } from "./ortho-case-study-capture";
import { requireCurrentStudyRead } from "./ortho-case-study-access";
import { readLockedStudyHistory, type StudyContentPolicy } from "./ortho-case-study-repository";
import { createStudyAssessmentAccess, lockStudySourceUnion } from "./ortho-case-study-assessment-access";
import { prepareSavedStudySourceUnion, prepareIncomingStudySourceUnion } from "./ortho-case-study-source-union";
const decodeOnlyPolicy: StudyContentPolicy<StudySavedContent> = { decode: decodeStudySavedContent, authored: c => c.authored,
  requireCurrentRead: async () => journeyFail(500, "study_authority_not_prepared") };

/** exportAccess is server-owned intent, never parsed from request parameters. */
export async function getOrthoCaseStudy(input: JourneyOwnerInput & { revisionId?: number; exportAccess?: true }) {
  return journeyTransaction(false, async client => {
    if (input.revisionId !== undefined && !journeyId(input.revisionId)) journeyFail(400, "invalid_study_revision");
    const authority = await authorizeJourney(client, input, false);
    if (input.exportAccess && authority.canExportStudies !== true) journeyFail(403, "study_export_forbidden");
    const discovered = await discoverJourneyOwner(client, input);
    const preflight = await readLockedStudyHistory(client, discovered, decodeOnlyPolicy);
    const priorHead = preflight.revisions.at(-1) ?? null;
    const priorSelected = input.revisionId === undefined ? priorHead : preflight.revisions.find(r => r.id === input.revisionId) ?? null;
    const assessmentAccess = createStudyAssessmentAccess();
    await prepareSavedStudySourceUnion(client, discovered, authority,
      [priorHead?.content, priorSelected?.content].filter((c): c is StudySavedContent => c !== undefined), assessmentAccess);
    await lockStudySourceUnion(client, discovered, authority, assessmentAccess);
    const owner = await lockJourneyOwner(client, input, false);
    if (owner.clinicalCaseId !== discovered.clinicalCaseId) journeyFail(409, "study_owner_changed");
    const policy: StudyContentPolicy<StudySavedContent> = { decode: decodeStudySavedContent, authored: c => c.authored,
      requireCurrentRead: c => requireCurrentStudyRead(client, owner, authority, c, assessmentAccess) };
    const { revisions } = await readLockedStudyHistory(client, owner, policy), head = revisions.at(-1) ?? null;
    const selected = input.revisionId === undefined ? head : revisions.find(r => r.id === input.revisionId) ?? null;
    if (input.revisionId !== undefined && !selected) journeyFail(404, "study_revision_not_found");
    if (selected) await policy.requireCurrentRead(selected.content);
    if (head && head !== selected) await policy.requireCurrentRead(head.content);
    assertJourneyCurrent(authority);
    return { ok: true as const, patientId: owner.patientId, orthoCaseId: owner.orthoCaseId, clinicalCaseId: owner.clinicalCaseId,
      revision: selected, head: head ? { id: head.id, contentHash: head.contentHash } : null, canAppend: authority.canWrite,
      history: revisions.map(r => ({ id: r.id, version: r.version, kind: r.kind, contentHash: r.contentHash,
        createdAt: r.createdAt, predecessorId: r.predecessorId, documentedFromId: r.documentedFromId, baseDocumentedId: r.baseDocumentedId })) };
  });
}

/** Transaction-local preparation shared by durable reservation, recovery and
 * execution. Caller already holds table fences, patient/account and receipt. */
export async function prepareStudySave(client: DbClient, input: JourneyOwnerInput, command: StudySaveCommand, authority: JourneyAuthority) {
    if (command.content.sources.some(source => !isAvailableStudySourceKind(source.kind))) journeyFail(409, "study_source_not_integrated");
    const discovered = await discoverJourneyOwner(client, input);
    const preflight = await readLockedStudyHistory(client, discovered, decodeOnlyPolicy);
    const priorHead = preflight.revisions.at(-1) ?? null;
    const replayIndex = preflight.rows.findIndex(row => row.actor_user_id === authority.userId && row.command_id === command.clientRequestId);
    const replay = replayIndex < 0 ? null : preflight.revisions[replayIndex];
    const expected = command.expectedHead ? preflight.revisions.find(r => r.id === command.expectedHead!.id && r.contentHash === command.expectedHead!.contentHash) : null;
    const base = command.baseDocumentedRevision ? preflight.revisions.find(r => r.id === command.baseDocumentedRevision!.id) : null;
    const assessmentAccess = createStudyAssessmentAccess();
    await prepareSavedStudySourceUnion(client, discovered, authority,
      [priorHead?.content, replay?.content, base?.content, expected?.content].filter((c): c is StudySavedContent => c !== undefined), assessmentAccess);
    // An acknowledged retry or documentation copy does not recapture new source
    // versions. Incoming assessment locks are needed only for a new draft.
    if (!replay && command.kind === "draft") await prepareIncomingStudySourceUnion(client, discovered, authority, command.content, assessmentAccess);
    let external: StudyExternalSources | null = null;
    // Patient lock stabilizes the actor-command preflight. Acknowledged replay
    // locks only its saved source union, never newly submitted source versions.
    if (!replay && command.kind === "draft") external = await lockStudyExternalSources(client, input, discovered, authority, command.content, assessmentAccess);
    else await lockStudySourceUnion(client, discovered, authority, assessmentAccess);
    const owner = await lockJourneyOwner(client, input, true);
    if (owner.clinicalCaseId !== discovered.clinicalCaseId) journeyFail(409, "study_owner_changed");
    const policy: StudyContentPolicy<StudySavedContent> = { decode: decodeStudySavedContent, authored: c => c.authored,
      requireCurrentRead: c => requireCurrentStudyRead(client, owner, authority, c, assessmentAccess) };
    return { owner, authority, command, policy, preflight, replay, expected, capture: async (): Promise<StudySavedContent> => {
      if (!external) journeyFail(500, "study_source_capture_missing");
      const sources = await captureStudySources(client, owner, authority, command.content, external, assessmentAccess);
      const { rows: [clock] } = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      if (!(clock?.now instanceof Date) || !Number.isFinite(clock.now.getTime())) journeyFail(500, "invalid_capture_clock");
      return { schemaVersion: 1, capturedAt: clock.now.toISOString(), recordedPatientId: owner.patientId,
        orthoCaseId: owner.orthoCaseId, clinicalCaseId: owner.clinicalCaseId, caseStatusAtCapture: owner.status,
        authored: command.content, sources };
    } };

}

export async function saveOrthoCaseStudy(input: JourneyOwnerInput & { clinicalCaseId: number; actorId: number; command: unknown }) {
  // Loading at call time keeps the canonical read/preparation module independent
  // of the journal's orchestration initialization.
  const { saveJournaledStudy } = await import("./ortho-study-submission-store");
  return saveJournaledStudy(input);
}
