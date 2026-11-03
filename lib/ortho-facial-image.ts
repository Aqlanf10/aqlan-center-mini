import { createHash } from "node:crypto";
import sharp from "sharp";
import { readFileByKey } from "./files";
import { journeyFail } from "./ortho-case-journey-authority";
import type { FacialContent } from "./ortho-facial-analysis";

/** Decode verified original bytes; only EXIF orientation is applied. Original
 * storage is untouched. No resizing, beauty edits, inferred scale or network URL. */
export async function facialImageBasis(source: { sha256: string; storage_key: string; mime_type: string; size_bytes: unknown }, render = false): Promise<{ basis: FacialContent["image"]; png: Buffer | null }> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(source.mime_type) || Number(source.size_bytes) > 25*1024*1024)
    journeyFail(409,"facial_image_unsupported","اختر صورة JPEG أو PNG أو WebP لا تتجاوز 25 ميغابايت.");
  const bytes = await readFileByKey(source.storage_key);
  if (!bytes || bytes.length !== Number(source.size_bytes) || createHash("sha256").update(bytes).digest("hex") !== source.sha256)
    journeyFail(409,"facial_image_integrity","تعذّر التحقق من أصل الصورة وبصمتها؛ لم تُنقل المعالم إلى صورة أخرى.");
  try {
    const decoder = sharp(bytes,{limitInputPixels:40_000_000,failOn:"error"});
    const metadata = await decoder.metadata();
    if (!["jpeg","png","webp"].includes(metadata.format ?? "") || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw Error("unsupported_image");
    const orientation = metadata.orientation ?? 1;
    if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) throw Error("invalid_orientation");
    const basis = {sha256:source.sha256,width:orientation >= 5 ? metadata.height : metadata.width,height:orientation >= 5 ? metadata.width : metadata.height,exifOrientation:orientation};
    const png = render ? await decoder.autoOrient().png().timeout({seconds:10}).toBuffer() : null;
    return {basis,png};
  } catch { journeyFail(409,"facial_image_decode","تعذّر فك الصورة أو تجاوزت حدود المعالجة؛ الأصل محفوظ دون تغيير."); }
}
