/** Reauthored after the 2026-10-11 workspace discontinuity. This is a NEW
 * unreviewed successor, not the hash-cleared lost V2 file. Presentation only. */
export const ORTHO_MEDIA_RECIPE_VERSION = "ortho-study-media-v1" as const;
export const ORTHO_MEDIA_EDITOR_VERSION = "ortho-study-editor-v1" as const;
export const ORTHO_MEDIA_GEOMETRY_VERSION = "ortho-study-geometry-v3" as const;
export const ORTHO_MEDIA_PPM = 1_000_000;
export const ORTHO_MEDIA_GEOMETRY_LIMITS = Object.freeze({ axis: 16384, pixels: 64_000_000, uses: 512 });
export interface OrthoMediaRecipe {
  version: typeof ORTHO_MEDIA_RECIPE_VERSION;
  editorVersion: typeof ORTHO_MEDIA_EDITOR_VERSION;
  basis: { orientedWidth: number; orientedHeight: number; exifOrientation: number | null };
  rotationMilliDegrees: number;
  cropPpm: { left: number; top: number; right: number; bottom: number };
  fit: "contain" | "cover";
  brightnessPermille: number;
  contrastPermille: number;
  background: "white";
}
export interface OrthoStudyMediaUseDraft {
  useId: string; documentId: number; sourceSha256: string; groupId: string | null;
  slotId: string; order: number;
  view: "unassigned" | "face-rest" | "face-smile" | "profile" | "intraoral-front" | "intraoral-right" | "intraoral-left" | "occlusal-upper" | "occlusal-lower" | "panoramic" | "cephalometric" | "other";
  caption: string; recipe: OrthoMediaRecipe;
}
export type OrthoMediaIssue = "invalid_media_use" | "unsupported_media_recipe" | "invalid_media_recipe" | "duplicate_media_use" | "orientation_required" | "source_basis_mismatch" | "invalid_media_frame" | "media_geometry_limit";
export class OrthoMediaContractError extends Error {
  constructor(public readonly code: OrthoMediaIssue) { super(code); this.name = "OrthoMediaContractError"; }
}
const fail = (code: OrthoMediaIssue): never => { throw new OrthoMediaContractError(code); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const keys = (value: Record<string, unknown>, expected: readonly string[]) => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const integer = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const identity = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
const dimension = (value: unknown): value is number => integer(value, 1, ORTHO_MEDIA_GEOMETRY_LIMITS.axis);
export function parseOrthoMediaRecipe(value: unknown): OrthoMediaRecipe {
  if (!record(value)) return fail("invalid_media_recipe");
  if (value.version !== ORTHO_MEDIA_RECIPE_VERSION || value.editorVersion !== ORTHO_MEDIA_EDITOR_VERSION) return fail("unsupported_media_recipe");
  if (!keys(value, ["version", "editorVersion", "basis", "rotationMilliDegrees", "cropPpm", "fit", "brightnessPermille", "contrastPermille", "background"])) return fail("invalid_media_recipe");
  const b = value.basis, c = value.cropPpm;
  if (!record(b) || !keys(b, ["orientedWidth", "orientedHeight", "exifOrientation"])
    || !dimension(b.orientedWidth) || !dimension(b.orientedHeight) || b.orientedWidth * b.orientedHeight > ORTHO_MEDIA_GEOMETRY_LIMITS.pixels
    || !(b.exifOrientation === null || integer(b.exifOrientation, 1, 8))
    || !record(c) || !keys(c, ["left", "top", "right", "bottom"])
    || !integer(c.left, 0, ORTHO_MEDIA_PPM - 1) || !integer(c.top, 0, ORTHO_MEDIA_PPM - 1)
    || !integer(c.right, 1, ORTHO_MEDIA_PPM) || !integer(c.bottom, 1, ORTHO_MEDIA_PPM)
    || c.left >= c.right || c.top >= c.bottom || !integer(value.rotationMilliDegrees, -180000, 179999)
    || !(value.fit === "contain" || value.fit === "cover") || !integer(value.brightnessPermille, 800, 1200)
    || !integer(value.contrastPermille, 800, 1200) || value.background !== "white") return fail("invalid_media_recipe");
  return { version: ORTHO_MEDIA_RECIPE_VERSION, editorVersion: ORTHO_MEDIA_EDITOR_VERSION,
    basis: { orientedWidth: b.orientedWidth, orientedHeight: b.orientedHeight, exifOrientation: b.exifOrientation },
    rotationMilliDegrees: value.rotationMilliDegrees,
    cropPpm: { left: c.left, top: c.top, right: c.right, bottom: c.bottom }, fit: value.fit,
    brightnessPermille: value.brightnessPermille, contrastPermille: value.contrastPermille, background: "white" };
}
const VIEWS: readonly string[] = ["unassigned", "face-rest", "face-smile", "profile", "intraoral-front", "intraoral-right", "intraoral-left", "occlusal-upper", "occlusal-lower", "panoramic", "cephalometric", "other"];
export function parseOrthoStudyMediaUseDraft(value: unknown): OrthoStudyMediaUseDraft {
  if (!record(value) || !keys(value, ["useId", "documentId", "sourceSha256", "groupId", "slotId", "order", "view", "caption", "recipe"])
    || !identity(value.useId) || !integer(value.documentId, 1, Number.MAX_SAFE_INTEGER)
    || typeof value.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceSha256)
    || !(value.groupId === null || identity(value.groupId)) || !identity(value.slotId)
    || !integer(value.order, 0, ORTHO_MEDIA_GEOMETRY_LIMITS.uses - 1)
    || typeof value.view !== "string" || !VIEWS.includes(value.view)
    || typeof value.caption !== "string" || value.caption.length > 2000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value.caption)) return fail("invalid_media_use");
  return { useId: value.useId, documentId: value.documentId, sourceSha256: value.sourceSha256, groupId: value.groupId,
    slotId: value.slotId, order: value.order, view: value.view as OrthoStudyMediaUseDraft["view"], caption: value.caption, recipe: parseOrthoMediaRecipe(value.recipe) };
}
export function parseOrthoStudyMediaUses(value: unknown): OrthoStudyMediaUseDraft[] {
  if (!Array.isArray(value) || value.length > ORTHO_MEDIA_GEOMETRY_LIMITS.uses) return fail("invalid_media_use");
  const uses = value.map(parseOrthoStudyMediaUseDraft);
  if (new Set(uses.map(use => use.useId)).size !== uses.length) return fail("duplicate_media_use");
  return uses;
}
export const canonicalOrthoMediaRecipe = (value: OrthoMediaRecipe): string => JSON.stringify(parseOrthoMediaRecipe(value));
export function defaultOrthoMediaRecipe(orientedWidth: number, orientedHeight: number, exifOrientation: number | null = null): OrthoMediaRecipe {
  return parseOrthoMediaRecipe({ version: ORTHO_MEDIA_RECIPE_VERSION, editorVersion: ORTHO_MEDIA_EDITOR_VERSION,
    basis: { orientedWidth, orientedHeight, exifOrientation }, rotationMilliDegrees: 0,
    cropPpm: { left: 0, top: 0, right: ORTHO_MEDIA_PPM, bottom: ORTHO_MEDIA_PPM }, fit: "contain",
    brightnessPermille: 1000, contrastPermille: 1000, background: "white" });
}
export interface OrthoMediaRect { left: number; top: number; width: number; height: number }
export interface OrthoMediaGeometry {
  rotatedCanvas: { width: number; height: number };
  orientedToRotated: [number, number, number, number, number, number];
  requestedCrop: OrthoMediaRect;
  effectiveCrop: OrthoMediaRect;
  frame: { width: number; height: number };
  content: { left: number; top: number; width: number; height: number; scale: number };
  resolutionWarning: boolean;
}
const snapTrig = (value: number) => Math.abs(value) < 1e-12 ? 0 : Math.abs(Math.abs(value) - 1) < 1e-12 ? Math.sign(value) : value;
/** Decoded original must be auto-oriented exactly once. Saving a declared basis
 * does not run or imply this verification. No medical calibration is involved. */
