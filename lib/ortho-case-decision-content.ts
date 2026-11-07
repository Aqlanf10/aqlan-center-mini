/** Strict documentary payload and current capability admission; no writer imports. */
import { checkDecisionCommand, journeyHash, journeyId, type Checked, type ConsentObservation, type DecisionContent } from "./ortho-case-journey-records";
import { journeyContentHash } from "./ortho-case-journey-hash";
import { journeyFail, type JourneyAuthority } from "./ortho-case-journey-authority";
import { requirePreparedAssessmentReference, type StudyAssessmentAccess } from "./ortho-case-study-assessment-access";
export interface DecisionSavedContent {
  authored: DecisionContent; consent: ConsentObservation | null;
  sourceAccess: { imaging: boolean; plans: boolean };
}
export function decodeDecisionSavedContent(value: unknown): Checked<DecisionSavedContent> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "invalid_decision_content" };
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["authored", "consent", "sourceAccess"].includes(k))) return { ok: false, code: "unknown_field" };
  const command = checkDecisionCommand({ schemaVersion: 1, clientRequestId: "stored_read_only", expectedHeadId: null, reason: "stored", content: v.authored });
  if (!command.ok) return command;
  if (!v.sourceAccess || typeof v.sourceAccess !== "object" || Array.isArray(v.sourceAccess)) return { ok: false, code: "invalid_source_access" };
  const access = v.sourceAccess as Record<string, unknown>;
  if (Object.keys(access).some(k => !["imaging", "plans"].includes(k)) || typeof access.imaging !== "boolean" || typeof access.plans !== "boolean") return { ok: false, code: "invalid_source_access" };
  if (command.value.content.planId !== null && !access.plans) return { ok: false, code: "invalid_source_access" };
  let consent: ConsentObservation | null = null;
  if (v.consent !== null) {
    if (!v.consent || typeof v.consent !== "object" || Array.isArray(v.consent)) return { ok: false, code: "invalid_consent_observation" };
    const c = v.consent as Record<string, unknown>;
    if (Object.keys(c).some(k => !["planId", "capturedAt", "consentAt", "consentBy", "state", "planScopeHash", "observationHash"].includes(k))
      || !journeyId(c.planId) || c.planId !== command.value.content.planId || typeof c.capturedAt !== "string" || !Number.isFinite(Date.parse(c.capturedAt))
      || !(c.consentAt === null || typeof c.consentAt === "string" && Number.isFinite(Date.parse(c.consentAt)))
      || !(c.consentBy === null || typeof c.consentBy === "string")
      || c.state !== "current" && c.state !== "not_recorded" && c.state !== "historical_unverified"
      || !journeyHash(c.planScopeHash) || !journeyHash(c.observationHash)
      || c.planScopeHash !== command.value.content.expectedPlanScopeHash || c.observationHash !== command.value.content.expectedConsentHash
      || (c.state === "not_recorded") !== (c.consentAt === null)) return { ok: false, code: "invalid_consent_observation" };
    consent = { planId: c.planId, capturedAt: c.capturedAt, consentAt: c.consentAt, consentBy: c.consentBy,
      state: c.state, planScopeHash: c.planScopeHash, observationHash: c.observationHash };
    if (journeyContentHash({ planId: consent.planId, consentAt: consent.consentAt, consentBy: consent.consentBy, state: consent.state, planScopeHash: consent.planScopeHash }) !== consent.observationHash) return { ok: false, code: "invalid_consent_hash" };
  }
  if ((consent === null) !== (command.value.content.planId === null)) return { ok: false, code: "missing_consent_observation" };
  return { ok: true, value: { authored: command.value.content, consent, sourceAccess: { imaging: access.imaging, plans: access.plans } } };
}
export function requireDecisionRead(authority: JourneyAuthority, contents: DecisionSavedContent[]) {
  if (!authority.canViewImages && contents.some(c => c.sourceAccess.imaging)) journeyFail(403, "decision_imaging_restricted");
  if (!authority.canViewPlans && contents.some(c => c.sourceAccess.plans)) journeyFail(403, "decision_plan_restricted");
}
export function requireCurrentDecisionRead(authority: JourneyAuthority, contents: DecisionSavedContent[], cache: StudyAssessmentAccess) {
  requireDecisionRead(authority, contents);
  for (const content of contents) {
    if (content.authored.planId !== null && !cache.currentPlanIds.has(content.authored.planId)) journeyFail(403, "decision_plan_source_restricted");
    if (content.authored.assessment) requirePreparedAssessmentReference(cache, content.authored.assessment, authority, false);
  }
}
