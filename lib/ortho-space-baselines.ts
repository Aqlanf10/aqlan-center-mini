/** Admission for saved space baselines. Caller holds current patient/session
 * authority, prepares its complete source union, and locks it before resolving.
 * No calculation is reconstructed under a newer engine or treated as diagnosis. */
import type { DbClient } from "./db";
import { journeyFail, type JourneyAuthority, type JourneyOwner } from "./ortho-case-journey-authority";
import { AssessmentStoreFault } from "./ortho-assessment-authority";
import { ASSESSMENT_COLUMNS, decodeAssessmentStoredRow, type AssessmentStoredRow } from "./ortho-assessment-versioned-sources";
import { assessmentStoredByteCount } from "./ortho-assessment-limits";
import type { AssessmentRevisionV2 } from "./ortho-assessment-persisted-v2";
import { prepareStudyAssessmentAccess, requirePreparedAssessmentAccess, type StudyAssessmentAccess } from "./ortho-case-study-assessment-access";
import { readProblemSourceRef, type ProblemSourceRef } from "./ortho-problem-sources";
import { journeyContentHash } from "./ortho-case-journey-hash";
import type { SpaceArch } from "./ortho-space-ledger";
export interface SpaceBaseline { ref: ProblemSourceRef; arch: SpaceArch; discrepancyMm: number; estimated: boolean; revision: AssessmentRevisionV2 }
export interface PreparedSpaceAssessmentSources { latestRevisionId: number | null; baselines: SpaceBaseline[]; cache: StudyAssessmentAccess }

function project(revision: AssessmentRevisionV2): SpaceBaseline[] {
  return revision.content.results.flatMap(entry => {
    if (entry.result.state !== "ready" || entry.result.witness.result.state !== "calculated") return [];
    const result = entry.result.witness.result;
    if (result.method !== "arch_space" && result.method !== "tanaka_johnston_1974_approximation_v1") return [];
    const selection = revision.content.draft.analyses.find(a => a.id === entry.analysisId);
    if (!selection || !("arch" in selection)) journeyFail(409, "space_baseline_invalid");
    const discrepancyMm = result.method === "arch_space" ? result.availableMinusRequiredMm : result.availableMinusEstimatedRequiredMm;
    if (!Number.isFinite(discrepancyMm)) journeyFail(409, "space_baseline_invalid");
    return [{ ref: { kind: "assessment_analysis" as const, id: revision.id, member: entry.analysisId, version: `sha256:${revision.contentHash}` },
      arch: selection.arch, discrepancyMm, estimated: result.method !== "arch_space", revision }];
  });
}

/** Metadata budgets precede full payload reads. Latest means the actual newest
 * revision, never the newest revision that happens to decode or yield a result. */
