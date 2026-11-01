import { createHash } from "node:crypto";
import { contentMatchesMimeType } from "./magic-bytes";
import { imageSize } from "./imageSize";
import { putFile, readFileByKey } from "./files";
import { LOGIN_PHOTO_EXTENSIONS, LOGIN_PHOTO_MAX_BYTES, parseLoginPhotoAsset, validLoginPhotoDimensions, type LoginPhotoAsset } from "./login-photo";

// PNG uses CRC-32 over each chunk's type and payload (not its length).
const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
function pngChunkCrc(bytes: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index++) crc = (crc >>> 8) ^ PNG_CRC_TABLE[(crc ^ bytes[index]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/** Walk bounded PNG chunks, rejecting corrupt CRCs, animation, truncation and trailing content. */
function completeStaticPng(bytes: Buffer): boolean {
  let offset = 8; let sawData = false; let sawHeader = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return false;
    if (pngChunkCrc(bytes, offset + 4, offset + 8 + length) !== bytes.readUInt32BE(offset + 8 + length)) return false;
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (["acTL", "fcTL", "fdAT"].includes(kind)) return false;
    if (!sawHeader && (kind !== "IHDR" || length !== 13)) return false;
    if (kind === "IHDR") { if (sawHeader) return false; sawHeader = true; }
    if (kind === "IDAT") sawData = true;
    offset += length + 12;
    if (kind === "IEND") return length === 0 && sawData && offset === bytes.length;
  }
  return false;
}
/** Bounded JPEG marker/scan walk; rejects truncated segments and bytes after EOI. Not a pixel decoder. */
function completeStaticJpeg(bytes: Buffer): boolean {
  let offset = 2; let frame = false; let sawScan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset++];
    if (marker === 0xd9) return frame && sawScan && offset === bytes.length;
    if (marker === 0xd8 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)
      || marker === 0x01 || offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (frame || ![0xc0, 0xc2].includes(marker) || length < 11 || bytes[offset + 2] !== 8) return false;
      const components = bytes[offset + 7];
      if (components < 1 || components > 4 || length !== 8 + 3 * components) return false;
      frame = true;
    }
    if (marker !== 0xda) { offset += length; continue; }
    const components = bytes[offset + 2];
    if (!frame || components < 1 || components > 4 || length !== 6 + 2 * components) return false;
    offset += length;
    let scanData = false;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) { scanData = true; offset++; continue; }
      const markerStart = offset++;
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) return false;
      const next = bytes[offset];
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { scanData = true; offset++; continue; }
      offset = markerStart; break;
    }
    if (!scanData) return false;
    sawScan = true;
  }
  return false;
}
export function validateLoginPhotoBytes(bytes: Buffer, mimeType: string): LoginPhotoAsset | null {
  if (!Object.hasOwn(LOGIN_PHOTO_EXTENSIONS, mimeType) || bytes.length === 0 || bytes.length > LOGIN_PHOTO_MAX_BYTES
    || !contentMatchesMimeType(bytes, mimeType)) return null;
  if (mimeType === "image/png" && !completeStaticPng(bytes)) return null;
  if (mimeType === "image/jpeg" && !completeStaticJpeg(bytes)) return null;
  const dimensions = imageSize(bytes);
  if (!dimensions || !validLoginPhotoDimensions(dimensions.width, dimensions.height)) return null;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const extension = LOGIN_PHOTO_EXTENSIONS[mimeType as keyof typeof LOGIN_PHOTO_EXTENSIONS];
  return parseLoginPhotoAsset(JSON.stringify({
    key: `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.${extension}`,
    sha256, mimeType, sizeBytes: bytes.length, ...dimensions,
  }));
}
export async function readVerifiedLoginPhoto(asset: LoginPhotoAsset): Promise<Buffer | null> {
  const bytes = await readFileByKey(asset.key);
  if (!bytes) return null;
  const actual = validateLoginPhotoBytes(bytes, asset.mimeType);
  return actual && actual.key === asset.key && actual.sha256 === asset.sha256
    && actual.sizeBytes === asset.sizeBytes && actual.width === asset.width && actual.height === asset.height ? bytes : null;
}
export async function storeLoginPhoto(bytes: Buffer, mimeType: string): Promise<LoginPhotoAsset> {
  const asset = validateLoginPhotoBytes(bytes, mimeType);
  if (!asset) throw new Error("INVALID_LOGIN_PHOTO");
  const file = await putFile(bytes, LOGIN_PHOTO_EXTENSIONS[asset.mimeType]);
  // Existing driver deduplicates by key; do not trust pre-existing content blindly.
  if (file.key !== asset.key || !(await readVerifiedLoginPhoto(asset))) throw new Error("LOGIN_PHOTO_STORAGE_INTEGRITY");
  return asset;
}
