/** Expand immutable closures first; acquire one complete source union before
 * Ortho/bridge locks. Historical expected hashes remain separate per closure. */
import type { DbClient } from "./db";
import { AssessmentStoreFault } from "./ortho-assessment-authority";
import { assessmentRevisionSources, type AnyAssessmentRevision } from "./ortho-assessment-persisted-v2";
import { collectAssessmentSourceClosure, captureAssessmentExternalSources, assessmentSourceStates, type AssessmentSourceGraph, type AssessmentExternalCapture } from "./ortho-assessment-versioned-sources";
import type { AssessmentSourceV2 } from "./ortho-assessment-v2";
import { journeyContentHash } from "./ortho-case-journey-hash";
import type { JourneyRevisionReference, JourneyScope } from "./ortho-case-journey-records";
import { journeyFail, type JourneyAuthority } from "./ortho-case-journey-authority";
type Target = Pick<AssessmentSourceV2, "kind" | "id">;
export interface StudyAssessmentAccess {
  closures: Map<string, { revision: AnyAssessmentRevision; closure: Pick<AssessmentSourceGraph, "external" | "revisions"> }>;
  graphs: Map<string, AssessmentSourceGraph>; targets: Map<string, Target>;
  current: AssessmentExternalCapture | null;
  planIds: Set<number>; currentPlanIds: Set<number>;
  sessionVisitIds: Set<number>; currentSessionVisitIds: Set<number>;
}
export const createStudyAssessmentAccess = (): StudyAssessmentAccess => ({ closures: new Map(), graphs: new Map(), targets: new Map(), current: null, planIds: new Set(), currentPlanIds: new Set(), sessionVisitIds: new Set(), currentSessionVisitIds: new Set() });
const cacheKey = (r: AnyAssessmentRevision) => journeyContentHash({ id: r.id, version: r.version, contentHash: r.contentHash,
  orthoCaseId: r.orthoCaseId, clinicalCaseId: r.clinicalCaseId, sources: assessmentRevisionSources(r) });
export function addStudySourceTargets(cache: StudyAssessmentAccess, targets: readonly Target[]) {
  if (cache.current !== null) journeyFail(500, "study_source_union_already_locked");
  for (const target of targets) cache.targets.set(`${target.kind}:${target.id}`, target);
}
export function addStudyPlanTargets(cache: StudyAssessmentAccess, ids: readonly number[]) {
  if (cache.current !== null) journeyFail(500, "study_source_union_already_locked");
  for (const id of ids) cache.planIds.add(id);
}
/** Ortho adjustments supply their own exact case membership. A general visit
 * may have no specialty case yet; this must not authorize its full clinical
 * notes as an assessment source. Keep these two authorities separate. */