export async function prepareSpaceAssessmentSources(client: DbClient, scope: JourneyOwner, authority: JourneyAuthority,
  refs: readonly ProblemSourceRef[], cache: StudyAssessmentAccess, options: { includeLatest?: boolean } = {}): Promise<PreparedSpaceAssessmentSources> {
  if (!authority.canViewPlans) journeyFail(403, "space_plan_access");
  if (cache.current !== null) journeyFail(500, "study_source_union_already_locked");
  if (!Array.isArray(refs) || refs.length > 1000) journeyFail(409, "space_baseline_budget");
  const selected = new Map<number, ProblemSourceRef[]>();
  for (const raw of refs) {
    const ref = readProblemSourceRef(raw);
    if (!ref || ref.kind !== "assessment_analysis") journeyFail(400, "space_baseline_invalid");
    selected.set(ref.id, [...selected.get(ref.id) ?? [], ref]);
  }
  const latest = options.includeLatest === false ? undefined : (await client.query<{ id: number }>("SELECT id FROM ortho_assessment_revisions WHERE patient_id=$1 AND ortho_case_id=$2 AND clinical_case_id=$3 ORDER BY version DESC LIMIT 1", [scope.patientId,scope.orthoCaseId,scope.clinicalCaseId])).rows[0];
  const ids = [...new Set([...selected.keys(), ...latest ? [latest.id] : []])].sort((a,b) => a-b);
  if (ids.length > 32) journeyFail(409, "space_baseline_budget");
  let bytes = 0;
  const baselines: SpaceBaseline[] = [], revisions: AssessmentRevisionV2[] = [];
  try {
    for (const id of ids) {
      const meta = (await client.query<{ bytes: string }>("SELECT octet_length(content::text)::text AS bytes FROM ortho_assessment_revisions WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3 AND clinical_case_id=$4", [id,scope.patientId,scope.orthoCaseId,scope.clinicalCaseId])).rows[0];
      if (!meta) journeyFail(403, "space_baseline_unavailable");
      const count = assessmentStoredByteCount(meta.bytes);
      if (count === null || count > 1048576 || (bytes += count) > 4194304) journeyFail(409, "space_baseline_budget");
      const row = (await client.query<AssessmentStoredRow>(`SELECT ${ASSESSMENT_COLUMNS} FROM ortho_assessment_revisions WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3 AND clinical_case_id=$4`, [id,scope.patientId,scope.orthoCaseId,scope.clinicalCaseId])).rows[0];
      const revision = decodeAssessmentStoredRow(row,scope);
      if (revision.schemaVersion !== 2) journeyFail(409, "space_baseline_unsupported");
      const projected = project(revision);
      for (const ref of selected.get(id) ?? []) if (!projected.some(b => journeyContentHash(b.ref) === journeyContentHash(ref))) journeyFail(409, "space_baseline_changed");
      revisions.push(revision); baselines.push(...projected);
    }
    for (const revision of revisions) {
      await prepareStudyAssessmentAccess(client,scope,authority,[revision],cache);
      // Bound actual cached closure payloads, including repeated copies shared
      // by distinct roots. Per-closure limits alone permit multiplicative growth.
      let graphBytes = bytes;
      for (const { closure } of cache.closures.values()) for (const prior of closure.revisions.values()) {
        graphBytes += Buffer.byteLength(JSON.stringify(prior.content));
        if (graphBytes > 8388608) journeyFail(409, "space_baseline_budget");
      }
    }
  } catch (error) {
    if (error instanceof AssessmentStoreFault) journeyFail(error.status,error.code,error.message);
    throw error;
  }
  return { latestRevisionId: latest?.id ?? null, baselines, cache };
}

export function requireSpaceBaseline(prepared: PreparedSpaceAssessmentSources, ref: ProblemSourceRef, arch: SpaceArch,
  authority: JourneyAuthority, policy: { requireLatest: boolean; exactCurrentSources: boolean }): SpaceBaseline {
  if (!authority.canViewPlans) journeyFail(403, "space_plan_access");
  const baseline = prepared.baselines.find(b => b.arch === arch && journeyContentHash(b.ref) === journeyContentHash(ref));
  if (!baseline || policy.requireLatest && baseline.revision.id !== prepared.latestRevisionId) journeyFail(409, "space_baseline_changed");
  requirePreparedAssessmentAccess(prepared.cache,baseline.revision,authority,policy.exactCurrentSources);
  return baseline;
}

export function spaceBaselineChoices(prepared: PreparedSpaceAssessmentSources, authority: JourneyAuthority): Omit<SpaceBaseline,"revision">[] {
  if (!authority.canViewPlans) journeyFail(403, "space_plan_access");
  // Calling before the complete source union is locked is a programming error,
  // not an empty list of clinically eligible choices.
  if (prepared.cache.current === null) journeyFail(500, "study_assessment_access_not_prepared");
  return prepared.baselines.filter(b => {
    if (b.revision.id !== prepared.latestRevisionId) return false;
    const graphAvailable = (() => { try { requirePreparedAssessmentAccess(prepared.cache,b.revision,authority,true); return true; }
      catch (error) { if (error instanceof Error && "status" in error && error.status === 409) return false; throw error; } })();
    return graphAvailable;
  }).map(({ revision: _revision, ...baseline }) => baseline);
}
