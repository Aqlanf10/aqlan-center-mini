import { afterEach, describe, expect, it, vi } from "vitest";
import { assessmentCommandV2 } from "./fixtures/ortho-assessment-schema2";
import { assessmentJsonHash, createPersistedAssessmentV2, decodeAnyAssessmentRevision, type AssessmentRevisionV2 } from "../lib/ortho-assessment-persisted-v2";
import * as currentEngine from "../lib/ortho-assessment-engine-v2";
import { decodeStudySavedContent, type StudySavedContent } from "../lib/ortho-case-study-capture";
import { projectStudyRecordedFacts } from "../lib/ortho-case-study-recorded-facts";
import { studyPageNotes, validateStudyNotesProjection } from "../lib/ortho-study-presentation-notes";
import { checkedStudyPageNotes } from "../lib/ortho-study-model-analysis-evidence";
import { studyTextPresentation } from "../lib/ortho-study-text-export";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import { canonicalJourneyJSON } from "../lib/ortho-case-journey-json";
import { CASE_TEMPLATE_VERSION } from "../lib/ortho-case-template";
import { STUDY_TEMPLATE_HASH } from "../lib/ortho-case-study-template";
import type { StudyRevision } from "../lib/ortho-case-study-history";

// Replace only the mutable current engine facade. Historical verification keeps
// its real, version-pinned implementation and is not mocked by these tests.
vi.mock("../lib/ortho-assessment-engine-v2", async importOriginal => {
  const original = await importOriginal<typeof import("../lib/ortho-assessment-engine-v2")>();
  return { ...original, deriveDraftAnalysisV2: vi.fn(original.deriveDraftAnalysisV2) };
});
afterEach(() => vi.mocked(currentEngine.deriveDraftAnalysisV2).mockReset());

const scope = { patientId: 19, orthoCaseId: 41, clinicalCaseId: 51 };
function assessment(): AssessmentRevisionV2 {
  const command = assessmentCommandV2();
  // One actual saved set/result remains incomplete; missing measurement and
  // unknown occurrence/performer are not converted into zero or today's date.
  const lower = command.content.observations.observations.find(row => row.id === "available_lower")!;
  lower.value = { state: "unknown", reason: "Synthetic historical lower space unknown" };
  lower.occurredOn = { state: "unknown", reason: "Synthetic occurrence date not recorded" };
  lower.provenance!.performer = { state: "unknown" };
  const stored = createPersistedAssessmentV2(command.content);
  if (!stored.ok) throw new Error(stored.code);
  const revision: AssessmentRevisionV2 = { ...scope, id: 91, recordedPatientId: scope.patientId, schemaVersion: 2, version: 1,
    supersedesRevisionId: null, createdAt: "2026-01-01T00:00:00.000Z", createdBy: "Synthetic historical examiner", reason: command.reason,
    recordingContext: "retrospective", content: stored.value, contentHash: assessmentJsonHash(stored.value) };
  expect(decodeAnyAssessmentRevision(revision, scope)).toEqual({ ok: true, value: revision });
  return revision;
}
function captured(payload: AssessmentRevisionV2, layoutKey = "model-measurements"): StudySavedContent {
  const selection = { key: "historical_assessment", kind: "assessment" as const, id: payload.id, version: payload.version, contentHash: payload.contentHash };
  return { schemaVersion: 1, capturedAt: "2026-10-01T00:00:00.000Z", recordedPatientId: scope.patientId, orthoCaseId: scope.orthoCaseId,
    clinicalCaseId: scope.clinicalCaseId, caseStatusAtCapture: "completed",
    authored: { template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: STUDY_TEMPLATE_HASH },
      identityDisclosure: "case_only", sources: [selection], groups: [], mediaUses: [], comment: "Synthetic preserved comment",
      panels: [{ instanceId: "historical_panel", layoutKey, included: true, state: "available", sourceKeys: [selection.key], images: [], comment: "" }] },
    sources: [{ selection, state: "available", unavailableReason: null, access: { images: false, plans: false }, payload }] };
}
function studyRevision(content: StudySavedContent): StudyRevision<StudySavedContent> {
  return { ...scope, id: 92, actorId: 7, version: 1, recordedPatientId: scope.patientId, schemaVersion: 1, predecessorId: null,
    kind: "draft", documentedFromId: null, baseDocumentedId: null, createdAt: content.capturedAt,
    reason: "Synthetic saved study", contentHash: journeyContentHash(content), content };
}

