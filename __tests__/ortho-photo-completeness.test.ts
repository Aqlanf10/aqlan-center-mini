import { describe, expect, it } from "vitest";
import { DEFAULT_PHOTO_STAGE_REQUIREMENTS, FULL_SET_VIEWS } from "@/lib/ortho-photos";
import { decodeCompletenessDocuments, photoCompleteness, type CompletenessDocument } from "@/lib/ortho-photo-completeness";

/** OP-2 (contract v2.1). Synthetic documents only; never real images or identifiers. */
let nextId = 1;
const doc = (extra: Partial<CompletenessDocument> = {}): CompletenessDocument => ({
  id: nextId++, patientId: 1, orthoCaseId: 2, adjustmentId: 3, isImage: true, removedAt: null,
  photoStage: "initial", photoView: "smile", takenOn: "2026-01-04", ...extra,
});
const set = (views: readonly string[], extra: Partial<CompletenessDocument> = {}) => views.map(view => doc({ photoView: view, ...extra }));
const run = (documents: CompletenessDocument[], requirements = DEFAULT_PHOTO_STAGE_REQUIREMENTS, visible: { photosVisible: boolean | undefined } = { photosVisible: true }) =>
  photoCompleteness({ documents, patientId: 1, caseId: 2, photosVisible: visible.photosVisible, requirements });

describe("photoCompleteness (OP-2)", () => {
  it("a complete eight-view capture set is complete; optional views are listed but not counted", () => {
    const result = run([...set(FULL_SET_VIEWS), doc({ photoView: "extraoral_45" })]);
    if (result.status !== "ready") throw new Error("hidden");
    expect(result.sets).toHaveLength(1);
    expect(result.sets[0]).toMatchObject({ stage: "initial", takenOn: "2026-01-04", adjustmentId: 3, requiredCount: 8, requiredPresent: 8, missingRequired: [] });
    expect(result.sets[0].optionalPresent).toEqual(["extraoral_45"]);
    expect(result.sets[0].optionalMissing).toEqual(["overjet"]);
  });

  it("names the missing views of an incomplete set", () => {
    const result = run(set(FULL_SET_VIEWS.slice(0, 7)));
    if (result.status !== "ready") throw new Error("hidden");
    expect(result.sets[0]).toMatchObject({ requiredPresent: 7, missingRequired: ["lower_occlusal"] });
  });

  it("never merges one stage photographed on two dates into a false complete set", () => {
    const result = run([...set(FULL_SET_VIEWS.slice(0, 4), { takenOn: "2026-01-04" }), ...set(FULL_SET_VIEWS.slice(4), { takenOn: "2026-01-11" })]);
    if (result.status !== "ready") throw new Error("hidden");
    expect(result.sets.map(s => [s.takenOn, s.requiredPresent])).toEqual([["2026-01-04", 4], ["2026-01-11", 4]]);
    expect(result.sets.every(s => s.missingRequired.length === 4)).toBe(true);
  });

  it("never merges two sessions on the same day, nor a session with an unlinked upload", () => {
    const result = run([...set(FULL_SET_VIEWS.slice(0, 4), { adjustmentId: 3 }), ...set(FULL_SET_VIEWS.slice(4), { adjustmentId: 4 }), doc({ adjustmentId: null, photoView: "profile" })]);
    if (result.status !== "ready") throw new Error("hidden");
    expect(result.sets.map(s => [s.adjustmentId, s.requiredPresent])).toEqual([[3, 4], [4, 4], [null, 1]]);
  });

  it("counts unclassified images separately and never into a view", () => {
    const result = run([doc({ takenOn: null }), doc({ photoView: null }), doc({ photoStage: null }), doc({ photoStage: "unknown" }), doc({ photoView: "selfie" })]);
    if (result.status !== "ready") throw new Error("hidden");
    expect(result.unclassified).toBe(5);
    expect(result.sets).toEqual([]);
  });

  it("excludes removed, archived, non-image, other-case and other-patient documents", () => {
    const result = run([
      doc({ removedAt: "2026-02-01T10:00:00.000Z" }), doc({ photoStage: "archived" }), doc({ isImage: false }),
      doc({ orthoCaseId: 9 }), doc({ orthoCaseId: null }), doc({ patientId: 7 }),
    ]);
    if (result.status !== "ready") throw new Error("hidden");
    expect(result.sets).toEqual([]);
    expect(result.unclassified).toBe(0);
  });

  it("keeps radiographs out of photo completeness and reports them separately for start and end", () => {
    const result = run([...set(FULL_SET_VIEWS.slice(0, 7)), doc({ photoView: "lateral_ceph" }), doc({ photoView: "panoramic", photoStage: "debond", takenOn: "2027-06-01" })]);
    if (result.status !== "ready") throw new Error("hidden");
    expect(result.sets).toHaveLength(1);
    expect(result.sets[0]).toMatchObject({ requiredCount: 8, requiredPresent: 7 });
    expect(result.radiographs).toEqual([
      { stage: "initial", lateralCeph: ["2026-01-04"], panoramic: [] },
      { stage: "debond", lateralCeph: [], panoramic: ["2027-06-01"] },
    ]);
  });

  it("lists stages with no capture set and orders sets by stage then date", () => {
    const result = run([...set(["smile"], { photoStage: "progress", takenOn: "2026-06-01" }), ...set(["smile"], { photoStage: "initial", takenOn: "2026-01-04" })]);
    if (result.status !== "ready") throw new Error("hidden");
    expect(result.sets.map(s => s.stage)).toEqual(["initial", "progress"]);
    expect(result.stagesWithoutSets).toEqual(["debond", "retention"]);
  });

  it("follows the configured requirement for each stage (45° required at start only)", () => {
    const nine = { ...DEFAULT_PHOTO_STAGE_REQUIREMENTS, initial: { required: [...FULL_SET_VIEWS, "extraoral_45" as const], optional: ["overjet" as const] } };
    const result = run([...set(FULL_SET_VIEWS), ...set(FULL_SET_VIEWS, { photoStage: "debond", takenOn: "2027-06-01" })], nine);
    if (result.status !== "ready") throw new Error("hidden");
    expect(result.sets.map(s => [s.stage, s.requiredCount, s.missingRequired])).toEqual([["initial", 9, ["extraoral_45"]], ["debond", 8, []]]);
  });

  it.each([false, undefined])("is hidden entirely without photo permission (%s), not even counts", (visible) => {
    expect(run(set(FULL_SET_VIEWS), DEFAULT_PHOTO_STAGE_REQUIREMENTS, { photosVisible: visible })).toEqual({ status: "hidden" });
  });

  it("the decoder rejects malformed payloads instead of guessing", () => {
    expect(() => decodeCompletenessDocuments({ documents: [{ id: 1 }] }, 1)).toThrow();
    expect(() => decodeCompletenessDocuments({}, 1)).toThrow();
    const ok = decodeCompletenessDocuments({ documents: [{ ...doc(), title: "x", uploadedAt: "2026-01-04T10:00:00.000Z" }] }, 1);
    expect(ok).toHaveLength(1);
    expect(() => decodeCompletenessDocuments({ documents: [{ ...doc({ patientId: 2 }), title: "x", uploadedAt: "2026-01-04T10:00:00.000Z" }] }, 1)).toThrow();
  });
});
