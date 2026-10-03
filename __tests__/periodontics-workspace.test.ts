import { describe, expect, it } from "vitest";
import { changedDraftCells, displayedTeeth, draftCoverage, editorDraft, editorIsDirty, editSite, eligibleCases, normalizeDepthInput, parseDepthText, serializeEditor } from "../components/periodontics/workspace-model";
import { examFixture } from "./periodontics-workspace-fixtures";

describe("periodontics workspace explicit input model", () => {
  it.each(["", "0", "0.00", "0.01", "1.01", "99.99"])("accepts the exact numeric contract %s", (text) => expect(parseDepthText(text)).toEqual({ ok: true, value: text === "" ? null : Number(text) }));
  it.each([" ", " 1", "1 ", "-1", "+1", "1e1", "NaN", "Infinity", "100", "99.999", "0.000", "1.", ".1", "1,2", "1_2", "1 2", "١٫٢", "١،٢"])("rejects unnormalized or ambiguous input %s", (text) => expect(parseDepthText(text).ok).toBe(false));
  it("normalizes only digit glyphs and the unambiguous Arabic decimal separator", () => {
    expect(normalizeDepthInput("١٢٫٢٥")).toBe("12.25");
    expect(normalizeDepthInput("۱۲٫۲۵")).toBe("12.25");
    expect(normalizeDepthInput("١٬٢٣٤،٥٠")).toBe("1٬234،50");
    expect(normalizeDepthInput("١٫٢٣٤")).toBe("1.234");
    expect(parseDepthText(normalizeDepthInput("١٫٢٣٤")).ok).toBe(false);
  });
  it("does not infer provider, case choice or six normal cells for a new visit", () => {
    const empty = editorDraft(null, null);
    expect(empty).toEqual({ doctorId: null, caseId: undefined, expectedRevision: null, sites: [] });
    expect(serializeEditor(empty).ok).toBe(false);
    expect(editorDraft(null, 20).caseId).toBe(20);
    expect(editorDraft(null, 20).doctorId).toBeNull();
  });
  it("retains hidden observations and explicit null/zero/false in a full snapshot", () => {
    const original = examFixture();
    let draft = editorDraft(original, null);
    expect(displayedTeeth([11], draft, false)).toEqual([11]);
    draft = editSite(draft, 11, "B", { depthText: "٠" });
    draft = editSite(draft, 11, "DB", { bleedingOnProbing: false });
    const result = serializeEditor(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.expectedRevision).toBe(3);
    expect(result.value.sites).toContainEqual(original.sites[1]);
    expect(result.value.sites).toContainEqual({ toothCode: 11, site: "B", probingDepthMm: 0, bleedingOnProbing: null });
    expect(result.value.sites).toContainEqual({ toothCode: 11, site: "DB", probingDepthMm: null, bleedingOnProbing: false });
    expect(displayedTeeth([11], draft, true)).toContain(48);
    expect(original.sites).toHaveLength(2);
  });
  it("clearing retains a site's stable identity rather than removing its row", () => {
    const draft = editSite(editorDraft(examFixture(), null), 11, "MB", { depthText: "", bleedingOnProbing: null });
    const result = serializeEditor(draft);
    expect(result.ok && result.value.sites).toContainEqual({ toothCode: 11, site: "MB", probingDepthMm: null, bleedingOnProbing: null });
    expect(draftCoverage(draft)).toEqual({ recordedDepthSites: 1, recordedBleedingSites: 0, bleedingSites: 0, bleedingPercent: null });
  });
  it("does not modify the snapshot merely by displaying a tooth", () => {
    const draft = editorDraft(null, null);
    displayedTeeth([11, 12, 55], draft, true);
    expect(draft.sites).toEqual([]);
    expect(editorIsDirty(draft, editorDraft(null, null))).toBe(false);
    expect(draftCoverage(draft).bleedingPercent).toBeNull();
  });
  it("retains invalid typed precision in the dirty draft while refusing serialization", () => {
    const baseline = editorDraft(examFixture(), null);
    const draft = editSite(baseline, 11, "MB", { depthText: "1.001" });
    expect(draft.sites[0].depthText).toBe("1.001");
    expect(editorIsDirty(draft, baseline)).toBe(true);
    expect(serializeEditor(draft).ok).toBe(false);
    expect(changedDraftCells(draft, examFixture())).toHaveLength(1);
  });
  it("limits selectable cases to this patient's active/waiting periodontal cases", () => {
    const candidate = { id: 1, patientId: 1, title: "Case", specialty: "periodontics", status: "active" };
    const cases = [candidate, { ...candidate, id: 2, status: "waiting" }, { ...candidate, id: 3, patientId: 2 },
      { ...candidate, id: 4, specialty: "endo" }, { ...candidate, id: 5, status: "completed" }];
    expect(eligibleCases(cases, 1).map((item) => item.id)).toEqual([1, 2]);
  });
});