export function verifyOrthoMediaBasis(recipe: OrthoMediaRecipe, decoded: { encodedWidth: number; encodedHeight: number; exifOrientation: number }): void {
  const r = parseOrthoMediaRecipe(recipe);
  if (r.basis.exifOrientation === null) return fail("orientation_required");
  if (!dimension(decoded.encodedWidth) || !dimension(decoded.encodedHeight) || !integer(decoded.exifOrientation, 1, 8)) return fail("source_basis_mismatch");
  const swap = decoded.exifOrientation >= 5;
  if (r.basis.exifOrientation !== decoded.exifOrientation || r.basis.orientedWidth !== (swap ? decoded.encodedHeight : decoded.encodedWidth)
    || r.basis.orientedHeight !== (swap ? decoded.encodedWidth : decoded.encodedHeight)) return fail("source_basis_mismatch");
}
/** Coordinate convention: oriented image corner coordinates; clockwise positive
 * display rotation in a y-down plane; expanded ceil canvas; outward-rounded
 * selected crop. Cover adds a continuous centered crop, never integer flooring. */
export function planOrthoMediaGeometry(recipe: OrthoMediaRecipe, frame: { width: number; height: number }): OrthoMediaGeometry {
  const r = parseOrthoMediaRecipe(recipe);
  if (!dimension(frame.width) || !dimension(frame.height) || frame.width * frame.height > ORTHO_MEDIA_GEOMETRY_LIMITS.pixels) return fail("invalid_media_frame");
  const w = r.basis.orientedWidth, h = r.basis.orientedHeight, radians = r.rotationMilliDegrees * Math.PI / 180000;
  const cos = snapTrig(Math.cos(radians)), sin = snapTrig(Math.sin(radians));
  const width = Math.ceil(Math.abs(w * cos) + Math.abs(h * sin)), height = Math.ceil(Math.abs(w * sin) + Math.abs(h * cos));
  if (!dimension(width) || !dimension(height) || width * height > ORTHO_MEDIA_GEOMETRY_LIMITS.pixels) return fail("media_geometry_limit");
  const left = Math.floor(r.cropPpm.left * width / ORTHO_MEDIA_PPM), top = Math.floor(r.cropPpm.top * height / ORTHO_MEDIA_PPM);
  const right = Math.ceil(r.cropPpm.right * width / ORTHO_MEDIA_PPM), bottom = Math.ceil(r.cropPpm.bottom * height / ORTHO_MEDIA_PPM);
  const requestedCrop = { left, top, width: right - left, height: bottom - top }, effectiveCrop = { ...requestedCrop };
  if (r.fit === "cover") {
    const aspect = frame.width / frame.height;
    if (effectiveCrop.width / effectiveCrop.height > aspect) { const next = effectiveCrop.height * aspect; effectiveCrop.left += (effectiveCrop.width - next) / 2; effectiveCrop.width = next; }
    else { const next = effectiveCrop.width / aspect; effectiveCrop.top += (effectiveCrop.height - next) / 2; effectiveCrop.height = next; }
  }
  const scale = Math.min(frame.width / effectiveCrop.width, frame.height / effectiveCrop.height);
  const contentWidth = effectiveCrop.width * scale, contentHeight = effectiveCrop.height * scale;
  return { rotatedCanvas: { width, height }, orientedToRotated: [cos, sin, -sin, cos, width / 2 - cos * w / 2 + sin * h / 2, height / 2 - sin * w / 2 - cos * h / 2],
    requestedCrop, effectiveCrop, frame: { ...frame },
    content: r.fit === "cover" ? { left: 0, top: 0, width: frame.width, height: frame.height, scale }
      : { left: (frame.width - contentWidth) / 2, top: (frame.height - contentHeight) / 2, width: contentWidth, height: contentHeight, scale }, resolutionWarning: scale > 1 };
}
/** sRGB channel lookup, before white alpha compositing and spatial resampling. */
export function applyOrthoMediaToneChannel(channel: number, recipe: OrthoMediaRecipe): number {
  const r = parseOrthoMediaRecipe(recipe);
  if (!integer(channel, 0, 255)) return fail("invalid_media_recipe");
  return Math.max(0, Math.min(255, Math.round(((channel * r.brightnessPermille / 1000) - 127.5) * r.contrastPermille / 1000 + 127.5)));
}

/** Exact hash input shared by server processor and renderer. Recipe, geometry
 * implementation version and supplied frame are all bound; no client hash is
 * treated as proof of native processing. Hash this UTF-8 string with SHA-256. */
export function canonicalOrthoMediaGeometryWitness(recipe: OrthoMediaRecipe, frame: { width: number; height: number }): string {
  const parsed = parseOrthoMediaRecipe(recipe), geometry = planOrthoMediaGeometry(parsed, frame);
  return JSON.stringify({ geometryVersion: ORTHO_MEDIA_GEOMETRY_VERSION, recipe: parsed, frame: { width: frame.width, height: frame.height }, geometry });
}
