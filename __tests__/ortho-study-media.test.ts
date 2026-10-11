import { describe, expect, it } from "vitest";
import { canonicalOrthoMediaGeometryWitness, applyOrthoMediaToneChannel, canonicalOrthoMediaRecipe, defaultOrthoMediaRecipe, parseOrthoMediaRecipe, parseOrthoStudyMediaUses, planOrthoMediaGeometry, verifyOrthoMediaBasis } from "../lib/ortho-study-media";
const base = () => defaultOrthoMediaRecipe(800, 400, 1);
const use = (useId: string) => ({ useId, documentId: 17, sourceSha256: "a".repeat(64), groupId: "g1", slotId: "s1", order: 0, view: "other", caption: "Synthetic", recipe: base() });
describe("strict display-only media recipe successor", () => {
  it("keeps an explicit unknown orientation without pretending to decode the original", () => {
    const recipe = defaultOrthoMediaRecipe(800, 400); expect(recipe.basis.exifOrientation).toBeNull();
    expect(() => verifyOrthoMediaBasis(recipe, { encodedWidth: 800, encodedHeight: 400, exifOrientation: 1 })).toThrow("orientation_required");
  });
  it.each([1,2,3,4,5,6,7,8])("matches declared dimensions only after exact EXIF basis %i", orientation => {
    const recipe = defaultOrthoMediaRecipe(orientation >= 5 ? 400 : 800, orientation >= 5 ? 800 : 400, orientation);
    expect(() => verifyOrthoMediaBasis(recipe, { encodedWidth: 800, encodedHeight: 400, exifOrientation: orientation })).not.toThrow();
    expect(() => verifyOrthoMediaBasis(recipe, { encodedWidth: 801, encodedHeight: 400, exifOrientation: orientation })).toThrow("source_basis_mismatch");
  });
  it("refuses unknown fields, URLs, clinical coordinates, unbounded tone and invalid crop", () => {
    for (const extra of [{ url: "https://invalid.example/image" }, { confirmedBy: "doctor" }, { mmPerPixel: 1 }, { landmarks: [] }])
      expect(() => parseOrthoMediaRecipe({ ...base(), ...extra })).toThrow("invalid_media_recipe");
    for (const patch of [{ brightnessPermille: 1201 }, { contrastPermille: 799 }, { rotationMilliDegrees: Infinity }, { cropPpm: { left: 4, right: 4, top: 0, bottom: 1000000 } }])
      expect(() => parseOrthoMediaRecipe({ ...base(), ...patch })).toThrow("invalid_media_recipe");
    expect(() => parseOrthoMediaRecipe({ ...base(), version: "future" })).toThrow("unsupported_media_recipe");
  });
  it("canonicalizes fixed field order and detaches all editable nested values", () => {
    const a = base(), b = parseOrthoMediaRecipe({ background: a.background, contrastPermille: a.contrastPermille, brightnessPermille: a.brightnessPermille,
      fit: a.fit, cropPpm: { ...a.cropPpm }, rotationMilliDegrees: a.rotationMilliDegrees, basis: { ...a.basis }, editorVersion: a.editorVersion, version: a.version });
    expect(canonicalOrthoMediaRecipe(a)).toBe(canonicalOrthoMediaRecipe(b)); b.cropPpm.right = 500000; expect(a.cropPpm.right).toBe(1000000);
  });
  it("permits two uses of one source and rejects duplicate identities or client provenance", () => {
    const items = parseOrthoStudyMediaUses([use("a"), { ...use("b"), recipe: { ...base(), cropPpm: { left: 500000, top: 0, right: 1000000, bottom: 1000000 } } }]);
    expect(items).toHaveLength(2); expect(items[0].documentId).toBe(items[1].documentId); expect(items[0].recipe.cropPpm.left).toBe(0);
    expect(() => parseOrthoStudyMediaUses([use("a"), use("a")])).toThrow("duplicate_media_use");
    expect(() => parseOrthoStudyMediaUses([{ ...use("a"), editedBy: "untrusted" }])).toThrow("invalid_media_use");
  });
});
describe("deterministic continuous geometry contract, no native pixel claim", () => {
  it("contains the whole image without stretching and uses explicit white frame padding", () => {
    const result = planOrthoMediaGeometry(base(), { width: 400, height: 400 });
    expect(result.content).toEqual({ left: 0, top: 100, width: 400, height: 200, scale: 0.5 });
    expect(result.requestedCrop).toEqual({ left: 0, top: 0, width: 800, height: 400 }); expect(result.resolutionWarning).toBe(false);
  });
  it("expands the clockwise quarter-turn plane and records the exact coordinate matrix", () => {
    const result = planOrthoMediaGeometry({ ...base(), rotationMilliDegrees: 90000 }, { width: 400, height: 800 });
    expect(result.rotatedCanvas).toEqual({ width: 400, height: 800 });
    expect(result.orientedToRotated).toEqual([0, 1, -1, 0, 400, 0]);
  });
  it("rounds a user crop outward before frame fitting", () => {
    const recipe = { ...defaultOrthoMediaRecipe(801, 401, 1), cropPpm: { left: 100000, top: 100000, right: 900000, bottom: 900000 } };
    expect(planOrthoMediaGeometry(recipe, { width: 300, height: 200 }).requestedCrop).toEqual({ left: 80, top: 40, width: 641, height: 321 });
  });
  it("keeps odd and extreme cover crops continuous with exact uniform coverage", () => {
    const odd = planOrthoMediaGeometry({ ...defaultOrthoMediaRecipe(801, 400, 1), fit: "cover" }, { width: 300, height: 200 });
    expect(odd.effectiveCrop).toEqual({ left: 100.5, top: 0, width: 600, height: 400 });
    expect(odd.content).toEqual({ left: 0, top: 0, width: 300, height: 200, scale: 0.5 });
    const thin = planOrthoMediaGeometry({ ...defaultOrthoMediaRecipe(1, 100, 1), fit: "cover" }, { width: 1000, height: 1 });
    expect(thin.effectiveCrop.left).toBe(0); expect(thin.effectiveCrop.top).toBeCloseTo(49.9995, 10);
    expect(thin.effectiveCrop.height).toBe(0.001); expect(thin.content).toEqual({ left: 0, top: 0, width: 1000, height: 1, scale: 1000 });
    expect(thin.resolutionWarning).toBe(true);
  });
  it("refuses frame and expanded-canvas geometry limits before any raster allocation", () => {
    expect(() => planOrthoMediaGeometry(base(), { width: 0, height: 1 })).toThrow("invalid_media_frame");
    expect(() => planOrthoMediaGeometry(base(), { width: 9000, height: 9000 })).toThrow("invalid_media_frame");
    expect(() => planOrthoMediaGeometry({ ...defaultOrthoMediaRecipe(8000, 8000, 1), rotationMilliDegrees: 45000 }, { width: 400, height: 400 })).toThrow("media_geometry_limit");
  });
  it("uses literal bounded sRGB tone arithmetic without modifying alpha or source bytes", () => {
    expect(applyOrthoMediaToneChannel(100, { ...base(), contrastPermille: 1200 })).toBe(95);
    expect(applyOrthoMediaToneChannel(255, { ...base(), brightnessPermille: 1200 })).toBe(255);
    expect(applyOrthoMediaToneChannel(0, { ...base(), contrastPermille: 1200 })).toBe(0);
    expect(applyOrthoMediaToneChannel(128, base())).toBe(128);
  });
});

it("binds geometry version, exact recipe and frame in the canonical witness", () => {
  const witness = JSON.parse(canonicalOrthoMediaGeometryWitness(base(), { width: 400, height: 200 }));
  expect(witness.geometryVersion).toBe("ortho-study-geometry-v3"); expect(witness.frame).toEqual({ width: 400, height: 200 });
  expect(witness.recipe).toEqual(base()); expect(witness.geometry.frame).toEqual(witness.frame);
  expect(canonicalOrthoMediaGeometryWitness(base(), { width: 400, height: 200 })).not.toBe(canonicalOrthoMediaGeometryWitness(base(), { width: 400, height: 201 }));
});
