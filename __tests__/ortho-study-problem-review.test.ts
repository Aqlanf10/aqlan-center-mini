import { describe, expect, it } from "vitest";
import { readStudyProblemReview, type StudyProblemReview } from "../lib/ortho-study-problem-review";
import { decodeStudySavedContent, type StudySavedContent } from "../lib/ortho-case-study-capture";
import { projectStudyRecordedFacts } from "../lib/ortho-case-study-recorded-facts";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import { syntheticStudyCommand } from "./fixtures/ortho-case-study";
import { isAvailableStudySourceKind, readStudyDraftContent } from "../lib/ortho-case-study";
import { studySourceName } from "../lib/ortho-case-presentation-i18n";
const scope = { patientId: 1, orthoCaseId: 2, clinicalCaseId: 3 };
const review = (): StudyProblemReview => ({ schemaVersion: 1, id: 10, ...scope, problemId: 4,
  problemLabelAtReview: "Synthetic reviewed problem", actorId: 5, reviewedBy: "Synthetic reviewer", reviewedAt: "2026-11-03T10:00:00Z",
  reason: "Explicit source review", supersedesReviewId: null,
  source: { ref: { kind: "assessment_analysis", id: 6, member: "upper_space", version: `sha256:${"a".repeat(64)}` }, identity: "assessment_analysis:upper_space",
    title: "Synthetic measured space", category: "Recorded calculation", summary: "Recorded difference: -2 mm", site: "Upper arch",
    recordedBy: "Synthetic operator", recordedAt: "2026-11-02T10:00:00Z", requiresImages: false, assessmentVersion: 1, snapshotHash: "b".repeat(64) } });
function capture(): StudySavedContent {
  const payload = review(), selection = { key: "review10", kind: "problem_review" as const, id: 10, version: null, contentHash: journeyContentHash(payload) };
  const authored = syntheticStudyCommand().content;
  authored.sources = [selection]; authored.panels = [{ instanceId: "problems", layoutKey: "problem-plan-strategy", included: true,
    state: "available", sourceKeys: [selection.key], images: [], comment: "" }];
  return { schemaVersion: 1, capturedAt: "2026-11-03T11:00:00.000Z", recordedPatientId: scope.patientId, orthoCaseId: scope.orthoCaseId,
    clinicalCaseId: scope.clinicalCaseId, caseStatusAtCapture: "active", authored,
    sources: [{ selection, payload, state: "available", unavailableReason: null, access: { images: false, plans: false } }] };
}
describe("historical clinician problem-review study source", () => {
  it("offers a distinct source and preserves the exact reviewer, observation and hash in compatible panels", () => {
    const saved = capture(), before = JSON.stringify(saved);
    expect(isAvailableStudySourceKind("problem_review")).toBe(true);
    expect(studySourceName("problem_review", "en")).toBe("Clinician-reviewed problem sources");
    expect(readStudyDraftContent(saved.authored)).toEqual(saved.authored);
    for (const layoutKey of ["diagnosis", "objectives", "problem-plan-strategy"]) {
      const current = structuredClone(saved); current.authored.panels[0].layoutKey = layoutKey;
      const projected = projectStudyRecordedFacts(current, scope, "problems", "documented"), text = JSON.stringify(projected.blocks);
      expect(projected.complete).toBe(true);
      for (const fact of [review().problemLabelAtReview, review().reviewedBy, review().source.summary, review().source.ref.version, review().source.snapshotHash]) expect(text).toContain(fact);
      expect(text).not.toMatch(/automatically approved|extraction recommended/);
    }
    expect(JSON.stringify(saved)).toBe(before);
  });
  it("rejects changed identity, source, payload, hash, and missing assessment provenance", () => {
    const changes: ((value: StudyProblemReview) => void)[] = [
      value => { value.patientId++; }, value => { value.source.identity = "clinical_diagnosis:foreign"; },
      value => { value.source.assessmentVersion = null; }, value => { value.supersedesReviewId = value.id; },
      value => { value.source.snapshotHash = "fake"; }, value => { Object.assign(value, { automaticDiagnosis: true }); },
    ];
    for (const change of changes) { const value = review(); change(value); expect(() => readStudyProblemReview(value, scope)).toThrow(); }
    const saved = capture(); (saved.sources[0].payload as StudyProblemReview).source.summary = "Changed";
    expect(decodeStudySavedContent(saved, scope).ok).toBe(false);
    saved.authored.sources[0].version = 1 as never;
    expect(() => readStudyDraftContent(saved.authored)).toThrow("invalid_study_source_version");
  });
  it.each(["ceph_diagnosis", "facial_review"] as const)("requires image disclosure for %s and a pinned facial document", kind => {
    const saved = capture(), payload = saved.sources[0].payload as StudyProblemReview;
    const member = kind === "facial_review" ? "document_91_review" : "final_dx";
    payload.source = { ...payload.source, ref: { ...payload.source.ref, kind, member },
      identity: kind === "facial_review" ? `facial_review:${member}` : "ceph_diagnosis:6:final_dx", assessmentVersion: null,
      requiresImages: true, ...(kind === "facial_review" ? { facialDocument: { id: 91, sha256: "c".repeat(64) } } : {}) };
    saved.authored.sources[0].contentHash = journeyContentHash(payload);
    expect(decodeStudySavedContent(saved, scope).ok).toBe(false);
    saved.sources[0].access.images = true; expect(decodeStudySavedContent(saved, scope).ok).toBe(true);
    payload.source.requiresImages = false; expect(() => readStudyProblemReview(payload, scope)).toThrow();
  });
  it("does not show a historical problem in an unrelated or explicitly hidden panel", () => {
    const saved = capture(); saved.authored.panels[0].layoutKey = "retention";
    expect(projectStudyRecordedFacts(saved, scope, "problems", "draft")).toMatchObject({ complete: false, blocks: [], unmapped: [{ kind: "problem_review" }] });
    saved.authored.panels[0].layoutKey = "diagnosis"; saved.authored.panels[0].state = "restricted";
    expect(projectStudyRecordedFacts(saved, scope, "problems", "draft").blocks).toEqual([]);
  });
});
