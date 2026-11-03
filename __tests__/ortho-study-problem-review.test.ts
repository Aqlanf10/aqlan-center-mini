import { describe, expect, it } from "vitest";
import { readStudyProblemReview, type StudyProblemReview } from "../lib/ortho-study-problem-review";
import { decodeStudySavedContent, type StudySavedContent } from "../lib/ortho-case-study-capture";
import { projectStudyRecordedFacts } from "../lib/ortho-case-study-recorded-facts";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import { CASE_TEMPLATE_VERSION } from "../lib/ortho-case-template";
import { STUDY_TEMPLATE_HASH } from "../lib/ortho-case-study-template";
const scope = { patientId: 1, orthoCaseId: 2, clinicalCaseId: 3 };
const review = (): StudyProblemReview => ({ schemaVersion: 1, id: 10, ...scope, problemId: 4, problemLabelAtReview: "Synthetic explicitly reviewed problem",
  actorId: 5, reviewedBy: "Synthetic clinician", reviewedAt: "2026-11-03T10:00:00Z", reason: "Synthetic review", supersedesReviewId: null,
  source: { ref: { kind: "assessment_analysis", id: 6, member: "upper_space", version: `sha256:${"a".repeat(64)}` }, identity: "assessment_analysis:upper_space",
    title: "Synthetic measured space", category: "نتيجة حسابية تحتاج تفسير الطبيب", summary: "Synthetic measured difference: -2 mm", site: "الفك العلوي",
    recordedBy: "Synthetic measurement operator", recordedAt: "2026-11-02T10:00:00Z", requiresImages: false, assessmentVersion: 1, snapshotHash: "b".repeat(64) } });
function capture(): StudySavedContent {
  const payload = review(), selection = { key: "review10", kind: "problem_review" as const, id: 10, version: null, contentHash: journeyContentHash(payload) };
  return { schemaVersion: 1, capturedAt: "2026-11-03T11:00:00Z", recordedPatientId: scope.patientId, orthoCaseId: scope.orthoCaseId, clinicalCaseId: scope.clinicalCaseId,
    caseStatusAtCapture: "active", authored: { template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: STUDY_TEMPLATE_HASH },
      identityDisclosure: "case_only", sources: [selection], groups: [], mediaUses: [], comment: "", panels: [{ instanceId: "problems", layoutKey: "problem-plan-strategy", included: true,
        state: "available", sourceKeys: [selection.key], images: [], comment: "" }] },
    sources: [{ selection, payload, state: "available", unavailableReason: null, access: { images: false, plans: false } }] };
}
describe("reviewed problem source as historical study evidence", () => {
  it("retains the reviewed label, reviewer, source version and numeric observation without inferring a treatment", () => {
    const saved = capture(), before = JSON.stringify(saved), result = projectStudyRecordedFacts(saved, scope, "problems", "documented"), text = JSON.stringify(result.blocks);
    expect(result.complete).toBe(true); expect(text).toContain("Synthetic explicitly reviewed problem"); expect(text).toContain("Synthetic measured difference: -2 mm");
    expect(text).toContain(review().source.ref.version); expect(text).toContain(review().source.snapshotHash); expect(text).toContain("Synthetic clinician");
    expect(text).not.toMatch(/extraction recommended|automatically approved/); expect(JSON.stringify(saved)).toBe(before);
  });
  it("rejects substituted source, case, review identity and clinical payload fields", () => {
    for (const mutate of [(x: StudyProblemReview) => { x.patientId = 9; }, (x: StudyProblemReview) => { x.source.identity = "clinical_diagnosis:foreign"; },
      (x: StudyProblemReview) => { x.source.assessmentVersion = null; }, (x: StudyProblemReview) => { x.supersedesReviewId = x.id; },
      (x: StudyProblemReview) => { x.source.snapshotHash = "fake"; }, (x: StudyProblemReview) => { Object.assign(x, { automaticTreatment: "extract" }); }]) {
      const raw = review(); mutate(raw); expect(() => readStudyProblemReview(raw, scope)).toThrow();
    }
    const raw = capture(); (raw.sources[0].payload as StudyProblemReview).source.summary = "Substitution";
    expect(decodeStudySavedContent(raw, scope).ok).toBe(false);
  });
  it("requires imaging disclosure for a ceph review and keeps unmapped panels explicit", () => {
    const raw = capture(), payload = raw.sources[0].payload as StudyProblemReview;
    payload.source = { ...payload.source, ref: { ...payload.source.ref, kind: "ceph_diagnosis", member: "final_dx" }, identity: "ceph_diagnosis:6:final_dx", assessmentVersion: null, requiresImages: true };
    raw.authored.sources[0].contentHash = journeyContentHash(payload); raw.sources[0].selection = raw.authored.sources[0];
    expect(decodeStudySavedContent(raw, scope).ok).toBe(false); raw.sources[0].access.images = true;
    expect(decodeStudySavedContent(raw, scope).ok).toBe(true); raw.authored.panels[0].layoutKey = "retention";
    expect(projectStudyRecordedFacts(raw, scope, "problems", "draft")).toMatchObject({ complete: false, blocks: [], unmapped: [{ kind: "problem_review" }] });
  });
});
