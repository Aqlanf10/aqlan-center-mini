import type { JourneyScope } from "./ortho-case-journey-records";
import { defaultOrthoMediaRecipe } from "./ortho-study-media";
import { STUDY_IMAGE_PROCESSOR, STUDY_IMAGE_LIMITS } from "./ortho-study-image-contract";
import type { StudyImagePreviewRequest, StudyImagePreviewResult } from "./ortho-study-image-editor";
export class StudyImageAccessDenied extends Error {}
export async function fetchStudyImageBasis(scope: JourneyScope, documentId: number, sha256: string, signal: AbortSignal) {
  const response = await fetch(`/api/ortho/${scope.orthoCaseId}/case-study/media?patientId=${scope.patientId}&documentId=${documentId}&sha256=${sha256}`,{cache:'no-store',signal});
  if ([401,403].includes(response.status)) throw new StudyImageAccessDenied('study_image_forbidden');
  if (!response.ok || response.redirected || !response.headers.get('cache-control')?.includes('no-store')) throw Error('study_image_basis_unavailable');
  const raw = await response.json();
  if (signal.aborted || raw?.ok !== true || raw.patientId !== scope.patientId || raw.orthoCaseId !== scope.orthoCaseId || raw.clinicalCaseId !== scope.clinicalCaseId || raw.documentId !== documentId || raw.sha256 !== sha256 || !raw.basis || raw.basis.exifOrientation === null) throw Error('study_image_basis_identity');
  return defaultOrthoMediaRecipe(raw.basis.orientedWidth,raw.basis.orientedHeight,raw.basis.exifOrientation);
}
export async function fetchStudyImagePreview(scope: JourneyScope & {ownerKey:string}, request: StudyImagePreviewRequest): Promise<StudyImagePreviewResult> {
  if (request.signal.aborted || request.ownerKey !== scope.ownerKey) return {ok:false,code:'stale'};
  const response = await fetch(`/api/ortho/${scope.orthoCaseId}/case-study/media`, {method:'POST',cache:'no-store',signal:request.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({
    patientId:scope.patientId,documentId:request.documentId,sha256:request.sourceSha256,useId:request.useId,purpose:request.purpose,recipe:request.recipe,frame:request.frame,
  })});
  if ([401,403].includes(response.status)) return {ok:false,code:'forbidden'};
  if (!response.ok) {
    const raw = await response.json().catch(()=>null);
    const code = raw?.code === 'study_image_size_limit' ? 'size_limit' : raw?.code === 'study_image_stale' ? 'stale' : raw?.code === 'study_image_orientation_required' ? 'orientation_required' : 'unavailable';
    return {ok:false,code};
  }
  const h = response.headers;
  if (request.signal.aborted || response.redirected || !h.get('cache-control')?.includes('no-store') || h.get('content-type') !== 'image/png'
    || h.get('x-study-patient') !== String(scope.patientId) || h.get('x-study-case') !== String(scope.orthoCaseId) || h.get('x-study-clinical-case') !== String(scope.clinicalCaseId)
    || h.get('x-study-document') !== String(request.documentId) || h.get('x-study-use') !== request.useId || h.get('x-study-purpose') !== request.purpose
    || h.get('x-study-source-sha256') !== request.sourceSha256 || h.get('x-study-processor') !== STUDY_IMAGE_PROCESSOR
    || h.get('x-study-width') !== String(request.frame.width) || h.get('x-study-height') !== String(request.frame.height)) return {ok:false,code:'stale'};
  const blob = await response.blob();
  if (request.signal.aborted || blob.size > STUDY_IMAGE_LIMITS.outputBytes) return {ok:false,code:'size_limit'};
  return {ok:true,preview:{useId:request.useId,documentId:request.documentId,sourceSha256:request.sourceSha256,recipeSha256:h.get('x-study-recipe-sha256')??'',renditionSha256:h.get('x-study-rendition-sha256')??'',
    processorVersion:STUDY_IMAGE_PROCESSOR,width:request.frame.width,height:request.frame.height,blob}};
}
