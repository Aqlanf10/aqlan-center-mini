import { describe, expect, it } from "vitest";
import { addPanoramicFinding, panoramicFindingId, panoramicFindingReferences, readPanoramicFindingId } from "../lib/ortho-panoramic-findings";
import { newAssessmentEditorV2, assessmentEditorCommandV2 } from "../lib/ortho-assessment-editor-v2";
import { measurementPayloadV2 } from "../lib/ortho-assessment-measurement-editor-v2";
const source = { kind: "document" as const, id: 91, version: `sha256:${"a".repeat(64)}` };
const blank = () => newAssessmentEditorV2("synthetic-panoramic-command-0001", null)!;

describe("panoramic observations in the existing case assessment", () => {
  it("binds exact adult/primary FDI targets and refuses aliases or malformed identities", () => {
    expect(readPanoramicFindingId(panoramicFindingId(91, 53))).toEqual({ documentId: 91, tooth: 53 });
    expect(readPanoramicFindingId(panoramicFindingId(91, null))).toEqual({ documentId: 91, tooth: null });
    for (const id of ["panoramic_v1_091_case", "panoramic_v1_91_tooth_19", "panoramic_v1_91_tooth_86", "panoramic_v1_2147483648_case", "other_91_case"]) expect(readPanoramicFindingId(id)).toBeNull();
  });
  it("preserves unfinished interview values, adds no finding/date and refuses duplicate image/tooth notes", () => {
    const editor = blank(); editor.measurements.values.clinical_chiefComplaint.text = "Unsaved synthetic complaint";
    editor.measurements.values.clinical_chiefComplaint.state = "recorded";
    const before = structuredClone(editor.measurements), added = addPanoramicFinding(editor.measurements, source, 13)!;
    expect(editor.measurements).toEqual(before);
    expect(added.values.clinical_chiefComplaint).toEqual(before.values.clinical_chiefComplaint);
    expect(added.values[panoramicFindingId(91, 13)]).toMatchObject({ state: "not_recorded", dateState: "", method: "", sources: [source] });
    expect(addPanoramicFinding(added, source, 13)).toBeNull();
    expect(addPanoramicFinding(added, { ...source, id: 92 }, 13)).not.toBeNull();
    expect(assessmentEditorCommandV2({ ...editor, reason: "Synthetic", measurements: added })).toBeNull(); // unfinished complaint is not silently erased
  });
  it("requires a source matching each note identity without changing historical decoding", () => {
    const editor = blank(), added = addPanoramicFinding(editor.measurements, source, 13)!;
    const id = panoramicFindingId(91, 13);
    added.values[id] = { ...added.values[id], state: "recorded", text: "Doctor-authored synthetic finding", dateState: "unknown", dateReason: "Historical date unavailable", method: "direct_examination", methodDescription: "Manual review of the selected synthetic image" };
    const payload = measurementPayloadV2(added); expect(payload.ok).toBe(true); if (!payload.ok) throw Error("fixture");
    expect(panoramicFindingReferences(payload.payload)).toEqual({ ok: true, references: [source] });
    const forged = structuredClone(payload.payload), row = forged.observations.observations.find(o => o.id === id)!;
    row.target = { kind: "tooth", tooth: 23 };
    expect(panoramicFindingReferences(forged)).toEqual({ ok: false, code: "invalid_panoramic_target" });
    row.target = { kind: "tooth", tooth: 13 }; row.provenance!.sources[0].id = 92;
    expect(panoramicFindingReferences(forged)).toEqual({ ok: false, code: "missing_panoramic_source" });
  });
});
