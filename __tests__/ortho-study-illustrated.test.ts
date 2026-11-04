import {createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import sharp from 'sharp';
import JSZip from 'jszip';
import {illustrateSavedStudy} from '../lib/ortho-study-illustrated';
import {renderIllustratedStudyPptx} from '../lib/ortho-study-illustrated-pptx';
import {renderStudyImage} from '../lib/ortho-study-image-processor';
import {defaultOrthoMediaRecipe} from '../lib/ortho-study-media';
import {CASE_TEMPLATE_VERSION} from '../lib/ortho-case-template';
import {STUDY_TEMPLATE_HASH} from '../lib/ortho-case-study-template';
import {journeyContentHash} from '../lib/ortho-case-journey-hash';
import type {StudyRevision} from '../lib/ortho-case-study-history';
import type {StudySavedContent} from '../lib/ortho-case-study-capture';
async function fixture(){
 const bytes=await sharp({create:{width:80,height:120,channels:3,background:'#aa1122'}}).composite([{input:await sharp({create:{width:40,height:120,channels:3,background:'#2244ee'}}).png().toBuffer(),left:40,top:0}]).withMetadata({orientation:6}).png().toBuffer();
 const hash=createHash('sha256').update(bytes).digest('hex'),scope={patientId:1,orthoCaseId:2,clinicalCaseId:3};
 const content:StudySavedContent={schemaVersion:1,capturedAt:'2026-11-04T00:00:00.000Z',recordedPatientId:1,orthoCaseId:2,clinicalCaseId:3,caseStatusAtCapture:'assessment',sources:[],authored:{template:{key:'full-orthodontic-case',version:CASE_TEMPLATE_VERSION,contentHash:STUDY_TEMPLATE_HASH},identityDisclosure:'case_only',sources:[{key:'image',kind:'document',id:6,version:null,contentHash:hash}],groups:[],comment:'Synthetic saved comment <script>',
  panels:[{instanceId:'face',layoutKey:'face-overview',included:true,state:'available',sourceKeys:['image'],images:[{slot:'face-profile',useId:'left'},{slot:'face-front',useId:'right'}],comment:''}],
  mediaUses:['left','right'].map((useId,i)=>({useId,documentId:6,sourceSha256:hash,groupId:null,slotId:i?'face-front':'face-profile',order:i,view:'face-rest',caption:i?'Synthetic second crop':'ع🙂'.repeat(600),recipe:{...defaultOrthoMediaRecipe(120,80,6),cropPpm:{left:0,right:1000000,top:i?500000:0,bottom:i?1000000:500000}}}))}};
 content.sources=[{selection:content.authored.sources[0],state:'available',unavailableReason:null,access:{images:true,plans:false},payload:{id:6,title:'Synthetic image',mimeType:'image/png',sizeBytes:bytes.length,contentHash:hash,width:80,height:120}}];
 content.authored.panels.unshift({instanceId:'history',layoutKey:'interview',included:true,state:'not_recorded',sourceKeys:[],images:[],comment:''});
 const revision:StudyRevision<StudySavedContent>={...scope,id:4,actorId:5,version:1,recordedPatientId:1,schemaVersion:1,predecessorId:null,kind:'draft',documentedFromId:null,baseDocumentedId:null,createdAt:content.capturedAt,reason:'Synthetic illustrated export',contentHash:journeyContentHash(content),content};
 return {bytes,scope,revision};
}
describe('illustrated saved clinical export',()=>{
 it('embeds exactly the processed saved crops with editable text, full captions and source/recipe witnesses',async()=>{
  const p=await fixture(),before=JSON.stringify(p.revision),images:Buffer[]=[];
  const value=await illustrateSavedStudy(p.revision,p.scope,async(use,frame)=>{const r=await renderStudyImage(p.bytes,use.recipe,frame);images.push(r.png);return r;});
  expect(JSON.stringify(p.revision)).toBe(before);expect(images).toHaveLength(2);expect(images[0]).not.toEqual(images[1]);
  expect(value.pages.flatMap(p=>p.lines).join('')).toContain('ع🙂'.repeat(600));
  expect(value.pages.flatMap(p=>p.lines).join('')).toContain('تاريخ المجموعة: غير معروف');
  const zip=await JSZip.loadAsync(await renderIllustratedStudyPptx(value));
  const media=await Promise.all(Object.keys(zip.files).filter(k=>/^ppt\/media\/[^/]+$/.test(k)).map(k=>zip.file(k)!.async('nodebuffer')));
  expect(media).toHaveLength(2);for(const png of images)expect(media.some(b=>b.equals(png))).toBe(true);expect(media.some(b=>b.equals(p.bytes))).toBe(false);
  const xml=(await Promise.all(Object.keys(zip.files).filter(k=>/^ppt\/slides\/slide\d+\.xml$/.test(k)).map(k=>zip.file(k)!.async('text')))).join('');
  expect(xml).toContain('Synthetic saved comment &lt;script&gt;');expect(xml).toContain('<a:t>');expect(xml).toContain('rtl="1"');
  const notes=(await Promise.all(Object.keys(zip.files).filter(k=>/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(k)).map(k=>zip.file(k)!.async('text')))).join('');
  for(const page of value.pages.filter(p=>p.image)){expect(notes).toContain(page.image!.sourceSha256);expect(notes).toContain(page.image!.geometrySha256);expect(notes).toContain(page.image!.renditionSha256);}
  expect(Object.keys(zip.files).some(k=>/embeddings/.test(k)&&!zip.files[k].dir)).toBe(false);
 });
 it('fails closed on missing image and limits, and omits excluded panels',async()=>{
  const p=await fixture();let calls=0;
  await expect(illustrateSavedStudy(p.revision,p.scope,async()=>{calls++;throw Error('missing image');})).rejects.toThrow('missing image');expect(calls).toBe(1);
  const face=p.revision.content.authored.panels[1],images=face.images;
  face.images=Array.from({length:41},()=>({slot:'face-front',useId:'right'}));
  await expect(illustrateSavedStudy(p.revision,p.scope,async()=>{throw Error('must not render');})).rejects.toThrow('image_limit');
  face.images=images;face.included=false;
  const out=await illustrateSavedStudy(p.revision,p.scope,async()=>{throw Error('must not render excluded image');});expect(out.pages.every(p=>!p.image)).toBe(true);
 });
});
