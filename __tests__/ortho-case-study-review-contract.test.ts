import { describe, expect, it } from "vitest";
import { readStudyPanelReview, type StudyReviewExpected } from "../lib/ortho-case-study-review-contract";
const expected: StudyReviewExpected = { patientId: 19, orthoCaseId: 41, clinicalCaseId: 51, revisionId: 91,
  revisionHash: "a".repeat(64), kind: "draft", panelId: "panel1", layoutKey: "diagnosis", sourceKeys: ["diagnosis1"], panelState: "available", included: true, comments: ["Synthetic saved comment"] };
function response() {
  return { ok: true, patientId: 19, orthoCaseId: 41, clinicalCaseId: 51, revisionId: 91, revisionHash: expected.revisionHash,
    kind: "draft", panelId: "panel1", layoutKey: "diagnosis", panelState: "available", title: "التشخيص", included: true, capturedAt: "2026-10-01T00:00:00.000Z",
    blocks: [{ kind: "paragraph", text: "Synthetic recorded fact", sourceKeys: ["diagnosis1"], review: "draft" }],
    comments: [...expected.comments], unavailable: [], unmapped: [], pendingMediaCount: 0 };
}
describe("strict request-bound saved-panel reader", () => {
  it("accepts only the exact requested saved envelope without normalizing facts", () => {
    const value = response(), original = JSON.stringify(value); expect(readStudyPanelReview(value, expected)).toEqual(value); expect(JSON.stringify(value)).toBe(original);
  });
  it.each(["patientId", "orthoCaseId", "clinicalCaseId", "revisionId"] as const)("refuses changed %s", field => {
    expect(() => readStudyPanelReview({ ...response(), [field]: 999 }, expected)).toThrow();
  });
  it.each([{ revisionHash: "b".repeat(64) }, { kind: "documented" }, { panelId: "panel2" }, { layoutKey: "smile" }, { included: false }])("refuses changed immutable selection %j", delta => {
    expect(() => readStudyPanelReview({ ...response(), ...delta }, expected)).toThrow();
  });
  it("refuses unrelated source keys, clinical approval promotion and unknown fields", () => {
    const value = response();
    expect(() => readStudyPanelReview({ ...value, blocks: [{ ...value.blocks[0], sourceKeys: ["foreign_source"] }] }, expected)).toThrow();
    expect(() => readStudyPanelReview({ ...value, blocks: [{ ...value.blocks[0], review: "approved" }] }, expected)).toThrow();
    expect(() => readStudyPanelReview({ ...value, invoice: { paid: 10 } }, expected)).toThrow();
    expect(() => readStudyPanelReview({ ...value, comments: ["Different current draft"] }, expected)).toThrow();
  });
  it("rejects nested malformed cells and oversized display rather than truncating them", () => {
    const value = response(), table = { kind: "table", headers: ["Field"], rows: [{ cells: [["value"]], sourceKeys: ["diagnosis1"], review: "draft" }] };
    expect(() => readStudyPanelReview({ ...value, blocks: [table] }, expected)).toThrow();
    expect(() => readStudyPanelReview({ ...value, blocks: [{ ...value.blocks[0], text: "x".repeat(20001) }] }, expected)).toThrow();
  });
});

it.each(["not_recorded", "unavailable", "restricted"] as const)("binds %s to requested state and rejects injected ordinary facts", panelState => {
  const wanted = { ...expected, panelState, sourceKeys: panelState === "not_recorded" ? [] : expected.sourceKeys }, value = { ...response(), panelState, blocks: [] };
  expect(readStudyPanelReview(value, wanted).panelState).toBe(panelState);
  expect(() => readStudyPanelReview({ ...value, blocks: response().blocks }, wanted)).toThrow("study_panel_state_forbids_facts");
  expect(() => readStudyPanelReview({ ...value, panelState: "available" }, wanted)).toThrow();
});
it("enforces exact 200-block, 4000-total-row and 1MiB-text boundaries without truncation", () => {
  const paragraph = response().blocks[0];
  expect(readStudyPanelReview({ ...response(), blocks: Array.from({ length: 200 }, () => ({ ...paragraph })) }, expected).blocks).toHaveLength(200);
  expect(() => readStudyPanelReview({ ...response(), blocks: Array.from({ length: 201 }, () => ({ ...paragraph })) }, expected)).toThrow();
  const table = (count: number) => ({ kind: "table", headers: ["Field"], rows: Array.from({ length: count }, () => ({ cells: ["x"], sourceKeys: ["diagnosis1"], review: "draft" })) });
  expect(readStudyPanelReview({ ...response(), blocks: [table(2000), table(2000)] }, expected).blocks).toHaveLength(2);
  expect(() => readStudyPanelReview({ ...response(), blocks: [table(2000), table(2001)] }, expected)).toThrow("study_panel_row_limit");
  const blocks = Array.from({ length: 64 }, () => ({ ...paragraph, text: "x".repeat(16384) }));
  const wanted = { ...expected, comments: [] }, value = { ...response(), title: "", comments: [], blocks };
  expect(readStudyPanelReview(value, wanted).blocks).toHaveLength(64);
  const tooLarge = { ...value, blocks: blocks.map((block, index) => index ? block : { ...block, text: block.text + "x" }) };
  expect(() => readStudyPanelReview(tooLarge, wanted)).toThrow("study_panel_text_limit");
});
