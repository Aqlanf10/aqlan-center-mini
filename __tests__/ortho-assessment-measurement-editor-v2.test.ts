import { describe, expect, it } from "vitest";
import { blankMeasurementEditorV2, editMeasurementPayloadV2, measurementPayloadV2, measurementReadinessV2,
  changeMeasurementDecimalV2, applyMeasurementSessionV2, linkMeasurementInputV2, addMeasurementSetV2 } from "../lib/ortho-assessment-measurement-editor-v2";
function ready() {
  const draft = blankMeasurementEditorV2();
  for (const row of draft.payload.observations.observations) Object.assign(draft.values[row.id], {
    state: row.definition === "dentition" ? "recorded" : "measured", text: "permanent",
    numberText: row.definition === "arch_available_space" ? "90" : "10", dateState: "known", date: "2026-10-01",
    method: "direct_examination", methodDescription: "Synthetic measured record", performer: "documented", performerAttribution: "Synthetic examiner",
  });
  draft.payload.analyses = [
    { state: "draft", id: "upper", measurementSetId: "current", method: "arch_space", arch: "upper" },
    { state: "draft", id: "lower", measurementSetId: "current", method: "arch_space", arch: "lower" },
    { state: "draft", id: "anterior", measurementSetId: "current", method: "bolton_anterior" },
    { state: "draft", id: "overall", measurementSetId: "current", method: "bolton_overall" },
  ];
  return draft;
}
describe("new shared measurement editor reconstruction", () => {
  it("starts with35 untouched values and no guessed source/date/normal findings", () => {
    const draft = blankMeasurementEditorV2();
    expect(draft.payload.observations.observations).toHaveLength(35);
    expect(draft.payload.observations.observations.every(o => o.value.state === "not_recorded" && o.occurredOn === null && o.provenance === null)).toBe(true);
    expect(measurementPayloadV2(draft).ok).toBe(true);
  });
  it("preserves independent ready analyses while an unrelated raw input is partial; save refuses all invalid fields", () => {
    const draft = ready(); draft.values.width_18.numberText = "7.";
    expect(measurementPayloadV2(draft).ok).toBe(false);
    const readyAnalyses = measurementReadinessV2(draft);
    expect(readyAnalyses.analyses).toHaveLength(4);
    expect(readyAnalyses.analyses.every(a => a.readiness.ok && a.readiness.value.state === "ready")).toBe(true);
    draft.values.width_11.numberText = "-";
    expect(measurementReadinessV2(draft).analyses.find(a => a.selection.id === "lower")?.readiness).toMatchObject({ ok: true, value: { state: "ready" } });
    expect(measurementReadinessV2(draft).analyses.find(a => a.selection.id === "anterior")?.readiness).toMatchObject({ ok: true, value: { state: "incomplete" } });
  });
  it("keeps absent/not-erupted applicability explicit and never substitutes zero", () => {
    const draft = ready(); draft.values.width_11.state = "tooth_absent"; draft.values.width_11.reason = "Synthetic documented absent tooth";
    expect(measurementReadinessV2(draft).analyses.find(a => a.selection.id === "anterior")?.readiness)
      .toMatchObject({ ok: true, value: { state: "inapplicable", reason: "tooth_absent", tooth: 11 } });
  });
  it("normalizes only complete numbers when switching decimal mode and leaves partial text unchanged", () => {
    const draft = ready(); draft.values.width_11.numberText = "7.5"; draft.values.width_12.numberText = "7.";
    const changed = changeMeasurementDecimalV2(draft, "٫");
    expect(changed.values.width_11.numberText).toBe("7٫5"); expect(changed.values.width_12.numberText).toBe("7.");
    expect(draft.values.width_11.numberText).toBe("7.5");
  });
  it("applies explicit session metadata without changing numbers and refuses untouched or historical targets", () => {
    const draft = ready(), before = draft.values.width_12.numberText;
    expect(applyMeasurementSessionV2(draft, "width_11", ["width_12"]).ok).toBe(false);
    const applied = applyMeasurementSessionV2(draft, "width_11", ["width_12"], true);
    if (!applied.ok) throw Error(applied.code);
    expect(applied.draft.values.width_12.numberText).toBe(before);
    expect(applied.draft.values.width_12.sources).not.toBe(draft.values.width_11.sources);
    draft.values.width_12.state = "not_recorded"; expect(applyMeasurementSessionV2(draft, "width_11", ["width_12"], true).ok).toBe(false);
    draft.values.width_12.state = "measured";
    draft.values.width_12.copiedFrom = { kind: "observation_v2", revisionId: 1, contentHash: "a".repeat(64), observationId: "old" };
    expect(applyMeasurementSessionV2(draft, "width_11", ["width_12"], true).ok).toBe(false);
  });
  it("explicitly links existing missing inputs without cloning a value or overwriting old observations", () => {
    const draft = ready(), extra = addMeasurementSetV2(draft)!;
    const linked = linkMeasurementInputV2(extra, "set_1", { kind: "tooth", tooth: 11 }, "width_11")!;
    expect(linked.payload.observations.observations).toHaveLength(35);
    expect(linked.payload.measurementSets[1].toothWidthObservationIds).toEqual(["width_11"]);
    expect(linkMeasurementInputV2(extra, "set_1", { kind: "tooth", tooth: 12 }, "width_11")).toBeNull();
    const fresh = linkMeasurementInputV2(extra, "set_1", { kind: "available", arch: "upper" })!;
    expect(fresh.payload.observations.observations).toHaveLength(36);
    expect(fresh.payload.observations.observations.at(-1)?.value).toEqual({ state: "not_recorded" });
  });
  it("round-trips validated saved payloads while correction drafts leave prior witnesses detached", () => {
    const payload = measurementPayloadV2(ready()); if (!payload.ok) throw Error("invalid fixture");
    const old = JSON.stringify(payload.payload), editor = editMeasurementPayloadV2(payload.payload)!;
    editor.values.width_11.numberText = "12";
    expect(JSON.stringify(payload.payload)).toBe(old);
    expect(measurementPayloadV2(editor)).toMatchObject({ ok: true });
  });
});
