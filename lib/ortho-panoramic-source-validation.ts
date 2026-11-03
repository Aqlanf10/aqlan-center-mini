import type { DbClient } from "./db";
import type { AssessmentDraftV2 } from "./ortho-assessment-measurement-set-v2";
import { panoramicFindingReferences } from "./ortho-panoramic-findings";
import { assessmentFail } from "./ortho-assessment-authority";
import type { AssessmentScope } from "./ortho-assessment-response-v2";

/** Called after the existing source graph has locked and validated documents.
 * Exact case and image kind are independent of the document byte witness. */
export async function validatePanoramicFindingSources(client: DbClient, scope: AssessmentScope, draft: AssessmentDraftV2) {
  const result = panoramicFindingReferences(draft);
  if (!result.ok) assessmentFail(400, result.code, "تعليق البانوراما لا يطابق الصورة أو السن المحدد؛ راجع مصدره.");
  if (!result.references.length) return;
  const ids = result.references.map(s => s.id);
  const rows = (await client.query<{ id: number; sha256: string }>(`SELECT id,sha256 FROM patient_documents
    WHERE patient_id=$1 AND ortho_case_id=$2 AND id=ANY($3::int[]) AND removed_at IS NULL
      AND photo_view='panoramic' AND (photo_stage IS NULL OR photo_stage<>'archived')
      AND mime_type IN ('image/jpeg','image/png','image/webp')`, [scope.patientId, scope.orthoCaseId, ids])).rows;
  if (result.references.some(source => !rows.some(row => row.id === source.id && source.version === `sha256:${row.sha256}`)))
    assessmentFail(409, "panoramic_source_unavailable", "يلزم أصل بانوراما متاح ومرتبط بهذه الحالة تحديداً؛ لم تُنسب صورة مرجعية إلى الحالة تلقائياً.");
}
