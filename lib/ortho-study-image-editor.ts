import { canonicalOrthoMediaRecipe, defaultOrthoMediaRecipe, parseOrthoMediaRecipe, planOrthoMediaGeometry, ORTHO_MEDIA_PPM, type OrthoMediaRecipe } from "./ortho-study-media";
/** Reauthored successor after workspace loss; independent review required. */
export interface StudyImageEditorScope { ownerKey: string; useId: string; documentId: number; sourceSha256: string }
export interface StudyImageEditRequest extends StudyImageEditorScope { expectedRecipe: string; recipe: OrthoMediaRecipe }
export interface StudyImagePreviewRequest extends StudyImageEditorScope {
  purpose: "selected-use" | "editor-canvas" | "original-comparison";
  recipe: OrthoMediaRecipe; frame: { width: number; height: number }; signal: AbortSignal;
}
export interface StudyImagePreview {
  useId: string; documentId: number; sourceSha256: string; recipeSha256: string;
  width: number; height: number; renditionSha256: string; processorVersion: string; blob: Blob;
}
/** Freeze the returned immutable Blob reference and scalar witness before any
 * digest await, so the image displayed is the image whose bytes were verified. */
export function captureStudyImagePreview(preview: StudyImagePreview): StudyImagePreview {
  return Object.freeze({ useId: preview.useId, documentId: preview.documentId, sourceSha256: preview.sourceSha256,
    recipeSha256: preview.recipeSha256, width: preview.width, height: preview.height,
    renditionSha256: preview.renditionSha256, processorVersion: preview.processorVersion, blob: preview.blob });
}
export type StudyImagePreviewResult = { ok: true; preview: StudyImagePreview } | {
  ok: false; code: "forbidden" | "stale" | "orientation_required" | "size_limit" | "unavailable";
};
export function captureStudyImagePreviewRequest(request: StudyImagePreviewRequest): StudyImagePreviewRequest {
  const recipe = parseOrthoMediaRecipe(request.recipe);
  Object.freeze(recipe.basis); Object.freeze(recipe.cropPpm); Object.freeze(recipe);
  return Object.freeze({ ...request, recipe, frame: Object.freeze({ ...request.frame }) });
}
export const studyImageScopeKey = (scope: StudyImageEditorScope) => JSON.stringify([scope.ownerKey, scope.useId, scope.documentId, scope.sourceSha256]);
export function canvasRecipe(recipe: OrthoMediaRecipe): OrthoMediaRecipe {
  return parseOrthoMediaRecipe({ ...recipe, cropPpm: { left: 0, top: 0, right: ORTHO_MEDIA_PPM, bottom: ORTHO_MEDIA_PPM }, fit: "contain" });
}
export function originalComparisonRecipe(recipe: OrthoMediaRecipe): OrthoMediaRecipe {
  return defaultOrthoMediaRecipe(recipe.basis.orientedWidth, recipe.basis.orientedHeight, recipe.basis.exifOrientation);
}
export function rotateAndResetCrop(recipe: OrthoMediaRecipe, milliDegrees: number): OrthoMediaRecipe {
  if (!Number.isSafeInteger(milliDegrees)) throw Error("invalid_rotation");
  const angle = ((milliDegrees + 180000) % 360000 + 360000) % 360000 - 180000;
  return parseOrthoMediaRecipe({ ...canvasRecipe(recipe), rotationMilliDegrees: angle });
}
export function editorCanvasFrame(recipe: OrthoMediaRecipe): { width: number; height: number } {
  const { rotatedCanvas } = planOrthoMediaGeometry(canvasRecipe(recipe), { width: 1, height: 1 });
  const scale = Math.min(1, 900 / rotatedCanvas.width, 700 / rotatedCanvas.height);
  return { width: Math.max(1, Math.round(rotatedCanvas.width * scale)), height: Math.max(1, Math.round(rotatedCanvas.height * scale)) };
}
export interface EditorPoint { x: number; y: number }
export function pointOnCanvas(recipe: OrthoMediaRecipe, frame: { width: number; height: number }, box: {
  left: number; top: number; width: number; height: number;
}, point: EditorPoint): EditorPoint | null {
  if (![box.left, box.top, box.width, box.height, point.x, point.y].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return null;
  const plan = planOrthoMediaGeometry(canvasRecipe(recipe), frame), c = plan.content;
  const fx = (point.x - box.left) * frame.width / box.width, fy = (point.y - box.top) * frame.height / box.height;
  return { x: Math.max(0, Math.min(plan.rotatedCanvas.width, (fx - c.left) / c.scale)), y: Math.max(0, Math.min(plan.rotatedCanvas.height, (fy - c.top) / c.scale)) };
}
export function cropFromCanvasPoints(recipe: OrthoMediaRecipe, a: EditorPoint, b: EditorPoint, aspect?: number): OrthoMediaRecipe | null {
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite) || aspect !== undefined && (!Number.isFinite(aspect) || aspect <= 0)) return null;
  const { rotatedCanvas: size } = planOrthoMediaGeometry(canvasRecipe(recipe), { width: 1, height: 1 });
  const clamp = (v: number, limit: number) => Math.max(0, Math.min(limit, v));
  const x1 = clamp(a.x, size.width), y1 = clamp(a.y, size.height);
  let x2 = clamp(b.x, size.width), y2 = clamp(b.y, size.height), width = Math.abs(x2 - x1), height = Math.abs(y2 - y1);
  if (width < 1 || height < 1) return null;
  if (aspect !== undefined) { if (width / height > aspect) width = height * aspect; else height = width / aspect;
    x2 = x1 + Math.sign(x2 - x1) * width; y2 = y1 + Math.sign(y2 - y1) * height; }
  const ppm = (v: number, max: number) => Math.max(0, Math.min(ORTHO_MEDIA_PPM, Math.round(v * ORTHO_MEDIA_PPM / max)));
  const cropPpm = { left: ppm(Math.min(x1, x2), size.width), top: ppm(Math.min(y1, y2), size.height), right: ppm(Math.max(x1, x2), size.width), bottom: ppm(Math.max(y1, y2), size.height) };
  if (cropPpm.left >= cropPpm.right || cropPpm.top >= cropPpm.bottom) return null;
  return parseOrthoMediaRecipe({ ...recipe, cropPpm });
}
export interface RecipeHistory { before: string[]; current: string; after: string[] }
export const startRecipeHistory = (recipe: OrthoMediaRecipe): RecipeHistory => ({ before: [], current: canonicalOrthoMediaRecipe(recipe), after: [] });
export function pushRecipeHistory(history: RecipeHistory, expected: string, recipe: OrthoMediaRecipe): RecipeHistory | null {
  if (history.current !== expected) return null;
  const next = canonicalOrthoMediaRecipe(recipe);
  return next === expected ? history : { before: [...history.before, expected].slice(-40), current: next, after: [] };
}
export function stepRecipeHistory(history: RecipeHistory, direction: "undo" | "redo"): RecipeHistory | null {
  if (direction === "undo") { const value = history.before.at(-1); return value === undefined ? null : { before: history.before.slice(0, -1), current: value, after: [history.current, ...history.after].slice(0, 40) }; }
  const value = history.after[0]; return value === undefined ? null : { before: [...history.before, history.current].slice(-40), current: value, after: history.after.slice(1) };
}
/** Checks transport identity/container header/digest, not the native algorithm.
 * Parent owns source authorization, full PNG validity and processor allowlist. */
