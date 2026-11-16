import { describe, expect, it } from "vitest";
import { CLINICAL_FIELDS_V2, clinicalFieldIdV2, editClinicalFindingValueV2, isClinicalFieldIdentityV2 } from "../lib/ortho-assessment-findings-v2";
import { newAssessmentEditorV2, assessmentEditorCommandV2 } from "../lib/ortho-assessment-editor-v2";
import { blankMeasurementEditorV2, editMeasurementNumberV2, measurementPayloadV2 } from "../lib/ortho-assessment-measurement-editor-v2";

describe("explicit value-first assessment entry", () => {
  it("leaves every untouched field empty and unrecorded, with no source, date or examiner invented", () => {
    const editor = newAssessmentEditorV2("synthetic-direct-entry", null)!;
    for (const [field] of CLINICAL_FIELDS_V2) {
      const before = structuredClone(editor.measurements);
      const empty = editClinicalFindingValueV2(before, field, "")!;
      expect(empty).toEqual(before);
      const entered = editClinicalFindingValueV2(before, field, ["overjet", "overbite"].includes(field) ? "0" : "Explicit synthetic finding")!;
      expect(entered.values[clinicalFieldIdV2(field)]).toMatchObject({
        state: ["overjet", "overbite"].includes(field) ? "measured" : "recorded", dateState: "", method: "", sources: [], performer: "unknown",
      });
      expect(before).toEqual(editor.measurements);
      expect(assessmentEditorCommandV2({ ...editor, reason: "Synthetic reason", measurements: entered })).toBeNull();
    }
  });
  it("keeps erasure incomplete rather than silently discarding its source or converting it to normal/unrecorded", () => {
    const draft = newAssessmentEditorV2("synthetic-erasure", null)!.measurements;
    const entered = editClinicalFindingValueV2(draft, "chiefComplaint", "An explicitly entered complaint")!;
    Object.assign(entered.values.clinical_chiefComplaint, { dateState: "known", date: "2026-11-11", method: "direct_examination", methodDescription: "Synthetic interview" });
    const erased = editClinicalFindingValueV2(entered, "chiefComplaint", "")!;
    expect(erased.values.clinical_chiefComplaint).toMatchObject({ state: "recorded", text: "", date: "2026-11-11", method: "direct_examination" });
    expect(measurementPayloadV2(erased).ok).toBe(false);
  });
  it.each(["unknown", "not_measured", "unavailable", "not_applicable"] as const)("preserves explicit %s and its reason rather than replacing it from a value callback", state => {
    const draft = newAssessmentEditorV2("synthetic-exception", null)!.measurements;
    Object.assign(draft.values.clinical_chiefComplaint, { state, reason: "Synthetic explicit refusal or examination exception" });
    const before = structuredClone(draft);
    expect(editClinicalFindingValueV2(draft, "chiefComplaint", "must not replace exception")).toBeNull();
    expect(draft).toEqual(before);
  });
  it("rejects a conflicting field identity without overwriting the original", () => {
    const draft = newAssessmentEditorV2("synthetic-identity", null)!.measurements;
    draft.payload.observations.observations.find(row => row.id === "clinical_chiefComplaint")!.target = { kind: "arch", arch: "upper" };
    expect(isClinicalFieldIdentityV2(draft, "chiefComplaint")).toBe(false);
    expect(editClinicalFindingValueV2(draft, "chiefComplaint", "must not replace identity")).toBeNull();
  });
});

describe("explicit value-first measurements", () => {
  it.each(["0", "-2", "7.", "٫", "7٫2"])("preserves the exact authored numeric text %s without fabricating metadata", input => {
    const draft = blankMeasurementEditorV2(), before = structuredClone(draft);
    const next = editMeasurementNumberV2(draft, "width_11", input)!;
    expect(next.values.width_11).toMatchObject({ state: "measured", numberText: input, dateState: "", method: "", sources: [] });
    expect(next.values.width_12).toEqual(before.values.width_12);
    expect(draft).toEqual(before);
    expect(measurementPayloadV2(next).ok).toBe(false);
  });
  it("distinguishes an untouched blank from an erased entered number", () => {
    const draft = blankMeasurementEditorV2();
    expect(editMeasurementNumberV2(draft, "width_11", "")).toEqual(draft);
    const entered = editMeasurementNumberV2(draft, "width_11", "7")!;
    const erased = editMeasurementNumberV2(entered, "width_11", "")!;
    expect(erased.values.width_11).toMatchObject({ state: "measured", numberText: "" });
    expect(measurementPayloadV2(erased).ok).toBe(false);
  });
  it.each(["unknown", "not_measured", "unavailable", "not_applicable", "tooth_absent", "not_erupted"] as const)("does not treat %s as a measurement or zero", state => {
    const draft = blankMeasurementEditorV2(); Object.assign(draft.values.width_11, { state, reason: "Explicit synthetic reason" });
    expect(editMeasurementNumberV2(draft, "width_11", "0")).toBeNull();
    expect(draft.values.width_11).toMatchObject({ state, numberText: "", reason: "Explicit synthetic reason" });
  });
  it("cannot write a number into dentition or an absent input", () => {
    const draft = blankMeasurementEditorV2();
    expect(editMeasurementNumberV2(draft, "dentition", "7")).toBeNull();
    expect(editMeasurementNumberV2(draft, "missing", "7")).toBeNull();
  });
});
