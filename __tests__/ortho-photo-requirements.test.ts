import { describe, expect, it } from "vitest";
import {
  DEFAULT_PHOTO_STAGE_REQUIREMENTS, FULL_SET_VIEWS, PHOTO_VIEW_LABEL, PHOTOGRAPHIC_VIEWS, RADIOGRAPH_VIEWS,
  fullPhotoSetCheck, isPhotoView, parsePhotoStageRequirements, photoSetIntervalMonths, photoStageRequirements, savedFullPhotoSetHistory,
} from "@/lib/ortho-photos";
import { PUBLIC_SETTING_KEYS, SETTING_DEFAULTS } from "@/lib/settings";
import { validateTypedSetting } from "@/lib/settings-validate";
import { settingDefinition } from "@/lib/settings-definitions";

/** OP-1 (contract v2.1, approved 6992947396 / 6993671109). Synthetic data only. */
describe("photo stage requirements (OP-1)", () => {
  it("defaults keep today's eight required views in every stage; 45° and overjet are optional", () => {
    for (const stage of ["initial", "progress", "debond", "retention"] as const) {
      expect(DEFAULT_PHOTO_STAGE_REQUIREMENTS[stage]).toEqual({ required: FULL_SET_VIEWS, optional: ["extraoral_45", "overjet"] });
    }
    expect(FULL_SET_VIEWS).toHaveLength(8);
    expect(parsePhotoStageRequirements("")).toEqual({ ok: true, value: DEFAULT_PHOTO_STAGE_REQUIREMENTS });
  });

  it("adds an optional overjet view without touching radiographs", () => {
    expect(isPhotoView("overjet")).toBe(true);
    expect(PHOTO_VIEW_LABEL.overjet).toContain("البروز الأمامي");
    expect(RADIOGRAPH_VIEWS).toEqual(["lateral_ceph", "pa_ceph", "panoramic"]);
    expect(PHOTOGRAPHIC_VIEWS).not.toContain("panoramic");
    expect(PHOTOGRAPHIC_VIEWS).toContain("overjet");
  });

  it("lets the clinic require 45° for chosen stages (nine at start and end)", () => {
    const nine = [...FULL_SET_VIEWS, "extraoral_45"];
    const parsed = parsePhotoStageRequirements(JSON.stringify({
      initial: { required: nine, optional: ["overjet"] }, debond: { required: nine, optional: ["overjet"] },
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.initial.required).toHaveLength(9);
    expect(parsed.value.progress).toEqual(DEFAULT_PHOTO_STAGE_REQUIREMENTS.progress);
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["an unknown stage", JSON.stringify({ archived: { required: FULL_SET_VIEWS, optional: [] } })],
    ["a radiograph", JSON.stringify({ initial: { required: [...FULL_SET_VIEWS, "panoramic"], optional: [] } })],
    ["an unknown view", JSON.stringify({ initial: { required: ["selfie"], optional: [] } })],
    ["a duplicate", JSON.stringify({ initial: { required: ["smile", "smile"], optional: [] } })],
    ["overlap", JSON.stringify({ initial: { required: ["smile"], optional: ["smile"] } })],
    ["no required view", JSON.stringify({ initial: { required: [], optional: [] } })],
    ["missing lists", JSON.stringify({ initial: { required: ["smile"] } })],
    ["extra fields", JSON.stringify({ initial: { required: ["smile"], optional: [], note: "x" } })],
  ])("rejects %s with an Arabic message", (_label, raw) => {
    const parsed = parsePhotoStageRequirements(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/[؀-ۿ]/);
    expect(validateTypedSetting("ortho.photo_stage_requirements", raw)).toMatch(/[؀-ۿ]/);
  });

  it("the interval read falls back to six outside 1–24 or when broken", () => {
    expect(photoSetIntervalMonths("3")).toBe(3);
    for (const bad of [undefined, "", "0", "25", "2.5", "abc"]) expect(photoSetIntervalMonths(bad)).toBe(6);
  });

  it("a broken stored value falls back to the defaults on read", () => {
    expect(photoStageRequirements("{")).toEqual(DEFAULT_PHOTO_STAGE_REQUIREMENTS);
    expect(photoStageRequirements(undefined)).toEqual(DEFAULT_PHOTO_STAGE_REQUIREMENTS);
  });

  it("registers both settings, keeps the interval default at six as an operational option, and validates its range", () => {
    expect(SETTING_DEFAULTS["ortho.full_photo_set_interval_months"]).toBe("6");
    expect(SETTING_DEFAULTS["ortho.photo_stage_requirements"]).toBe("");
    expect(settingDefinition("ortho.full_photo_set_interval_months")?.impact).toContain("ليس معيارًا علميًا");
    expect(validateTypedSetting("ortho.full_photo_set_interval_months", "6")).toBeNull();
    for (const bad of ["0", "25", "abc", "2.5"]) expect(validateTypedSetting("ortho.full_photo_set_interval_months", bad)).toMatch(/[؀-ۿ]/);
    expect(validateTypedSetting("ortho.photo_stage_requirements", "")).toBeNull();
    expect(PUBLIC_SETTING_KEYS).toEqual(expect.arrayContaining(["ortho.full_photo_set_interval_months", "ortho.photo_stage_requirements"]));
  });
});

describe("existing checks honour the stage requirement (behaviour unchanged by default)", () => {
  const input = { sessionDate: "2026-03-01", startDate: "2026-01-01", lastFullSetDate: null, intervalMonths: 6, phase: "working" as const, capturedViews: [...FULL_SET_VIEWS] };
  it("default: a full eight-view capture misses nothing", () => {
    expect(fullPhotoSetCheck(input).missingViews).toEqual([]);
  });
  it("requiring 45° adds it to missingViews for that stage only", () => {
    expect(fullPhotoSetCheck({ ...input, requiredViews: [...FULL_SET_VIEWS, "extraoral_45"] }).missingViews).toEqual(["extraoral_45"]);
  });

  const photo = (id: number, view: string, extra: Record<string, unknown> = {}) => ({
    id, patientId: 1, orthoCaseId: 2, adjustmentId: 3, isImage: true, removedAt: null,
    photoStage: "progress", photoView: view, takenOn: "2026-03-01", ...extra,
  });
  const history = (requirements?: typeof DEFAULT_PHOTO_STAGE_REQUIREMENTS) => savedFullPhotoSetHistory({
    patientId: 1, orthoCaseId: 2, photosVisible: true, today: "2026-03-02", asOfDate: "2026-03-02",
    adjustments: [{ id: 3, doneOn: "2026-03-01", photos: FULL_SET_VIEWS.map((view, i) => photo(10 + i, view)) }],
    requirements,
  });
  it("default: eight views make a saved full set", () => {
    expect(history().latest?.documentIds).toHaveLength(8);
  });
  it("when progress requires 45°, the same eight are not a full set", () => {
    const nine = { ...DEFAULT_PHOTO_STAGE_REQUIREMENTS, progress: { required: [...FULL_SET_VIEWS, "extraoral_45" as const], optional: ["overjet" as const] } };
    expect(history(nine)).toEqual({ status: "ready", latest: null });
  });
});
