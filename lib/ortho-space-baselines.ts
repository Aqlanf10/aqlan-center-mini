import type { AnyAssessmentRevision } from "./ortho-assessment-persisted-v2";
import type { ProblemSourceRef } from "./ortho-problem-sources";
export function spaceBaselines(revisions: AnyAssessmentRevision[]) {
  return revisions.flatMap(r => r.schemaVersion !== 2 ? [] : r.content.results.flatMap(result => {
    if (result.result.state !== "ready" || result.result.witness.result.state !== "calculated") return [];
    const n = result.result.witness.result;
    if (n.method !== "arch_space" && n.method !== "tanaka_johnston_1974_approximation_v1") return [];
    const selection = r.content.draft.analyses.find(a => a.id === result.analysisId);
    if (!selection || !("arch" in selection)) return [];
    return [{ ref: { kind: "assessment_analysis", id: r.id, member: result.analysisId, version: `sha256:${r.contentHash}` } as ProblemSourceRef,
      arch: selection.arch, discrepancyMm: n.method === "arch_space" ? n.availableMinusRequiredMm : n.availableMinusEstimatedRequiredMm,
      estimated: n.method !== "arch_space", revision: r }];
  }));
}