export function addStudySessionVisitTargets(cache: StudyAssessmentAccess, ids: readonly number[]) {
  if (cache.current !== null) journeyFail(500, "study_source_union_already_locked");
  for (const id of ids) cache.sessionVisitIds.add(id);
  if (cache.sessionVisitIds.size > 128) journeyFail(409, "study_session_reference_limit");
}
function requireAssessmentClinicalRead(authority: JourneyAuthority) {
  // An export grant or broad patient/image access does not authorize copied
  // assessment facts. Apply this only when an assessment enters the source union.
  if (authority.session.role !== "admin" && authority.session.role !== "doctor")
    journeyFail(403, "study_assessment_clinical_restricted");
}
export async function prepareStudyAssessmentAccess(client: DbClient, scope: JourneyScope, authority: JourneyAuthority,
  revisions: readonly AnyAssessmentRevision[], cache: StudyAssessmentAccess): Promise<void> {
  if (cache.current !== null) journeyFail(500, "study_source_union_already_locked");
  if (revisions.length) requireAssessmentClinicalRead(authority);
  for (const revision of [...revisions].sort((a, b) => a.id - b.id)) {
    if (revision.orthoCaseId !== scope.orthoCaseId || revision.clinicalCaseId !== scope.clinicalCaseId) journeyFail(403, "study_assessment_scope_restricted");
    const key = cacheKey(revision); if (cache.closures.has(key)) continue;
    try {
      const closure = await collectAssessmentSourceClosure(client, scope, assessmentRevisionSources(revision));
      if ([...closure.revisions.values()].some(r => r.patientId !== scope.patientId || r.orthoCaseId !== scope.orthoCaseId || r.clinicalCaseId !== scope.clinicalCaseId)) journeyFail(403, "study_assessment_scope_restricted");
      if (!authority.canViewImages && closure.external.some(s => s.kind === "document" || s.kind === "ceph_study")) journeyFail(403, "study_assessment_sources_restricted");
      cache.closures.set(key, { revision, closure }); addStudySourceTargets(cache, closure.external);
    } catch (error) {
      if (error instanceof AssessmentStoreFault) journeyFail(error.status, "study_assessment_source_unavailable");
      throw error;
    }
  }
}
export async function lockStudySourceUnion(client: DbClient, scope: JourneyScope, authority: JourneyAuthority, cache: StudyAssessmentAccess, beforeExternalCapture?: () => Promise<void>) {
  if (cache.current !== null) journeyFail(500, "study_source_union_already_locked");
  for (const id of [...cache.planIds].sort((a, b) => a - b)) {
    const { rows } = await client.query<{ id: number }>("SELECT id FROM treatment_plans WHERE id=$1 AND patient_id=$2 FOR SHARE", [id, scope.patientId]);
    if (rows[0]) cache.currentPlanIds.add(id);
  }
  if (beforeExternalCapture) await beforeExternalCapture();
  try { cache.current = await captureAssessmentExternalSources(client, scope, [...cache.targets.values()], authority.canViewImages); }
  catch (error) { if (error instanceof AssessmentStoreFault) journeyFail(error.status, "study_source_union_unavailable"); throw error; }
  // Shared visits precede the case and adjustment locks, matching the session
  // writer. Recheck the adjustment -> visit binding after the case lock below.
  if (cache.sessionVisitIds.size) {
    const { rows } = await client.query<{ id: number }>(
      `SELECT id FROM visits WHERE id=ANY($1::int[]) AND patient_id=$2
        AND (case_id IS NULL OR case_id=$3) ORDER BY id FOR SHARE`,
      [[...cache.sessionVisitIds].sort((a,b) => a-b), scope.patientId, scope.clinicalCaseId]);
    for (const row of rows) cache.currentSessionVisitIds.add(row.id);
  }
  for (const [key, { closure }] of cache.closures) cache.graphs.set(key, { ...closure, states: assessmentSourceStates(closure, cache.current), historicallyReadable: cache.current.historicallyReadable });
}
export function requirePreparedAssessmentAccess(cache: StudyAssessmentAccess, revision: AnyAssessmentRevision,
  authority: JourneyAuthority, exactCurrentSources: boolean): boolean {
  requireAssessmentClinicalRead(authority);
  const graph = cache.graphs.get(cacheKey(revision));
  if (!graph) journeyFail(500, "study_assessment_access_not_prepared");
  if (graph.states.some(s => s.state === "unavailable" || exactCurrentSources && s.state !== "available")) journeyFail(exactCurrentSources ? 409 : 403, "study_assessment_sources_changed");
  const images = graph.external.some(s => s.kind === "document" || s.kind === "ceph_study");
  if (images && !authority.canViewImages) journeyFail(403, "study_assessment_sources_restricted"); return images;
}
export function requirePreparedAssessmentReference(cache: StudyAssessmentAccess, reference: JourneyRevisionReference,
  authority: JourneyAuthority, exactCurrentSources: boolean): boolean {
  const selected = [...cache.closures.values()].find(({ revision: r }) => r.id === reference.id && r.version === reference.version && r.contentHash === reference.contentHash);
  if (!selected) journeyFail(403, "study_assessment_reference_unavailable");
  return requirePreparedAssessmentAccess(cache, selected.revision, authority, exactCurrentSources);
}
