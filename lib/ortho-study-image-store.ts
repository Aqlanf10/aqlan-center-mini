import { createHash } from "node:crypto";
import { readFileByKey } from "./files";
import { authorizeJourney, assertJourneyCurrent, journeyFail, journeyTransaction, lockJourneyOwner, type JourneyOwnerInput, type JourneyAuthority } from "./ortho-case-journey-authority";
import type { DbClient } from "./db";
import { inspectStudyImage, renderStudyImage, StudyImageError, withStudyImageSlot } from "./ortho-study-image-processor";
import { STUDY_IMAGE_LIMITS, type StudyImageCommand } from "./ortho-study-image-contract";
import { OrthoMediaContractError } from "./ortho-study-media";
async function source(client: DbClient, input: JourneyOwnerInput & { documentId: number; sha256: string }, authority: JourneyAuthority) {
  if (!authority.canViewImages) journeyFail(403, 'study_image_forbidden');
  const {rows:[doc]} = await client.query<{patient_id:number;ortho_case_id:number|null;sha256:string;storage_key:string;mime_type:string;size_bytes:string;removed_at:Date|null}>(
    'SELECT patient_id,ortho_case_id,sha256,storage_key,mime_type,size_bytes,removed_at FROM patient_documents WHERE id=$1 FOR SHARE', [input.documentId]);
  if (!doc || doc.patient_id !== input.patientId || doc.ortho_case_id !== input.orthoCaseId || doc.removed_at !== null) journeyFail(404,'study_image_unavailable');
  if (doc.sha256 !== input.sha256) journeyFail(409,'study_image_stale');
  if (!['image/jpeg','image/png','image/webp'].includes(doc.mime_type) || !Number.isSafeInteger(Number(doc.size_bytes)) || Number(doc.size_bytes) < 1 || Number(doc.size_bytes) > STUDY_IMAGE_LIMITS.inputBytes) journeyFail(409,'study_image_size_limit');
  return doc;
}
function imageFailure(error: unknown): never {
  if (error instanceof StudyImageError) journeyFail(409, `study_image_${error.code}`);
  if (error instanceof OrthoMediaContractError) journeyFail(409, error.code === 'orientation_required' ? 'study_image_orientation_required' : 'study_image_stale');
  journeyFail(409, 'study_image_unavailable');
}
async function withSlot<T>(work: () => Promise<T>) {
  try { return await withStudyImageSlot(work); }
  catch (error) { if (error instanceof StudyImageError && error.code === 'processor_busy') return {ok:false as const,status:409,code:'study_image_processor_busy',message:'المعاينة السابقة لم تنتهِ بعد؛ أعد المعاينة بعد قليل.'}; throw error; }
}
async function checkedBytes(doc: {storage_key:string;size_bytes:string;sha256:string}) {
  const bytes = await readFileByKey(doc.storage_key);
  if (!bytes || bytes.length !== Number(doc.size_bytes) || createHash('sha256').update(bytes).digest('hex') !== doc.sha256) journeyFail(409,'study_image_stale');
  return bytes;
}
export async function getStudyImageBasis(input: JourneyOwnerInput & {documentId:number;sha256:string}) {
  return withSlot(() => journeyTransaction(false, async client => {
    const authority = await authorizeJourney(client,input,false), doc = await source(client,input,authority);
    const owner = await lockJourneyOwner(client,input,false), bytes = await checkedBytes(doc);
    let basis;
    try { basis = await inspectStudyImage(bytes); } catch (error) { imageFailure(error); }
    if (`image/${basis.format}` !== doc.mime_type) journeyFail(409,'study_image_stale');
    assertJourneyCurrent(authority);
    return {ok:true as const,patientId:owner.patientId,orthoCaseId:owner.orthoCaseId,clinicalCaseId:owner.clinicalCaseId,documentId:input.documentId,sha256:input.sha256,
      basis:{orientedWidth:basis.orientedWidth,orientedHeight:basis.orientedHeight,exifOrientation:basis.exifOrientation}};
  }));
}
export async function getStudyImagePreview(input: JourneyOwnerInput & {command: StudyImageCommand}) {
  return withSlot(() => journeyTransaction(false, async client => {
    const c = input.command;
    if (c.patientId !== input.patientId) journeyFail(400,'invalid_scope');
    const authority = await authorizeJourney(client,input,false), doc = await source(client,{...input,documentId:c.documentId,sha256:c.sha256},authority);
    const owner = await lockJourneyOwner(client,input,false), bytes = await checkedBytes(doc);
    let rendered;
    try { rendered = await renderStudyImage(bytes,c.recipe,c.frame); } catch (error) { imageFailure(error); }
    assertJourneyCurrent(authority);
    return {ok:true as const,...rendered,patientId:owner.patientId,orthoCaseId:owner.orthoCaseId,clinicalCaseId:owner.clinicalCaseId,documentId:c.documentId,useId:c.useId,purpose:c.purpose};
  }));
}