describe("historical assessment study boundaries", () => {
  it("refuses unsupported schema1 bytes rather than inventing a legacy decoder or projection", () => {
    const supported = assessment();
    // There is no valid schema1 fixture: the production decoder deliberately
    // refuses this unavailable historical format, as does the assessment suite.
    const legacy = { ...supported, schemaVersion: 1, content: { sources: [], unknownLegacyField: "Synthetic uninterpreted legacy bytes" } };
    legacy.contentHash = assessmentJsonHash(legacy.content);
    const before = JSON.stringify(legacy), study = captured(supported);
    study.authored.sources[0].contentHash = legacy.contentHash;
    study.sources[0].payload = legacy;
    expect(decodeAnyAssessmentRevision(legacy, scope)).toEqual({ ok: false, code: "unsupported_schema" });
    expect(decodeStudySavedContent(study, scope)).toEqual({ ok: false, code: "unsupported_schema" });
    expect(() => projectStudyRecordedFacts(study, scope, "historical_panel", "draft")).toThrow("unsupported_schema");
    expect(JSON.stringify(legacy)).toBe(before);
  });
  it("keeps unsupported schema identity explicitly unavailable in review and text export", () => {
    const study = captured(assessment());
    study.sources[0] = { ...study.sources[0], state: "unavailable", unavailableReason: "source_schema_unavailable", payload: null };
    const before = JSON.stringify(study);
    expect(decodeStudySavedContent(study, scope).ok).toBe(true);
    const facts = projectStudyRecordedFacts(study, scope, "historical_panel", "draft");
    expect(facts).toMatchObject({ complete: false, blocks: [], unavailable: [{ sourceKey: "historical_assessment", reason: "source_schema_unavailable" }] });
    const exported = studyTextPresentation(studyRevision(study), scope).pages.flatMap(page => page.lines).join("");
    expect(exported).toContain("مصدر غير متاح");
    expect(exported).toContain("Synthetic preserved comment");
    expect(exported).not.toContain("Synthetic historical lower space unknown");
    expect(JSON.stringify(study)).toBe(before);
  });
  it("projects frozen valid schema2 facts and witnesses without calling the mutable current engine", () => {
    const payload = assessment(), study = captured(payload), before = JSON.stringify(study);
    vi.mocked(currentEngine.deriveDraftAnalysisV2).mockClear().mockImplementation(() => { throw new Error("current_engine_must_not_run_during_historical_display"); });
    const facts = projectStudyRecordedFacts(study, scope, "historical_panel", "documented");
    const cells = facts.blocks.flatMap(block => block.kind === "table" ? block.rows.map(row => row.cells[1]) : []);
    expect(facts.complete).toBe(true);
    expect(cells).toEqual(expect.arrayContaining(["70 mm", "0 mm", "100 %", "77.2 %", "المدخلات غير مكتملة", "مسودة حسابية؛ غير معتمدة سريريًا",
      "Bolton 1962, DOI 10.1016/0002-9416(62)90129-X, pp.506–508,517"]));
    const lowerTable = facts.modelTables.find(table => table.analysisId === "space_lower")!;
    const lowerBlock = facts.blocks[lowerTable.blockIndex]; expect(lowerBlock.kind).toBe("table");
    if (lowerBlock.kind === "table") {
      expect(lowerBlock.rows.map(row => row.cells)).toContainEqual(["حالة الحساب", "المدخلات غير مكتملة"]);
      expect(lowerBlock.rows.some(row => row.cells[0] === "المتاح ناقص المطلوب")).toBe(false);
    }
    const output = studyTextPresentation(studyRevision(study), scope);
    expect(output.revisionHash).toBe(journeyContentHash(study));
    validateStudyNotesProjection(output);
    const serialized = checkedStudyPageNotes(output.pages.map(page => studyPageNotes(output, page, "synthetic-historical-acceptance")));
    const notes: ReturnType<typeof studyPageNotes>[] = serialized.map(note => JSON.parse(note));
    const evidence = notes.flatMap(note => note.modelAnalyses);
    expect(evidence).toEqual(facts.modelAnalyses); expect(evidence).toHaveLength(payload.content.results.length);
    for (const result of payload.content.results) {
      const witness = evidence.find(item => item.exactWitness.stored.analysisId === result.analysisId)!;
      expect(witness.source).toEqual(study.authored.sources[0]); expect(witness.panelInstanceId).toBe("historical_panel");
      expect(witness.exactWitness).toEqual({ selection: payload.content.draft.analyses.find(row => row.id === result.analysisId), stored: result });
      expect(canonicalJourneyJSON(witness.exactWitness.stored.result)).toBe(canonicalJourneyJSON(result.result));
      expect(witness.exactWitness.stored.resultHash).toBe(result.resultHash);
      const { witnessHash, ...exact } = witness; expect(witnessHash).toBe(journeyContentHash(exact));
      if (result.result.state === "ready") expect(canonicalJourneyJSON(witness.exactWitness.stored.result)).toContain("ortho-model-2.1.0");
    }
    expect(vi.mocked(currentEngine.deriveDraftAnalysisV2)).not.toHaveBeenCalled();
    expect(JSON.stringify(study)).toBe(before);
  });
  it("preserves unknown measurement, occurrence and performer provenance without filling defaults", () => {
    const study = captured(assessment(), "cast-analysis"), before = JSON.stringify(study);
    const text = JSON.stringify(projectStudyRecordedFacts(study, scope, "historical_panel", "draft").blocks);
    expect(text).toContain("Synthetic historical lower space unknown");
    expect(text).toContain("Synthetic occurrence date not recorded");
    expect(text).toContain("unknown"); expect(text).toContain("available_lower");
    expect(text).not.toContain("2026-10-01");
    expect(JSON.stringify(study)).toBe(before);
  });
  it("rejects a rehashed altered historical result instead of silently replacing it with recomputation", () => {
    const payload = assessment();
    const ready = payload.content.results.find(row => row.result.state === "ready")!;
    expect(ready.result.state).toBe("ready");
    if (ready.result.state !== "ready") throw new Error("missing valid ready fixture");
    Object.assign(ready.result.witness, { clinicalApproval: "approved" });
    ready.resultHash = assessmentJsonHash(ready.result);
    payload.contentHash = assessmentJsonHash(payload.content);
    const study = captured(payload), before = JSON.stringify(study);
    expect(decodeStudySavedContent(study, scope)).toEqual({ ok: false, code: "result_reconstruction_mismatch" });
    expect(() => projectStudyRecordedFacts(study, scope, "historical_panel", "draft")).toThrow("result_reconstruction_mismatch");
    expect(JSON.stringify(study)).toBe(before);
  });
});
