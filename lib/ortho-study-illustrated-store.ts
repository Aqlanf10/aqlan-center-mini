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
