import {getOrthoCaseStudy} from './ortho-case-study-store';
import {getStudyImagePreview} from './ortho-study-image-store';
import {illustrateSavedStudy} from './ortho-study-illustrated';
import type {JourneyOwnerInput} from './ortho-case-journey-authority';
let active=false;
/** Bounded per-process export; private rasters only, never original media URLs.
 * The callback runs inside the slot so simultaneous PPTX encoders cannot bypass it.
 * Authority is checked again after the callback, before anything is returned. */
export async function withIllustratedStudy<T>(input:JourneyOwnerInput&{revisionId:number},consume:(value:Awaited<ReturnType<typeof illustrateSavedStudy>>)=>Promise<T>){
 if(active)return {ok:false as const,status:409,code:'study_illustrated_busy'};
 active=true;
 try{
  const saved=await getOrthoCaseStudy(input);if(!saved.ok)return saved;
  if(!saved.revision)return {ok:false as const,status:404,code:'study_revision_not_found'};
  const value=await illustrateSavedStudy(saved.revision,saved,async(use,frame)=>{
   const image=await getStudyImagePreview({...input,command:{patientId:input.patientId,documentId:use.documentId,sha256:use.sourceSha256,useId:use.useId,purpose:'selected-use',recipe:use.recipe,frame}});
   if(!image.ok)throw Error(image.code);return image;
  });
  const output=await consume(value);
  const fresh=await getOrthoCaseStudy(input);if(!fresh.ok)return fresh;
  if(fresh.revision?.contentHash!==value.revisionHash)return {ok:false as const,status:409,code:'study_changed'};
  return {ok:true as const,value,output};
 }finally{active=false;}
}

import {createHash} from 'node:crypto';
import {CASE_PAGE,caseLayout} from './ortho-case-template';
import {canonicalOrthoMediaRecipe,canonicalOrthoMediaGeometryWitness} from './ortho-study-media';
import {STUDY_IMAGE_LIMITS,STUDY_IMAGE_PROCESSOR} from './ortho-study-image-contract';
import {journeyId,journeyHash} from './ortho-case-journey-records';
export interface SavedStudyPanelImageInput extends JourneyOwnerInput {clinicalCaseId:number;revisionId:number;revisionHash:string;panelId:string;useId:string;slot:string}
const previewFailure=(status:number,code:string)=>({ok:false as const,status,code});
/** Saved-panel review, including available panels excluded from exports. No caller
 * recipe or file reference is accepted; exact saved facts determine the raster. */
export async function getSavedStudyPanelImage(input:SavedStudyPanelImageInput){
 if(![input.patientId,input.orthoCaseId,input.clinicalCaseId,input.revisionId].every(journeyId)||!journeyHash(input.revisionHash)||![input.panelId,input.useId,input.slot].every(v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v)))return previewFailure(400,'invalid_saved_image_scope');
 const saved=await getOrthoCaseStudy(input);if(!saved.ok)return saved;
 const matches=(read:typeof saved)=>read.patientId===input.patientId&&read.orthoCaseId===input.orthoCaseId&&read.clinicalCaseId===input.clinicalCaseId&&read.revision?.id===input.revisionId&&read.revision.contentHash===input.revisionHash;
 if(!matches(saved))return previewFailure(409,'study_saved_image_changed');
 const revision=saved.revision!,panel=revision.content.authored.panels.find(p=>p.instanceId===input.panelId);
 const binding=panel?.images.find(b=>b.useId===input.useId&&b.slot===input.slot),use=revision.content.authored.mediaUses.find(u=>u.useId===input.useId),slot=panel&&caseLayout(panel.layoutKey)?.images.find(s=>s.slotId===input.slot);
 if(!panel||panel.state!=='available'||!binding||!use||!slot)return previewFailure(409,'study_saved_image_binding');
 const capture=revision.content.sources.find(s=>panel.sourceKeys.includes(s.selection.key)&&s.selection.kind==='document'&&s.selection.id===use.documentId&&s.selection.contentHash===use.sourceSha256);
 if(capture?.state!=='available')return previewFailure(409,'study_saved_image_source_unavailable');
 const frame={width:Math.ceil(slot.w*CASE_PAGE.imageDpi),height:Math.ceil(slot.h*CASE_PAGE.imageDpi)};
 if(frame.width*frame.height>STUDY_IMAGE_LIMITS.outputPixels)return previewFailure(409,'study_image_size_limit');
 const image=await getStudyImagePreview({...input,command:{patientId:input.patientId,documentId:use.documentId,sha256:use.sourceSha256,useId:use.useId,purpose:'selected-use',recipe:use.recipe,frame}});if(!image.ok)return image;
 const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
 if(image.patientId!==input.patientId||image.orthoCaseId!==input.orthoCaseId||image.clinicalCaseId!==input.clinicalCaseId||image.documentId!==use.documentId||image.useId!==use.useId||image.purpose!=='selected-use'||image.width!==frame.width||image.height!==frame.height||image.sourceSha256!==use.sourceSha256||image.processorVersion!==STUDY_IMAGE_PROCESSOR||image.png.byteLength>STUDY_IMAGE_LIMITS.outputBytes||image.recipeSha256!==hash(canonicalOrthoMediaRecipe(use.recipe))||image.geometrySha256!==hash(canonicalOrthoMediaGeometryWitness(use.recipe,frame))||image.renditionSha256!==hash(image.png))return previewFailure(409,'study_saved_image_proof');
 const fresh=await getOrthoCaseStudy(input);if(!fresh.ok)return fresh;
 if(!matches(fresh))return previewFailure(409,'study_saved_image_changed');
 if(input.session.expiresAt<Date.now())return previewFailure(401,'session_expired');
 return {...image,actorId:input.session.userId,revisionId:input.revisionId,revisionHash:input.revisionHash,panelId:input.panelId,slot:input.slot};
}
