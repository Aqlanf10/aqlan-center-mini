import { assertJourneyCurrent, authorizeJourney, discoverJourneyOwner, journeyFail, journeyTransaction, lockJourneyOwner,
  type JourneyOwnerInput } from "./ortho-case-journey-authority";
import { checkStudySaveCommand } from "./ortho-case-study";
import { journeyId } from "./ortho-case-journey-records";
import { captureStudySources, lockStudyExternalSources, type StudyExternalSources } from "./ortho-case-study-sources";
import { decodeStudySavedContent, type StudySavedContent } from "./ortho-case-study-capture";
import { requireCurrentStudyRead } from "./ortho-case-study-access";
import { appendLockedStudyRevision, readLockedStudyHistory, type StudyContentPolicy } from "./ortho-case-study-repository";
import { createStudyAssessmentAccess, lockStudySourceUnion } from "./ortho-case-study-assessment-access";
import { prepareSavedStudySourceUnion, prepareIncomingStudySourceUnion } from "./ortho-case-study-source-union";
const decodeOnlyPolicy: StudyContentPolicy<StudySavedContent> = { decode: decodeStudySavedContent, authored: c => c.authored,
  requireCurrentRead: async () => journeyFail(500, "study_authority_not_prepared") };

export async function getOrthoCaseStudy(input: JourneyOwnerInput & { revisionId?: number }) {
  return journeyTransaction(false, async client => {
    if (input.revisionId !== undefined && !journeyId(input.revisionId)) journeyFail(400, "invalid_study_revision");
    const authority = await authorizeJourney(client, input, false), discovered = await discoverJourneyOwner(client, input);
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

export async function saveOrthoCaseStudy(input: JourneyOwnerInput & { command: unknown }) {
  return journeyTransaction(true, async client => {
    const checked = checkStudySaveCommand(input.command); if (!checked.ok) journeyFail(400, checked.code);
    const command = checked.value, authority = await authorizeJourney(client, input, true);
    const discovered = await discoverJourneyOwner(client, input);
    const preflight = await readLockedStudyHistory(client, discovered, decodeOnlyPolicy);
    const priorHead = preflight.revisions.at(-1) ?? null;
    const replayIndex = preflight.rows.findIndex(row => row.actor_user_id === authority.userId && row.command_id === command.clientRequestId);
    const replay = replayIndex < 0 ? null : preflight.revisions[replayIndex];
    const base = command.baseDocumentedRevision ? preflight.revisions.find(r => r.id === command.baseDocumentedRevision!.id) : null;
    const assessmentAccess = createStudyAssessmentAccess();
    await prepareSavedStudySourceUnion(client, discovered, authority,
      [priorHead?.content, replay?.content, base?.content].filter((c): c is StudySavedContent => c !== undefined), assessmentAccess);
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
    return appendLockedStudyRevision(client, { owner, authority, command, policy, capture: async (): Promise<StudySavedContent> => {
      if (!external) journeyFail(500, "study_source_capture_missing");
      const sources = await captureStudySources(client, owner, authority, command.content, external, assessmentAccess);
      const { rows: [clock] } = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      if (!(clock?.now instanceof Date) || !Number.isFinite(clock.now.getTime())) journeyFail(500, "invalid_capture_clock");
      return { schemaVersion: 1, capturedAt: clock.now.toISOString(), recordedPatientId: owner.patientId,
        orthoCaseId: owner.orthoCaseId, clinicalCaseId: owner.clinicalCaseId, caseStatusAtCapture: owner.status,
        authored: command.content, sources };
    } });
  });
}
