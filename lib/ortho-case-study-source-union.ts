/** Source-union discovery performs immutable reads only. Its caller locks the
 * complete external union once, before locking either case. */
import type { DbClient } from "./db";
import { decodeAnyAssessmentRevision } from "./ortho-assessment-persisted-v2";
import { decodeDecisionSavedContent, type DecisionSavedContent } from "./ortho-case-decision-content";
import { decodeRetentionSavedContent, type RetentionSavedContent } from "./ortho-retention-history-store";
import { journeyClinicalSources } from "./ortho-case-journey-clinical-sources";
import { journeyHistory } from "./ortho-case-journey-history";
import { journeyFail, type JourneyAuthority, type JourneyOwner } from "./ortho-case-journey-authority";
import type { JourneyRevisionReference } from "./ortho-case-journey-records";
import type { StudySavedContent } from "./ortho-case-study-capture";
import type { StudyDraftContent } from "./ortho-case-study";
import { addStudyPlanTargets, addStudySourceTargets, prepareStudyAssessmentAccess, type StudyAssessmentAccess } from "./ortho-case-study-assessment-access";
export async function prepareDecisionSourceUnion(client: DbClient, owner: JourneyOwner, authority: JourneyAuthority,
  contents: readonly DecisionSavedContent[], cache: StudyAssessmentAccess) {
  addStudyPlanTargets(cache, contents.flatMap(c => c.authored.planId === null ? [] : [c.authored.planId]));
  const refs = contents.flatMap(c => c.authored.assessment ? [c.authored.assessment] : []);
  await prepareAssessmentReferences(client, owner, authority, refs, cache);
}
async function prepareAssessmentReferences(client: DbClient, owner: JourneyOwner, authority: JourneyAuthority,
  references: readonly JourneyRevisionReference[], cache: StudyAssessmentAccess) {
  if (!references.length) return;
  const clinical = await journeyClinicalSources(client, owner, authority, ["assessment"], cache, true);
  const revisions = references.map(ref => {
    const revision = clinical.assessments.find(r => r.id === ref.id && r.version === ref.version && r.contentHash === ref.contentHash);
    if (!revision) journeyFail(403, "study_nested_assessment_unavailable"); return revision;
  });
  await prepareStudyAssessmentAccess(client, owner, authority, revisions, cache);
}
function retentionTargets(contents: readonly RetentionSavedContent[], authority: JourneyAuthority, cache: StudyAssessmentAccess) {
  const ids = contents.flatMap(c => c.payload.documentIds);
  if (ids.length && !authority.canViewImages) journeyFail(403, "study_retention_images_restricted");
  addStudySourceTargets(cache, ids.map(id => ({ kind: "document", id })));
}
export async function prepareSavedStudySourceUnion(client: DbClient, owner: JourneyOwner, authority: JourneyAuthority,
  contents: readonly StudySavedContent[], cache: StudyAssessmentAccess) {
  const decisions: DecisionSavedContent[] = [], retention: RetentionSavedContent[] = [];
  for (const saved of contents) for (const source of saved.sources) {
    if (source.access.images && !authority.canViewImages || source.access.plans && !authority.canViewPlans) journeyFail(403, "study_section_restricted");
    if (source.state !== "available") continue;
    if (source.selection.kind === "assessment") {
      const parsed = decodeAnyAssessmentRevision(source.payload, { ...owner, patientId: saved.recordedPatientId });
      if (!parsed.ok) journeyFail(500, "invalid_saved_assessment");
      await prepareStudyAssessmentAccess(client, owner, authority, [parsed.value], cache);
    } else if (source.selection.kind === "decision" || source.selection.kind === "retention_event") {
      const content = (source.payload as { content: unknown }).content; // strict capture decoder already checked the envelope
      if (source.selection.kind === "decision") {
        const parsed = decodeDecisionSavedContent(content); if (!parsed.ok) journeyFail(500, parsed.code); decisions.push(parsed.value);
      } else { const parsed = decodeRetentionSavedContent(content); if (!parsed.ok) journeyFail(500, parsed.code); retention.push(parsed.value); }
    } else if (source.selection.kind === "document" || source.selection.kind === "ceph_study") {
      addStudySourceTargets(cache, [{ kind: source.selection.kind, id: source.selection.id }]);
    } else if (source.selection.kind === "plan_consent") {
      addStudyPlanTargets(cache, [source.selection.id]);
    } else if (source.selection.kind === "adjustment") {
      const visitId = (source.payload as { visitId: number | null }).visitId;
      if (visitId !== null) addStudySourceTargets(cache, [{ kind: "clinical_visit", id: visitId }]);
    }
  }
  await prepareDecisionSourceUnion(client, owner, authority, decisions, cache); retentionTargets(retention, authority, cache);
}
export async function prepareIncomingStudySourceUnion(client: DbClient, owner: JourneyOwner, authority: JourneyAuthority,
  content: StudyDraftContent, cache: StudyAssessmentAccess) {
  if (content.sources.some(s => s.kind === "assessment")) {
    const clinical = await journeyClinicalSources(client, owner, authority, ["assessment"], cache, true);
    const selected = clinical.assessments.filter(r => content.sources.some(s => s.kind === "assessment" && s.id === r.id && s.version === r.version));
    await prepareStudyAssessmentAccess(client, owner, authority, selected, cache);
  }
  if (content.sources.some(s => s.kind === "decision")) {
    const history = await journeyHistory(client, "ortho_decision_revisions", owner, decodeDecisionSavedContent);
    const selected = history.revisions.filter(r => content.sources.some(s => s.kind === "decision" && s.id === r.id && s.version === r.version));
    await prepareDecisionSourceUnion(client, owner, authority, selected.map(r => r.content), cache);
  }
  if (content.sources.some(s => s.kind === "retention_event")) {
    const history = await journeyHistory(client, "ortho_retention_entries", owner, decodeRetentionSavedContent);
    const selected = history.revisions.filter(r => content.sources.some(s => s.kind === "retention_event" && s.id === r.id && s.version === r.version));
    retentionTargets(selected.map(r => r.content), authority, cache);
  }
}
