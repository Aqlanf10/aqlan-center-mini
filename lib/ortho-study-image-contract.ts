import { canonicalOrthoMediaRecipe, defaultOrthoMediaRecipe, parseOrthoMediaRecipe, type OrthoMediaRecipe } from "./ortho-study-media";
export const STUDY_IMAGE_PROCESSOR = "ortho-study-image-v1";
export const STUDY_IMAGE_LIMITS = Object.freeze({ inputBytes: 25 * 1024 * 1024, inputPixels: 16_000_000, outputPixels: 4_000_000, outputBytes: 4 * 1024 * 1024, seconds: 10 });
export interface StudyImageCommand {
  patientId: number; documentId: number; sha256: string; useId: string;
  purpose: "selected-use" | "editor-canvas" | "original-comparison";
  recipe: OrthoMediaRecipe; frame: { width: number; height: number };
}
export function readStudyImageCommand(raw: unknown): StudyImageCommand | null {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as StudyImageCommand;
    if (Object.keys(r).sort().join('|') !== 'documentId|frame|patientId|purpose|recipe|sha256|useId'
      || !Number.isSafeInteger(r.patientId) || r.patientId <= 0 || !Number.isSafeInteger(r.documentId) || r.documentId <= 0
      || typeof r.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(r.sha256)
      || typeof r.useId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(r.useId)
      || !['selected-use','editor-canvas','original-comparison'].includes(r.purpose)
      || !r.frame || Object.keys(r.frame).sort().join('|') !== 'height|width'
      || !Number.isSafeInteger(r.frame.width) || !Number.isSafeInteger(r.frame.height) || r.frame.width < 1 || r.frame.height < 1
      || r.frame.width > 4096 || r.frame.height > 4096 || r.frame.width * r.frame.height > STUDY_IMAGE_LIMITS.outputPixels) return null;
    const recipe = parseOrthoMediaRecipe(r.recipe), full = { left: 0, top: 0, right: 1000000, bottom: 1000000 };
    if (r.purpose === 'editor-canvas' && (recipe.fit !== 'contain' || JSON.stringify(recipe.cropPpm) !== JSON.stringify(full))) return null;
    if (r.purpose === 'original-comparison' && canonicalOrthoMediaRecipe(recipe) !== canonicalOrthoMediaRecipe(defaultOrthoMediaRecipe(recipe.basis.orientedWidth, recipe.basis.orientedHeight, recipe.basis.exifOrientation))) return null;
    return { patientId:r.patientId, documentId:r.documentId, sha256:r.sha256, useId:r.useId, purpose:r.purpose, recipe, frame:{...r.frame} };
  } catch { return null; }
}
