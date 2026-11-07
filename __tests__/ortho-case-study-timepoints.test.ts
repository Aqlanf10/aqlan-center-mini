import { describe, expect, it } from "vitest";
import { readStudyDraftContent, type StudyDraftContent } from "../lib/ortho-case-study";
import { CASE_TEMPLATE_VERSION } from "../lib/ortho-case-template";
import { STUDY_TEMPLATE_HASH } from "../lib/ortho-case-study-template";
import { clearStudySourceTimepoint, projectStudyTimepoints, readStudyTimepoints, setStudyTimepoint, STUDY_TIMEPOINTS } from "../lib/ortho-case-study-timepoints";
import type { OccurrenceEvidence } from "../lib/ortho-case-occurrence";

const unknown: OccurrenceEvidence = { occurredOn: null, dateProvenance: "unknown", sourceNote: "Synthetic historical date not recorded" };
function draft(): StudyDraftContent {
  return { template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: STUDY_TEMPLATE_HASH },
    identityDisclosure: "case_only", sources: STUDY_TIMEPOINTS.map((_, i) => ({ key: `assessment_${i}`, kind: "assessment", id: i + 1, version: i + 1, contentHash: String(i + 1).repeat(64) })),
    groups: [], panels: [], mediaUses: [], comment: "Synthetic study" };
}
describe("explicit T1–T4 documentary source groups", () => {
  it("preserves exact sources, unknown dates and authored labels across a strict round trip", () => {
    const original = draft(), before = JSON.stringify(original);
    let value = original;
    for (const [index, stage] of STUDY_TIMEPOINTS.entries()) value = setStudyTimepoint(value, stage,
      { occurrence: unknown, sourceKeys: [`assessment_${index}`], label: `${stage} Synthetic recorded stage` });
    const reopened = readStudyDraftContent(JSON.parse(JSON.stringify(value)));
    const projected = projectStudyTimepoints(reopened);
    expect(projected.map(row => row.stage)).toEqual(STUDY_TIMEPOINTS);
    projected.forEach((row, index) => {
      expect(row.occurrence).toEqual(unknown);
      expect(row.sources).toEqual([original.sources[index]]);
      expect(row.label).toBe(`${row.stage} Synthetic recorded stage`);
      expect(Object.keys(row).sort()).toEqual(["groupId", "label", "occurrence", "sources", "stage"]);
    });
    expect(JSON.stringify(original)).toBe(before);
  });
  it("requires explicit occurrence evidence and never substitutes capture dates or stage order", () => {
    const initial = setStudyTimepoint(draft(), "T2", { occurrence: { occurredOn: "2026-01-01", dateProvenance: "historical_source", sourceNote: "Explicit source date" }, sourceKeys: ["assessment_1"] });
    const value = setStudyTimepoint(initial, "T1", { occurrence: unknown, sourceKeys: ["assessment_0"] });
    expect(readStudyTimepoints(value).map(row => row.occurrence.occurredOn)).toEqual([null, "2026-01-01"]);
    expect(() => setStudyTimepoint(value, "T3", { occurrence: { ...unknown, occurredOn: "2026-11-05" }, sourceKeys: [] })).toThrow("invalid_occurrence");
    expect(() => setStudyTimepoint(value, "T3", { occurrence: { occurredOn: "2026-02-30", dateProvenance: "retrospective_record", sourceNote: "Invalid date" }, sourceKeys: [] })).toThrow("invalid_occurrence_date");
  });
  it("rejects duplicate stages, duplicate source keys and unknown selections", () => {
    const value = setStudyTimepoint(draft(), "T1", { occurrence: unknown, sourceKeys: ["assessment_0"] });
    expect(() => readStudyTimepoints({ ...value, groups: [...value.groups, { ...value.groups[0], id: "other_group" }] })).toThrow("duplicate_study_timepoint");
    expect(() => setStudyTimepoint(value, "T1", { occurrence: unknown, sourceKeys: ["assessment_0", "assessment_0"] })).toThrow("duplicate_study_timepoint_source");
    expect(() => setStudyTimepoint(value, "T2", { occurrence: unknown, sourceKeys: ["foreign_source"] })).toThrow("study_timepoint_source_not_selected");
  });
  it("requires an explicit clear before moving a source, including aliased source keys", () => {
    const base = draft(); base.sources.push({ ...base.sources[0], key: "alias" });
    const value = setStudyTimepoint(base, "T1", { occurrence: unknown, sourceKeys: ["assessment_0"] });
    for (const key of ["assessment_0", "alias"]) expect(() => setStudyTimepoint(value, "T2", { occurrence: unknown, sourceKeys: [key] })).toThrow("conflicting_study_source_timepoints");
    const cleared = clearStudySourceTimepoint(value, "assessment_0");
    expect(cleared.groups[0]).toEqual({ ...value.groups[0], sourceKeys: [] });
    expect(cleared.sources).toEqual(value.sources);
    const moved = setStudyTimepoint(cleared, "T2", { occurrence: unknown, sourceKeys: ["assessment_0"] });
    expect(readStudyTimepoints(moved).map(row => row.sources.length)).toEqual([0, 1]);
    expect(value.groups[0].sourceKeys).toEqual(["assessment_0"]);
  });
  it("preserves unrelated groups and never guesses stages from their labels or IDs", () => {
    const base = draft(); base.groups.push({ id: "T1", label: "T2", phase: null, occurrence: unknown, sourceKeys: ["assessment_0"] });
    expect(readStudyTimepoints(base)).toEqual([]);
    const added = setStudyTimepoint(base, "T3", { occurrence: unknown, sourceKeys: ["assessment_0"] });
    const cleared = clearStudySourceTimepoint(added, "assessment_0");
    expect(cleared.groups[0]).toEqual(base.groups[0]);
    expect(cleared.groups[1].sourceKeys).toEqual([]);
    base.groups.push({ id: "timepoint_T4", label: "Other retained group", phase: null, occurrence: unknown, sourceKeys: [] });
    expect(() => setStudyTimepoint(base, "T4", { occurrence: unknown, sourceKeys: [] })).toThrow("study_timepoint_group_id_conflict");
  });
  it("updates a stage in place and returns copied projection metadata without numeric inference", () => {
    const base = setStudyTimepoint(draft(), "T1", { occurrence: unknown, sourceKeys: ["assessment_0"], label: "Original label" });
    const updated = setStudyTimepoint(base, "T1", { occurrence: unknown, sourceKeys: ["assessment_1"] });
    expect(updated.groups).toHaveLength(1);
    expect(updated.groups[0].id).toBe(base.groups[0].id);
    expect(updated.groups[0].label).toBe("Original label");
    const projected = projectStudyTimepoints(updated);
    projected[0].occurrence.sourceNote = "Changed local view";
    projected[0].sources[0].contentHash = "a".repeat(64);
    expect(updated.groups[0].occurrence).toEqual(unknown);
    expect(updated.sources[1].contentHash).toBe("2".repeat(64));
    expect(JSON.stringify(projectStudyTimepoints(updated))).not.toMatch(/delta|improvement|normal|approved/);
  });
});
