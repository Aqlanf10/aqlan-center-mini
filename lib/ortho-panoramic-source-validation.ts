import { createHash } from "node:crypto";
import { readFileByKeyBounded } from "./files";
import { STUDY_IMAGE_LIMITS } from "./ortho-study-image-contract";
import { inspectStudyImage, withStudyImageSlot, StudyImageError } from "./ortho-study-image-processor";
import type { DbClient } from "./db";
import type { AssessmentDraftV2 } from "./ortho-assessment-measurement-set-v2";
import { panoramicFindingReferences } from "./ortho-panoramic-findings";
import { assessmentFail } from "./ortho-assessment-authority";
import type { AssessmentScope } from "./ortho-assessment-response-v2";

/** New writes only, after the existing source graph has locked and validated
 * these documents and current imaging permission. Its FOR SHARE row locks keep
 * ownership, hash, MIME, view and archival/removal metadata stable through commit.
 * Exact case and image kind are independent of the document byte witness.
 * Confirmed immutable retries retain the store's existing replay semantics. */
export async function validatePanoramicFindingSources(client: DbClient, scope: AssessmentScope, draft: AssessmentDraftV2) {
  const result = panoramicFindingReferences(draft);
  if (!result.ok) assessmentFail(400, result.code, "تعليق البانوراما لا يطابق الصورة أو السن المحدد؛ راجع مصدره.");
  if (!result.references.length) return;
  const ids = result.references.map(s => s.id);
  const rows = (await client.query<{ id: number; sha256: string; storage_key: string; size_bytes: string; mime_type: string }>(`SELECT id,sha256,storage_key,size_bytes,mime_type FROM patient_documents
    WHERE patient_id=$1 AND ortho_case_id=$2 AND id=ANY($3::int[]) AND removed_at IS NULL
      AND photo_view='panoramic' AND (photo_stage IS NULL OR photo_stage<>'archived')
      AND mime_type IN ('image/jpeg','image/png','image/webp')`, [scope.patientId, scope.orthoCaseId, ids])).rows;
  if (result.references.some(source => !rows.some(row => row.id === source.id && source.version === `sha256:${row.sha256}`)))
    assessmentFail(409, "panoramic_source_unavailable", "يلزم أصل بانوراما متاح ومرتبط بهذه الحالة تحديداً؛ لم تُنسب صورة مرجعية إلى الحالة تلقائياً.");
  // Admit a bounded total before touching storage, and reuse the native image
  // processor slot. The metadata hash alone does not prove backing bytes exist.
  if (rows.some(row => !Number.isSafeInteger(Number(row.size_bytes)) || Number(row.size_bytes) < 1)
    || rows.reduce((sum, row) => sum + Number(row.size_bytes), 0) > STUDY_IMAGE_LIMITS.inputBytes)
    assessmentFail(409, "panoramic_source_size_limit", "حجم مصادر البانوراما يتجاوز حد التحقق الآمن.");
  try {
    await withStudyImageSlot(async () => {
      for (const row of rows) {
        const bytes = await readFileByKeyBounded(row.storage_key, Number(row.size_bytes));
        if (!bytes || bytes.length !== Number(row.size_bytes) || createHash("sha256").update(bytes).digest("hex") !== row.sha256)
          throw new Error("panoramic_bytes_unavailable");
        const image = await inspectStudyImage(bytes);
        if (`image/${image.format}` !== row.mime_type) throw new Error("panoramic_mime_mismatch");
      }
    });
  } catch (error) {
    assessmentFail(409, error instanceof StudyImageError && error.code === "processor_busy" ? "panoramic_source_busy" : "panoramic_source_unavailable", "تعذّر التحقق من أصل صورة البانوراما؛ أعد معاينتها قبل الحفظ.");
  }

}
