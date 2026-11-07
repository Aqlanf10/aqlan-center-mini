/** Synthetic-only image/export fixture. No DB, network or real patient media. */
import {mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {defaultOrthoMediaRecipe} from '../lib/ortho-study-media';
import {illustrateSavedStudy} from '../lib/ortho-study-illustrated';
import {renderStudyImage} from '../lib/ortho-study-image-processor';
import {renderIllustratedStudyPptx} from '../lib/ortho-study-illustrated-pptx';
import {syntheticStudyCommand} from './fixtures/ortho-case-study';
import {journeyContentHash} from '../lib/ortho-case-journey-hash';
import type {StudyRevision} from '../lib/ortho-case-study-history';
import type {StudySavedContent} from '../lib/ortho-case-study-capture';
async function main(){
 const directory='docs/ortho/evidence/illustrated-study-20261105';mkdirSync(directory,{recursive:true});
 const bytes=await sharp(Buffer.from([220,35,50,40,90,220,30,160,80,245,200,25]),{raw:{width:2,height:2,channels:3}}).resize(1200,800,{kernel:'nearest'}).withMetadata({orientation:6}).png().toBuffer();
 const hash=createHash('sha256').update(bytes).digest('hex');
 const authored=syntheticStudyCommand().content;
 authored.comment='ألوان اصطناعية للتحقق من القص والاتجاه. لا توجد صور مرضى أو بيانات مرضى حقيقيين.';
 authored.sources=[{key:'synthetic_image',kind:'document',id:900006,version:null,contentHash:hash}];
 authored.groups=[{id:'timepoint_T1',label:'T1',phase:'T1',occurrence:{occurredOn:'2020-02-29',dateProvenance:'historical_source',sourceNote:'تاريخ اصطناعي للتحقق من ترتيب العرض فقط'},sourceKeys:['synthetic_image']}];
 authored.mediaUses=['imageA','imageB'].map((useId,index)=>({useId,documentId:900006,sourceSha256:hash,groupId:'timepoint_T1',slotId:index?'face-profile':'face-front',order:index,view:'unassigned',caption:index?'قص مختلف من الأصل نفسه؛ الأصل لا يُضمن خلف القص.':'تعليق عربي محفوظ. تُراجع الصورة ضمن النسخة المحفوظة فقط، ولا تُستخدم هذه التعديلات لحساب القياسات.',recipe:{...defaultOrthoMediaRecipe(800,1200,6),cropPpm:{left:0,top:index?500000:0,right:1000000,bottom:index?1000000:500000},brightnessPermille:index?1100:1000}}));
 authored.panels=[{instanceId:'face',layoutKey:'face-overview',included:true,state:'available',sourceKeys:['synthetic_image'],images:authored.mediaUses.map(use=>({slot:use.slotId,useId:use.useId})),comment:'النسخة مصورة سريرية وليست مجهولة الهوية للنشر.'}];
 const content:StudySavedContent={schemaVersion:1,capturedAt:'2026-11-05T00:00:00.000Z',recordedPatientId:900001,orthoCaseId:900002,clinicalCaseId:900003,caseStatusAtCapture:'assessment',authored,sources:[{selection:authored.sources[0],state:'available',unavailableReason:null,access:{images:true,plans:false},payload:{id:900006,title:'Synthetic colors',mimeType:'image/png',sizeBytes:bytes.length,contentHash:hash,width:1200,height:800}}]};
 const revision:StudyRevision<StudySavedContent>={patientId:900001,orthoCaseId:900002,clinicalCaseId:900003,id:900004,actorId:900005,version:1,recordedPatientId:900001,schemaVersion:1,predecessorId:null,kind:'draft',documentedFromId:null,baseDocumentedId:null,createdAt:content.capturedAt,reason:'Synthetic illustrated verification',contentHash:journeyContentHash(content),content};
 const presentation=await illustrateSavedStudy(revision,revision,(use,frame)=>renderStudyImage(bytes,use.recipe,frame));
 writeFileSync(`${directory}/synthetic-illustrated.pptx`,await renderIllustratedStudyPptx(presentation));
 writeFileSync(`${directory}/synthetic-witnesses.json`,JSON.stringify({...presentation,pages:presentation.pages.map(page=>({...page,image:page.image?{...page.image,png:undefined}:undefined}))},null,2));
}
void main();
