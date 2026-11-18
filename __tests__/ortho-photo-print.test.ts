import { describe, expect, it } from "vitest";
import {
  DEFAULT_PHOTO_PRINT_LAYOUT, DEFAULT_PHOTO_STAGE_REQUIREMENTS, FULL_SET_VIEWS, PHOTO_VIEW_PRINT_LABEL,
  parsePhotoPrintLayout, photoPrintLayout,
} from "@/lib/ortho-photos";
import { buildCaptureSheet, type CompletenessDocument } from "@/lib/ortho-photo-completeness";
import { validateTypedSetting } from "@/lib/settings-validate";
import { SETTING_DEFAULTS } from "@/lib/settings";

/** OP-3 (contract v2.1). Synthetic documents only. */
describe("print layout setting (OP-3)", () => {
  it("defaults: extraoral row, intraoral row with patient sides, occlusal row, overjet row", () => {
    expect(DEFAULT_PHOTO_PRINT_LAYOUT).toEqual([
      ["profile", "extraoral_frontal", "smile", "extraoral_45"],
      ["intraoral_right", "intraoral_frontal", "intraoral_left"],
      ["upper_occlusal", "lower_occlusal"],
      ["overjet"],
    ]);
    expect(SETTING_DEFAULTS["ortho.photo_print_layout"]).toBe("");
    expect(parsePhotoPrintLayout("")).toEqual({ ok: true, value: DEFAULT_PHOTO_PRINT_LAYOUT });
    expect(validateTypedSetting("ortho.photo_print_layout", "")).toBeNull();
  });

  it("accepts a clinic's own order", () => {
    const own = [["extraoral_frontal", "smile", "profile"], ["intraoral_left", "intraoral_frontal", "intraoral_right"], ["upper_occlusal", "lower_occlusal"]];
    expect(parsePhotoPrintLayout(JSON.stringify(own))).toEqual({ ok: true, value: own });
  });

  it.each([
    ["not JSON", "["], ["an object", "{}"], ["an empty layout", "[]"], ["an empty row", "[[]]"],
    ["a radiograph", JSON.stringify([["panoramic"]])], ["an unknown view", JSON.stringify([["selfie"]])],
    ["a duplicate", JSON.stringify([["smile"], ["smile"]])], ["a row over four", JSON.stringify([["smile", "profile", "extraoral_frontal", "extraoral_45", "overjet"]])],
  ])("rejects %s with an Arabic message", (_label, raw) => {
    const parsed = parsePhotoPrintLayout(raw);
    expect(parsed.ok).toBe(false);
    expect(validateTypedSetting("ortho.photo_print_layout", raw)).toMatch(/[؀-ۿ]/);
    expect(photoPrintLayout(raw)).toEqual(DEFAULT_PHOTO_PRINT_LAYOUT);
  });

  it("labels side views by the patient's side explicitly", () => {
    expect(PHOTO_VIEW_PRINT_LABEL.intraoral_right).toBe("داخل الفم — جانب المريض الأيمن");
    expect(PHOTO_VIEW_PRINT_LABEL.intraoral_left).toBe("داخل الفم — جانب المريض الأيسر");
  });
});

let id = 100;
const doc = (extra: Partial<CompletenessDocument> = {}): CompletenessDocument => ({
  id: id++, patientId: 1, orthoCaseId: 2, adjustmentId: 3, isImage: true, removedAt: null,
  photoStage: "initial", photoView: "smile", takenOn: "2026-01-04", ...extra,
});
const sheet = (documents: CompletenessDocument[], target: Partial<{ stage: "initial"; takenOn: string; adjustmentId: number | null }> = {}) =>
  buildCaptureSheet({
    documents, patientId: 1, caseId: 2, stage: "initial", takenOn: "2026-01-04", adjustmentId: 3, ...target,
    requirements: DEFAULT_PHOTO_STAGE_REQUIREMENTS, layout: DEFAULT_PHOTO_PRINT_LAYOUT,
  });

describe("buildCaptureSheet (OP-3)", () => {
  it("one capture set only: other dates, sessions, stages, cases, removed, archived and non-images are excluded", () => {
    const own = doc({ photoView: "smile" });
    const result = sheet([
      own, doc({ takenOn: "2026-01-05" }), doc({ adjustmentId: 4 }), doc({ adjustmentId: null }), doc({ photoStage: "progress" }),
      doc({ orthoCaseId: 9 }), doc({ patientId: 7 }), doc({ removedAt: "2026-02-01T00:00:00.000Z" }), doc({ photoStage: "archived" }), doc({ isImage: false }),
    ]);
    if (result.status !== "ready") throw new Error("empty");
    const shown = result.rows.flat().filter(cell => cell.photo).map(cell => cell.photo!.id);
    expect(shown).toEqual([own.id]);
  });

  it("required views missing show as empty frames; absent optional views are omitted; present optional views shown", () => {
    const result = sheet([doc({ photoView: "smile" }), doc({ photoView: "overjet" })]);
    if (result.status !== "ready") throw new Error("empty");
    expect(result.rows.map(row => row.map(cell => [cell.view, cell.photo ? "photo" : "empty"]))).toEqual([
      [["profile", "empty"], ["extraoral_frontal", "empty"], ["smile", "photo"]],
      [["intraoral_right", "empty"], ["intraoral_frontal", "empty"], ["intraoral_left", "empty"]],
      [["upper_occlusal", "empty"], ["lower_occlusal", "empty"]],
      [["overjet", "photo"]],
    ]);
    expect(result.missingRequired).toHaveLength(7);
  });

  it("a duplicated view shows the earliest document and states how many more exist", () => {
    const first = doc({ photoView: "smile" }); doc(); const third = doc({ photoView: "smile" });
    const result = sheet([third, first, doc({ photoView: "smile" })]);
    if (result.status !== "ready") throw new Error("empty");
    const smile = result.rows.flat().find(cell => cell.view === "smile")!;
    expect(smile.photo?.id).toBe(first.id);
    expect(smile.extraCount).toBe(2);
  });

  it("a photographed view outside the layout is never hidden: it goes to an extra row", () => {
    const layout = [["smile"]] as const;
    const result = buildCaptureSheet({
      documents: [doc({ photoView: "smile" }), doc({ photoView: "profile" })], patientId: 1, caseId: 2, stage: "initial",
      takenOn: "2026-01-04", adjustmentId: 3, requirements: DEFAULT_PHOTO_STAGE_REQUIREMENTS, layout: layout.map(row => [...row]),
    });
    if (result.status !== "ready") throw new Error("empty");
    expect(result.otherViews.map(cell => cell.view)).toEqual(["profile"]);
  });

  it("radiographs never appear on the photo sheet; a set with no photo is 'empty'", () => {
    expect(sheet([doc({ photoView: "lateral_ceph" }), doc({ photoView: "panoramic" })])).toEqual({ status: "empty" });
    expect(sheet([])).toEqual({ status: "empty" });
  });

  it("a full eight-view set has no missing view", () => {
    const result = sheet(FULL_SET_VIEWS.map(photoView => doc({ photoView })));
    if (result.status !== "ready") throw new Error("empty");
    expect(result.missingRequired).toEqual([]);
  });
});