export async function verifyStudyImagePreview(input: StudyImagePreview, request: StudyImagePreviewRequest): Promise<boolean> {
  const preview = captureStudyImagePreview(input);
  if (!(preview.blob instanceof Blob) || preview.blob.type !== "image/png" || preview.blob.size < 33 || preview.blob.size > 4 * 1024 * 1024
    || preview.useId !== request.useId || preview.documentId !== request.documentId || preview.sourceSha256 !== request.sourceSha256
    || preview.width !== request.frame.width || preview.height !== request.frame.height
    || !/^[a-f0-9]{64}$/.test(preview.recipeSha256) || !/^[a-f0-9]{64}$/.test(preview.renditionSha256)
    || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(preview.processorVersion)
    || !Number.isSafeInteger(preview.width) || !Number.isSafeInteger(preview.height) || preview.width <= 0 || preview.height <= 0
    || preview.width > 16384 || preview.height > 16384 || preview.width * preview.height > 4_000_000) return false;
  const bytes = await preview.blob.arrayBuffer(); if (request.signal.aborted) return false;
  const u8 = new Uint8Array(bytes), dv = new DataView(bytes);
  if (![137,80,78,71,13,10,26,10].every((v,i) => u8[i] === v) || dv.getUint32(8) !== 13 || ![73,72,68,82].every((v,i) => u8[i+12] === v)
    || dv.getUint32(16) !== preview.width || dv.getUint32(20) !== preview.height || u8[24] !== 8 || u8[25] !== 2) return false;
  const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), value => value.toString(16).padStart(2, "0")).join("");
  const recipeHash = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalOrthoMediaRecipe(request.recipe))));
  if (request.signal.aborted || recipeHash !== preview.recipeSha256) return false;
  const resultHash = hex(await crypto.subtle.digest("SHA-256", bytes));
  return !request.signal.aborted && resultHash === preview.renditionSha256;
}
