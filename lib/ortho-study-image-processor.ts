import { createHash } from "node:crypto";
import sharp from "sharp";
import { applyOrthoMediaToneChannel, canonicalOrthoMediaGeometryWitness, canonicalOrthoMediaRecipe, parseOrthoMediaRecipe, planOrthoMediaGeometry, verifyOrthoMediaBasis, type OrthoMediaRecipe } from "./ortho-study-media";

/** Presentation-only raster. Never used to calculate facial/cephalometric lengths.
 * Original bytes are read-only; neither storage keys nor remote URLs enter SVG. */
import { STUDY_IMAGE_PROCESSOR, STUDY_IMAGE_LIMITS } from "./ortho-study-image-contract";
export class StudyImageError extends Error {
  constructor(readonly code: "unavailable" | "size_limit" | "source_basis_mismatch" | "processor_busy") { super(code); }
}
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
let occupied = false;
/** Bound native admission per process. A detached browser request cannot admit
 * a second decoder until the first bounded pipeline actually releases its slot. */
export async function withStudyImageSlot<T>(run: () => Promise<T>): Promise<T> {
  if (occupied) throw new StudyImageError("processor_busy");
  occupied = true;
  try { return await run(); } finally { occupied = false; }
}
export async function inspectStudyImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > STUDY_IMAGE_LIMITS.inputBytes) throw new StudyImageError("size_limit");
  const signature = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "jpeg"
      : bytes.subarray(0,4).toString() === "RIFF" && bytes.subarray(8,12).toString() === "WEBP" ? "webp" : null;
  if (!signature) throw new StudyImageError("unavailable");
  const metadata = await sharp(bytes, { limitInputPixels: STUDY_IMAGE_LIMITS.inputPixels, failOn: "error" }).timeout({ seconds: STUDY_IMAGE_LIMITS.seconds }).metadata();
  if (!metadata.width || !metadata.height || metadata.format !== signature || (metadata.pages ?? 1) !== 1) throw new StudyImageError("unavailable");
  if (metadata.width > 16384 || metadata.height > 16384 || metadata.width * metadata.height > STUDY_IMAGE_LIMITS.inputPixels) throw new StudyImageError("size_limit");
  const exifOrientation = metadata.orientation ?? 1;
  if (!Number.isInteger(exifOrientation) || exifOrientation < 1 || exifOrientation > 8) throw new StudyImageError("source_basis_mismatch");
  return { encodedWidth: metadata.width, encodedHeight: metadata.height, exifOrientation,
    orientedWidth: exifOrientation >= 5 ? metadata.height : metadata.width,
    orientedHeight: exifOrientation >= 5 ? metadata.width : metadata.height, format: metadata.format! };
}
export async function renderStudyImage(bytes: Buffer, input: OrthoMediaRecipe, frame: { width: number; height: number }) {
  const recipe = parseOrthoMediaRecipe(input), geometry = planOrthoMediaGeometry(recipe, frame);
  if (frame.width * frame.height > STUDY_IMAGE_LIMITS.outputPixels) throw new StudyImageError("size_limit");
  const started = Date.now(), remaining = () => {
    const seconds = STUDY_IMAGE_LIMITS.seconds - (Date.now() - started) / 1000;
    if (seconds <= 0) throw new StudyImageError("size_limit"); return Math.max(1, Math.ceil(seconds));
  };
  const decoded = await inspectStudyImage(bytes);
  verifyOrthoMediaBasis(recipe, decoded);
  const raw = await sharp(bytes, { limitInputPixels: STUDY_IMAGE_LIMITS.inputPixels, failOn: "error" })
    .autoOrient().toColourspace("srgb").ensureAlpha().raw({ depth: "uchar" }).timeout({ seconds: remaining() }).toBuffer({ resolveWithObject: true });
  if (raw.info.width !== decoded.orientedWidth || raw.info.height !== decoded.orientedHeight || raw.info.channels !== 4) throw new StudyImageError("source_basis_mismatch");
  // Exact v1 channel lookup before white alpha compositing, independent of a
  // native linear operator's rounding and alpha-channel semantics.
  const lookup = Array.from({ length: 256 }, (_, c) => applyOrthoMediaToneChannel(c, recipe));
  const rgb = Buffer.allocUnsafe(raw.info.width * raw.info.height * 3);
  for (let i = 0, j = 0; i < raw.data.length; i += 4, j += 3) {
    const alpha = raw.data[i + 3];
    for (let c = 0; c < 3; c++) rgb[j + c] = Math.round((lookup[raw.data[i + c]] * alpha + 255 * (255 - alpha)) / 255);
  }
  const orientedPng = await sharp(rgb, { raw: { width: raw.info.width, height: raw.info.height, channels: 3 } })
    .png().timeout({ seconds: remaining() }).toBuffer();
  const [a, b, c, d, e, f] = geometry.orientedToRotated, s = geometry.content.scale;
  const matrix = [a * s, b * s, c * s, d * s,
    geometry.content.left + (e - geometry.effectiveCrop.left) * s,
    geometry.content.top + (f - geometry.effectiveCrop.top) * s];
  if (matrix.some(n => !Number.isFinite(n))) throw new StudyImageError("size_limit");
  // Generated numbers and a locally encoded raster are the only interpolation.
  // No caption, caller SVG, file path, metadata or URL is accepted by this stage.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${frame.width}" height="${frame.height}"><rect width="100%" height="100%" fill="white"/><defs><clipPath id="crop"><rect x="${geometry.content.left}" y="${geometry.content.top}" width="${geometry.content.width}" height="${geometry.content.height}"/></clipPath></defs><g clip-path="url(#crop)"><image width="${decoded.orientedWidth}" height="${decoded.orientedHeight}" preserveAspectRatio="none" transform="matrix(${matrix.join(" ")})" xlink:href="data:image/png;base64,${orientedPng.toString("base64")}"/></g></svg>`;
  const png = await sharp(Buffer.from(svg), { density: 72, limitInputPixels: STUDY_IMAGE_LIMITS.outputPixels, failOn: "error" })
    .flatten({ background: "white" }).removeAlpha().toColourspace("srgb").png({ palette: false }).timeout({ seconds: remaining() }).toBuffer({ resolveWithObject: true });
  if (png.info.width !== frame.width || png.info.height !== frame.height || png.info.channels !== 3) throw new StudyImageError("source_basis_mismatch");
  if (png.data.length > STUDY_IMAGE_LIMITS.outputBytes) throw new StudyImageError("size_limit");
  remaining();
  return { png: png.data, width: frame.width, height: frame.height, sourceSha256: hash(bytes),
    recipeSha256: hash(canonicalOrthoMediaRecipe(recipe)), geometrySha256: hash(canonicalOrthoMediaGeometryWitness(recipe, frame)),
    renditionSha256: hash(png.data), processorVersion: STUDY_IMAGE_PROCESSOR, resolutionWarning: geometry.resolutionWarning };
}
