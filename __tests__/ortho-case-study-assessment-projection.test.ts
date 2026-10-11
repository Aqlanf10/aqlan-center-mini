import { describe, expect, it } from "vitest";
import { blankClinicalObservationV2, CLINICAL_FIELDS_V2 } from "../lib/ortho-assessment-findings-v2";
import type { AssessmentRevisionV2 } from "../lib/ortho-assessment-persisted-v2";
import { projectStudyAssessment, STUDY_CLINICAL_PANEL_FIELDS } from "../lib/ortho-case-study-assessment-projection";
function revision(): AssessmentRevisionV2 {
  return { id: 7, patientId: 19, recordedPatientId: 19, orthoCaseId: 41, clinicalCaseId: 51,
    version: 1, supersedesRevisionId: null, createdAt: "2026-10-01T12:00:00.000Z", createdBy: "synthetic-doctor", reason: "وثيقة اصطناعية",
    recordingContext: "retrospective", contentHash: "a".repeat(64), schemaVersion: 2,
    content: { schemaVersion: 2, verifierVersion: "ortho-assessment-payload-2.1.0", results: [],
      draft: { schemaVersion: 2, observations: { schemaVersion: 2, dentitionObservationId: null,
        observations: CLINICAL_FIELDS_V2.map(([field]) => blankClinicalObservationV2(field)) }, measurementSets: [], analyses: [] } } };
}
const empty = { measurementSetIds: [], analysisIds: [] };
describe("exact stored assessment-to-study projection", () => {
  it("maps each registered field once, by exact definition rather than labels", () => {
    expect(Object.values(STUDY_CLINICAL_PANEL_FIELDS).flat().slice().sort()).toEqual(CLINICAL_FIELDS_V2.map(([field]) => field).sort());
    const source = revision(); source.content.draft.observations.observations[0].label = "facialProfile";
    const result = projectStudyAssessment(source, empty);
    expect(result.panels.interview[0].id).toBe("clinical_chiefComplaint");
    expect(result.unmappedCount).toBe(0);
    expect(result.clinicalApproval).toBe("unapproved");
    expect(result.intraoralOverview.clinicalFindings).toBe("not_projected");
  });
  it("retains explicit missing values, occurrence provenance and recorder without auto-normal", () => {
    const source = revision(); const row = source.content.draft.observations.observations[0];
    row.value = { state: "unknown", reason: "لم يتوفر المصدر" };
    row.occurredOn = { state: "unknown", reason: "تاريخ تاريخي غير معلوم" };
    row.provenance = { performer: { state: "unknown" }, method: { version: 1, kind: "external_report", description: "مرجع اصطناعي" }, sources: [], copiedFrom: null };
    const before = JSON.stringify(source); const output = projectStudyAssessment(source, empty);
    expect(output.panels.interview[0]).toEqual(row);
    expect(output.revision).toMatchObject({ recordedBy: source.createdBy, recordedAt: source.createdAt, recordingContext: "retrospective" });
    expect(output.panels["dental-relations"].find(value => value.id === "clinical_overjet")?.value).toEqual({ state: "not_recorded" });
    output.panels.interview[0].label = "detached copy";
    expect(JSON.stringify(source)).toBe(before);
  });
  it.each(["definition", "definitionVersion", "unit", "target"] as const)("discloses conflicting %s instead of placing a field falsely", key => {
    const source = revision(); const row = source.content.draft.observations.observations[0];
    const corrupt = { ...row, [key]: key === "definition" ? "growth_assessment" : key === "definitionVersion" ? 2 : key === "unit" ? "mm" : { kind: "arch", arch: "upper" } };
    // Boundary-negative fixture: caller normally supplies strictly decoded persisted data.
    Object.assign(row, corrupt);
    const output = projectStudyAssessment(source, empty);
    expect(output.panels.interview.some(value => value.id === row.id)).toBe(false);
    expect(output.unmapped).toEqual([{ observation: corrupt, reason: "clinical_definition_mismatch" }]);
    expect(output.unmappedCount).toBe(1);
  });
  it("preserves unknown observation identity without label-based guessing", () => {
    const source = revision(); const original = source.content.draft.observations.observations[0];
    source.content.draft.observations.observations.push({ ...original, id: "unregistered_measurement", label: "overjet" });
    const output = projectStudyAssessment(source, empty);
    expect(output.unmappedCount).toBe(1);
    expect(output.unmapped[0]).toMatchObject({ observation: { id: "unregistered_measurement" }, reason: "not_selected_or_unmapped" });
  });
  it("copies an exact stored non-ready analysis without inventing computed values or approval", () => {
    const source = revision();
    source.content.draft.measurementSets = [{ id: "set1", toothWidthObservationIds: [], upperAvailableObservationId: null, lowerAvailableObservationId: null }];
    source.content.draft.analyses = [{ id: "analysis1", state: "draft", measurementSetId: "set1", method: "bolton_overall" }];
    source.content.results = [{ analysisId: "analysis1", result: { state: "unsupported_dentition", dependencyObservationIds: [] }, resultHash: "b".repeat(64) }];
    const before = JSON.stringify(source);
    const output = projectStudyAssessment(source, { measurementSetIds: ["set1"], analysisIds: ["analysis1"] });
    expect(output.analyses).toEqual([{ selection: source.content.draft.analyses[0], stored: source.content.results[0], clinicalApproval: "unapproved" }]);
    expect(output.cast.measurementSets).toEqual(source.content.draft.measurementSets);
    expect(JSON.stringify(source)).toBe(before);
    expect(() => projectStudyAssessment(source, { measurementSetIds: [], analysisIds: ["analysis1"] })).toThrow("missing_selected_stored_analysis");
  });
  it("requires exact selected measurement/analysis identities", () => {
    expect(() => projectStudyAssessment(revision(), { measurementSetIds: ["missing"], analysisIds: [] })).toThrow("missing_selected_measurement_set");
    expect(() => projectStudyAssessment(revision(), { measurementSetIds: [], analysisIds: ["missing"] })).toThrow("missing_selected_stored_analysis");
    expect(() => projectStudyAssessment(revision(), { measurementSetIds: ["same", "same"], analysisIds: [] })).toThrow("invalid_assessment_projection_selection");
  });
});
