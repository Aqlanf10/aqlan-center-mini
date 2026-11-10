import { studyNotesProjectionHash } from "./ortho-study-presentation-notes";
import {wrapStudyTextLine} from './ortho-study-display';
import {CASE_PAGE,caseLayout} from './ortho-case-template';
import type {JourneyScope} from './ortho-case-journey-records';
import type {StudyRevision} from './ortho-case-study-history';
import type {StudySavedContent} from './ortho-case-study-capture';
import {studyTextPresentation,type StudyTextPresentation,type StudyTextPage} from './ortho-study-text-export';
import {planOrthoMediaGeometry,type OrthoStudyMediaUseDraft} from './ortho-study-media';
import type {StudyGroupDraft} from './ortho-case-study';
export const STUDY_ILLUSTRATED_RENDERER='ortho-illustrated-v8-readable-model';
export const STUDY_ILLUSTRATED_LIMITS=Object.freeze({images:40,pages:300,bytes:24*1024*1024});
const viewLabels:Record<OrthoStudyMediaUseDraft['view'],string>={unassigned:'منظر غير محدد','face-rest':'الوجه في الراحة','face-smile':'الابتسامة',profile:'الوجه الجانبي','intraoral-front':'داخل الفم — أمامي','intraoral-right':'داخل الفم — يمين','intraoral-left':'داخل الفم — يسار','occlusal-upper':'إطباقي علوي','occlusal-lower':'إطباقي سفلي',panoramic:'بانوراما',cephalometric:'سيفالومتري',other:'منظر آخر'};
export interface StudyIllustratedImage {
 use:OrthoStudyMediaUseDraft;frame:{width:number;height:number};resolutionWarning:boolean;
 group:StudyGroupDraft|null;
 png:Uint8Array;sourceSha256:string;recipeSha256:string;geometrySha256:string;renditionSha256:string;processorVersion:string;
}
export interface StudyIllustratedPage extends StudyTextPage {image?:StudyIllustratedImage}
export interface StudyIllustratedPresentation extends Omit<StudyTextPresentation,'pages'>{pages:StudyIllustratedPage[]}
/** Selection order and frame are derived solely from the saved version. */
export async function illustrateSavedStudy(revision:StudyRevision<StudySavedContent>,scope:JourneyScope,
 render:(use:OrthoStudyMediaUseDraft,frame:{width:number;height:number})=>Promise<Omit<StudyIllustratedImage,'use'|'frame'|'resolutionWarning'|'group'>>):Promise<StudyIllustratedPresentation>{
 revision=structuredClone(revision); scope={...scope};
 const panels=revision.content.authored.panels.filter(p=>p.included),count=panels.reduce((n,p)=>n+p.images.length,0);
 if(count>STUDY_ILLUSTRATED_LIMITS.images)throw Error('study_illustrated_image_limit');
 const exportedKeys=new Set(panels.filter(panel=>panel.state==='available').flatMap(panel=>panel.sourceKeys));
 const full=studyTextPresentation(revision,scope,true),pages:StudyIllustratedPage[]=[];let bytes=0;
 const add=(p:StudyIllustratedPage)=>{pages.push(p);if(pages.length>STUDY_ILLUSTRATED_LIMITS.pages)throw Error('study_illustrated_page_limit');};
 const panelPages=panels.flatMap(panel=>studyTextPresentation(revision,scope,true,panel.instanceId).pages);
 full.pages.slice(0,full.pages.length-panelPages.length).forEach(add);
 for(const panel of panels){
  const text=studyTextPresentation(revision,scope,true,panel.instanceId);
  text.pages.forEach(add);
  for(const binding of panel.images){
   const use=revision.content.authored.mediaUses.find(u=>u.useId===binding.useId),layout=caseLayout(panel.layoutKey),slot=layout?.images.find(s=>s.slotId===binding.slot);
   if(!use||!slot||panel.state!=='available')throw Error('study_illustrated_binding');
   const capture=revision.content.sources.find(source=>panel.sourceKeys.includes(source.selection.key) && source.selection.kind==='document' && source.selection.id===use.documentId && source.selection.contentHash===use.sourceSha256);
   if(!capture||capture.state!=='available')throw Error('study_illustrated_saved_source_unavailable');
   const frame={width:Math.ceil(slot.w*CASE_PAGE.imageDpi),height:Math.ceil(slot.h*CASE_PAGE.imageDpi)},rendered=await render(use,frame);
   bytes+=rendered.png.byteLength;if(bytes>STUDY_ILLUSTRATED_LIMITS.bytes)throw Error('study_illustrated_byte_limit');
   if(rendered.sourceSha256!==use.sourceSha256)throw Error('study_illustrated_source_changed');
   const savedGroup=revision.content.authored.groups.find(g=>g.id===use.groupId);
   const group=savedGroup?{...savedGroup,sourceKeys:savedGroup.sourceKeys.filter(key=>exportedKeys.has(key))}:undefined;
   const provenance=`المستند #${use.documentId} • ${viewLabels[use.view]}`;
   add({title:layout!.titleAr,sourceKeys:[...panel.sourceKeys],lines:[provenance],image:{...rendered,use,group:group??null,frame,resolutionWarning:planOrthoMediaGeometry(use.recipe,frame).resolutionWarning}});
   // Captions may be long. Keep them editable and paginate, never truncate.
   {const dateSource={contemporaneous_record:'تسجيل معاصر للحدث',retrospective_record:'تسجيل لاحق للحدث',historical_source:'مصدر تاريخي',unknown:'غير معروف'};
    const description=[`الصورة المختارة من المستند #${use.documentId}`,`المجموعة الزمنية: ${group?.label??'غير مسجلة'}`,`تاريخ المجموعة: ${group?.occurrence.occurredOn??'غير معروف'} — المصدر: ${dateSource[group?.occurrence.dateProvenance??'unknown']}`,`المرحلة: ${group?.phase??'غير مسجلة'}`,group?.occurrence.sourceNote?`مرجع التاريخ: ${group.occurrence.sourceNote}`:'',use.caption?`تعليق الصورة: ${use.caption}`:''].filter(Boolean).join('\n');
    const lines=description.split('\n').flatMap(part=>wrapStudyTextLine(part));
    for(let i=0;i<lines.length;i+=12)add({title:`${layout!.titleAr} — تعليق الصورة`,sourceKeys:[...panel.sourceKeys],lines:lines.slice(i,i+12)});}
  }
 }
 const value={...full,pages}; value.projectionHash=studyNotesProjectionHash(value); return value;
}
