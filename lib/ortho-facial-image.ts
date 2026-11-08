import { createHash } from "node:crypto";
import sharp from "sharp";
import { readFileByKeyBounded } from "./files";
import { journeyFail } from "./ortho-case-journey-authority";
import { inspectStudyImage, withStudyImageSlot } from "./ortho-study-image-processor";
import { STUDY_IMAGE_LIMITS } from "./ortho-study-image-contract";
import type { FacialContent } from "./ortho-facial-analysis";

/** Verify and fully decode original bytes before either write admission or preview.
 * Apply EXIF exactly once; do not resize, infer scale or alter stored originals. */
export async function facialImageBasis(source: { sha256: string; storage_key: string; mime_type: string; size_bytes: unknown }, render = false): Promise<{ basis: FacialContent["image"]; png: Buffer | null }> {
  const size = Number(source.size_bytes);
  if (!["image/jpeg", "image/png", "image/webp"].includes(source.mime_type) || !Number.isSafeInteger(size) || size < 1 || size > STUDY_IMAGE_LIMITS.inputBytes)
    journeyFail(409,"facial_image_unsupported","اختر صورة JPEG أو PNG أو WebP ضمن حدود المعالجة الآمنة.");
  let bytes: Buffer | null;
  try { bytes = await readFileByKeyBounded(source.storage_key, size); }
  catch { journeyFail(409,"facial_image_integrity","تعذّر قراءة أصل الصورة ضمن حجمه الموثق."); }
  if (!bytes || bytes.length !== size || createHash("sha256").update(bytes).digest("hex") !== source.sha256)
    journeyFail(409,"facial_image_integrity","تعذّر التحقق من أصل الصورة وبصمتها؛ لم تُنقل المعالم إلى صورة أخرى.");
  try {
    return await withStudyImageSlot(async () => {
      const metadata = await inspectStudyImage(bytes);
      if (`image/${metadata.format}` !== source.mime_type) throw Error("source_mime_mismatch");
      // metadata() alone accepts some truncated payloads. Decode the entire
      // raster even when the caller requests only the dimensions/source witness.
      const output = await sharp(bytes,{limitInputPixels:STUDY_IMAGE_LIMITS.inputPixels,failOn:"error"})
        .autoOrient().png().timeout({seconds:STUDY_IMAGE_LIMITS.seconds}).toBuffer({resolveWithObject:true});
      if (output.info.width !== metadata.orientedWidth || output.info.height !== metadata.orientedHeight || output.data.length > 64*1024*1024)
        throw Error("source_decode_limit");
      const basis = {sha256:source.sha256,width:metadata.orientedWidth,height:metadata.orientedHeight,exifOrientation:metadata.exifOrientation};
      return {basis,png:render?output.data:null};
    });
  } catch { journeyFail(409,"facial_image_decode","تعذّر فك الصورة أو تجاوزت حدود المعالجة؛ الأصل محفوظ دون تغيير."); }
}
