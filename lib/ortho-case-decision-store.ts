import { checkDecisionCommand, journeyId } from "./ortho-case-journey-records";
import { assertJourneyCurrent, authorizeJourney, discoverJourneyOwner, JourneyFault, journeyFail, journeyTransaction, lockJourneyOwner, type JourneyOwnerInput } from "./ortho-case-journey-authority";
import { insertJourneyRevision, journeyContentHash, journeyHistory, replayJourney } from "./ortho-case-journey-history";
import { exactDecisionReferences, journeyClinicalSources } from "./ortho-case-journey-clinical-sources";
import { addStudyPlanTargets, createStudyAssessmentAccess, lockStudySourceUnion, prepareStudyAssessmentAccess } from "./ortho-case-study-assessment-access";
import { prepareDecisionSourceUnion } from "./ortho-case-study-source-union";
import { lockJourneyPlan, type JourneyPlanSource } from "./ortho-case-journey-plan-source";
import { decodeDecisionSavedContent, requireDecisionRead, requireCurrentDecisionRead, type DecisionSavedContent } from "./ortho-case-decision-content";
export { decodeDecisionSavedContent, requireDecisionRead } from "./ortho-case-decision-content";
export type { DecisionSavedContent } from "./ortho-case-decision-content";
export async function getOrthoDecisions(input: JourneyOwnerInput & { revisionId?: number }) {
  return journeyTransaction(false, async client => {
    if (input.revisionId !== undefined && !journeyId(input.revisionId)) journeyFail(400, "invalid_revision");
    const authority = await authorizeJourney(client, input, false), discovered = await discoverJourneyOwner(client, input);
    const preflight = await journeyHistory(client, "ortho_decision_revisions", discovered, decodeDecisionSavedContent);
    const wanted = input.revisionId === undefined ? preflight.revisions[0] : preflight.revisions.find(r => r.id === input.revisionId);
    const assessmentAccess = createStudyAssessmentAccess();
    await prepareDecisionSourceUnion(client, discovered, authority, [preflight.revisions[0], wanted].filter(r => r != null).map(r => r.content), assessmentAccess);
    await lockStudySourceUnion(client, discovered, authority, assessmentAccess);
    const owner = await lockJourneyOwner(client, input, false);
    if (owner.clinicalCaseId !== discovered.clinicalCaseId) journeyFail(409, "decision_owner_changed");
    const { revisions } = await journeyHistory(client, "ortho_decision_revisions", owner, decodeDecisionSavedContent);
    const revision = input.revisionId === undefined ? revisions[0] ?? null : revisions.find(r => r.id === input.revisionId) ?? null;
    if (input.revisionId !== undefined && revision === null) journeyFail(404, "revision_not_found");
    const selected = [revision, revisions[0]].filter(r => r != null);
    requireCurrentDecisionRead(authority, selected.map(r => r.content), assessmentAccess);
    assertJourneyCurrent(authority);
    return { ok: true as const, ...owner, revision, canAppend: authority.canWrite && (!selected.some(r => r.content.sourceAccess.plans) || authority.canEditPlans),
      history: revisions.map(r => ({ id: r.id, version: r.version, predecessorId: r.predecessorId, createdAt: r.createdAt, contentHash: r.contentHash })) };
  });
}
export async function appendOrthoDecision(input: JourneyOwnerInput & { command: unknown }) {
  return journeyTransaction(true, async client => {
    const checked = checkDecisionCommand(input.command); if (!checked.ok) journeyFail(400, checked.code);
    const command = checked.value, authority = await authorizeJourney(client, input, true);
    const discovered = await discoverJourneyOwner(client, input);
    const preflight = await journeyHistory(client, "ortho_decision_revisions", discovered, decodeDecisionSavedContent);
    const replayIndex = preflight.rows.findIndex(row => row.actor_user_id === authority.userId && row.command_id === command.clientRequestId);
    const existingCommand = replayIndex >= 0;
    const assessmentAccess = createStudyAssessmentAccess();
    await prepareDecisionSourceUnion(client, discovered, authority,
      [preflight.revisions[0], replayIndex >= 0 ? preflight.revisions[replayIndex] : null].filter(r => r != null).map(r => r.content), assessmentAccess);
    if (!existingCommand && command.content.assessment) {
      const sources = await journeyClinicalSources(client, discovered, authority, ["assessment"], assessmentAccess);
      const ref = command.content.assessment;
      const selected = sources.assessments.filter(r => r.id === ref.id && r.version === ref.version && r.contentHash === ref.contentHash);
      await prepareStudyAssessmentAccess(client, discovered, authority, selected, assessmentAccess);
    }
    const planCapture: { plan: JourneyPlanSource | null; failure: JourneyFault | null } = { plan: null, failure: null };
    if (!existingCommand && command.content.planId !== null) addStudyPlanTargets(assessmentAccess, [command.content.planId]);
    await lockStudySourceUnion(client, discovered, authority, assessmentAccess, async () => {
      if (!existingCommand && command.content.planId !== null) {
        if (!authority.canEditPlans) journeyFail(403, "plan_link_edit_denied");
        try { planCapture.plan = await lockJourneyPlan(client, input, authority, command.content.planId); }
        catch (error) { if (!(error instanceof JourneyFault)) throw error; planCapture.failure = error; }
      }
    });
    const owner = await lockJourneyOwner(client, input, true), { rows, revisions } = await journeyHistory(client, "ortho_decision_revisions", owner, decodeDecisionSavedContent);
    if (owner.clinicalCaseId !== discovered.clinicalCaseId) journeyFail(409, "decision_owner_changed");
    const head = revisions[0] ?? null;
    requireCurrentDecisionRead(authority, head ? [head.content] : [], assessmentAccess);
    if (head?.content.sourceAccess.plans && !authority.canEditPlans) journeyFail(403, "plan_link_edit_denied");
    const fingerprint = journeyContentHash(command), replay = replayJourney(rows, revisions, authority, command.clientRequestId, fingerprint);
    if (replay) { requireCurrentDecisionRead(authority, [replay.content], assessmentAccess); return { ok: true as const, replayed: true, revision: replay }; }
    if (planCapture.failure) throw planCapture.failure;
    const plan = planCapture.plan;
    if (plan && (owner.planId !== plan.planId || plan.consent.planScopeHash !== command.content.expectedPlanScopeHash || plan.consent.observationHash !== command.content.expectedConsentHash)) journeyFail(409, "plan_or_consent_changed");
    const refs = await exactDecisionReferences(client, owner, authority, command.content, assessmentAccess);
    const content: DecisionSavedContent = { authored: command.content,
      consent: plan ? { ...plan.consent, capturedAt: new Date().toISOString() } : null,
      sourceAccess: { imaging: refs.assessmentUsesImaging,
        plans: Boolean(plan || refs.strategy?.rows.some(row => row.planItems.length > 0)) } };
    requireDecisionRead(authority, [content]);
    if (content.sourceAccess.plans && !authority.canEditPlans) journeyFail(403, "plan_link_edit_denied");
    const revision = await insertJourneyRevision(client, { table: "ortho_decision_revisions", owner, authority, head,
      expectedHeadId: command.expectedHeadId, commandId: command.clientRequestId, fingerprint, reason: command.reason, content, decode: decodeDecisionSavedContent });
    assertJourneyCurrent(authority); return { ok: true as const, replayed: false, revision };
  });
}
