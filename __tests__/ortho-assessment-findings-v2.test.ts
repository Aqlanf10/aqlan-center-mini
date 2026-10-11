import { describe, expect, it } from "vitest";
import { CLINICAL_FIELDS_V2, addClinicalFieldV2, blankClinicalObservationV2, clinicalFieldIdV2 } from "../lib/ortho-assessment-findings-v2";
import { blankMeasurementEditorV2, measurementPayloadV2, applyMeasurementSessionV2 } from "../lib/ortho-assessment-measurement-editor-v2";
import { newAssessmentEditorV2, readAssessmentEditorV2, assessmentEditorCommandV2 } from "../lib/ortho-assessment-editor-v2";
describe("once-entered clinical findings in the schema2 assessment draft", () => {
  it("creates only untouched observations without normal findings, dates, examiners or copied history", () => {
    const draft = newAssessmentEditorV2("synthetic-clinical-start", null)!;
    expect(CLINICAL_FIELDS_V2).toHaveLength(25);
    for (const [field] of CLINICAL_FIELDS_V2) {
      const row = draft.measurements.payload.observations.observations.find(o => o.id === clinicalFieldIdV2(field));
      expect(row).toEqual(blankClinicalObservationV2(field));
      expect(row).toMatchObject({ value: { state: "not_recorded" }, occurredOn: null, provenance: null });
    }
    expect(new Set(draft.measurements.payload.observations.observations.map(o => o.id)).size).toBe(60);
  });
  it("adds missing clinical fields explicitly without replacing a conflicting saved identity or duplicating measurements", () => {
    const original = blankMeasurementEditorV2(), next = addClinicalFieldV2(original, "chiefComplaint")!;
    expect(original.payload.observations.observations).toHaveLength(35);
    expect(next.payload.observations.observations).toHaveLength(36);
    expect(next.payload.measurementSets).toEqual(original.payload.measurementSets);
    expect(addClinicalFieldV2(next, "chiefComplaint")).toBeNull();
  });
  it("requires per-value provenance and keeps signed zero/negative occlusal measurements distinct from missing", () => {
    const draft = newAssessmentEditorV2("synthetic-clinical-command", null)!; draft.reason = "Synthetic complete source witnesses";
    const complaint = draft.measurements.values.clinical_chiefComplaint;
    Object.assign(complaint, { state: "recorded", text: "Synthetic complaint", dateState: "unknown", dateReason: "Source date not documented",
      method: "direct_examination", methodDescription: "Explicit synthetic interview", performer: "documented", performerAttribution: "Synthetic examiner" });
    const jet = draft.measurements.values.clinical_overjet, bite = draft.measurements.values.clinical_overbite;
    Object.assign(jet, { state: "measured", numberText: "-2" }); Object.assign(bite, { state: "measured", numberText: "0" });
    expect(measurementPayloadV2(draft.measurements).ok).toBe(false);
    const applied = applyMeasurementSessionV2(draft.measurements, "clinical_chiefComplaint", ["clinical_overjet", "clinical_overbite"], false);
    if (!applied.ok) throw Error(applied.code);
    draft.measurements = applied.draft;
    const command = assessmentEditorCommandV2(draft)!;
    expect(command.content.observations.observations.find(o => o.id === "clinical_overjet")?.value).toEqual({ state: "measured", value: -2 });
    expect(command.content.observations.observations.find(o => o.id === "clinical_overbite")?.value).toEqual({ state: "measured", value: 0 });
    expect(command.content.observations.observations.find(o => o.id === "clinical_medicalHistory")?.value).toEqual({ state: "not_recorded" });
    expect(readAssessmentEditorV2(JSON.stringify(draft))).toEqual(draft);
  });
});
