"use client";
import {useEffect,useState} from 'react';
import type {StudyOwner} from '@/lib/ortho-case-study-owner';
import type {StudyEditorRevision} from '@/lib/ortho-case-study-editor-contract';
import {CASE_PAGE,caseLayout} from '@/lib/ortho-case-template';
import {fetchStudyImagePreview} from '@/lib/ortho-study-image-client';
import {captureStudyImagePreviewRequest,verifyStudyImagePreview} from '@/lib/ortho-study-image-editor';
import {planOrthoMediaGeometry,type OrthoStudyMediaUseDraft} from '@/lib/ortho-study-media';
const control='min-h-11 min-w-11 rounded border px-3 py-2';
interface Props {owner:StudyOwner;readVersion:number;revision:StudyEditorRevision;panelId:string}
/** A separate read of the selected saved revision. Never reads the local draft. */
export default function OrthoSavedStudyImages(props:Props){
 const [expanded,setExpanded]=useState(false),[selected,setSelected]=useState('');
 const panel=props.revision.authored.panels.find(p=>p.instanceId===props.panelId);
 const uses=panel?.images.map(binding=>props.revision.authored.mediaUses.find(use=>use.useId===binding.useId)).filter((u):u is OrthoStudyMediaUseDraft=>!!u)??[];
 const use=uses.find(u=>u.useId===selected)??uses[0];
 const slot=panel&&use?caseLayout(panel.layoutKey)?.images.find(s=>s.slotId===use.slotId):null;
 if(!use||!slot||panel?.state!=='available')return null;
 return <section aria-label="صور النسخة المحفوظة" className="rounded border p-3 space-y-2">
  <button type="button" className={control} aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>{expanded?'إغلاق صور النسخة المحفوظة':'معاينة صور النسخة المحفوظة'}</button>
  {expanded&&<><p>النسخة {props.revision.version} — التعديلات غير المحفوظة لا تغير هذه المعاينة.</p>
   <label>الصورة المحفوظة<select aria-label="الصورة المحفوظة" className={`${control} max-w-full`} value={use.useId} onChange={e=>setSelected(e.currentTarget.value)}>{uses.map((u,i)=><option key={u.useId} value={u.useId}>{i+1} — المستند #{u.documentId} — {u.slotId}</option>)}</select></label>
   <SavedImage key={JSON.stringify([props.revision.id,props.revision.contentHash,props.readVersion,use.useId])} {...props} use={use} frame={{width:Math.ceil(slot.w*CASE_PAGE.imageDpi),height:Math.ceil(slot.h*CASE_PAGE.imageDpi)}} />
  </>}
 </section>;
}
function SavedImage({owner,readVersion,revision,use,frame}:Props&{use:OrthoStudyMediaUseDraft;frame:{width:number;height:number}}){
 const {width,height}=frame;
 const [url,setUrl]=useState<string|null>(null),[error,setError]=useState(false),[retry,setRetry]=useState(0);
 useEffect(()=>{
  let live=true,objectUrl:string|null=null;const abort=new AbortController();
  const current=()=>live&&!abort.signal.aborted&&owner.active()&&owner.matches(revision)&&owner.readVersion===readVersion;
  const ownerKey=JSON.stringify(['saved-study-image',revision.id,revision.contentHash,readVersion,use.useId]);
  const request=captureStudyImagePreviewRequest({ownerKey,useId:use.useId,documentId:use.documentId,sourceSha256:use.sourceSha256,purpose:'selected-use',recipe:use.recipe,frame:{width,height},signal:abort.signal});
  void(async()=>{try{
   const result=await fetchStudyImagePreview({...revision,ownerKey},request);if(!current())return;
   if(!result.ok){if(result.code==='forbidden')owner.denied();throw Error('saved_image_unavailable');}
   if(!await verifyStudyImagePreview(result.preview,request))throw Error('saved_image_witness');if(!current())return;
   objectUrl=URL.createObjectURL(result.preview.blob);setError(false);setUrl(objectUrl);
  }catch{if(current())setError(true);}})();
  return()=>{live=false;abort.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
 },[owner,readVersion,revision,use,width,height,retry]);
 if(!owner.active()||!owner.matches(revision)||owner.readVersion!==readVersion)return <p role="status">تغيرت صلاحية أو هوية العرض؛ يلزم تحقق جديد.</p>;
 return <figure className="space-y-2">
  {error?<div role="alert"><p>تعذرت معاينة هذه الصورة المحفوظة. لم تُستبدل بصورة أخرى؛ راجع المصدر والصلاحية أو أعد المحاولة.</p><button type="button" className={control} onClick={()=>{setUrl(null);setError(false);setRetry(v=>v+1);}}>إعادة معاينة الصورة المحفوظة</button></div>:url?<>
   {/* Verified private PNG blob, revoked on owner/selection change. */}
   <img src={url} alt="صورة من النسخة المحفوظة" width={frame.width} height={frame.height} className="mx-auto max-h-[32rem] max-w-full object-contain" />
   {planOrthoMediaGeometry(use.recipe,frame).resolutionWarning&&<p role="status">دقة الأصل أقل من حجم الإطار؛ راجع وضوح الصورة.</p>}
  </>:<p role="status">جارٍ التحقق من الصورة المحفوظة…</p>}
  <figcaption className="break-words">المستند #{use.documentId} — النسخة {revision.version}{use.caption?` — ${use.caption}`:''}</figcaption>
 </figure>;
}
