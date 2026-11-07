import { CASE_LAYOUTS, CASE_TEMPLATE_VERSION } from '../../lib/ortho-case-template';
import { STUDY_TEMPLATE_HASH } from '../../lib/ortho-case-study-template';
import { defaultOrthoMediaRecipe } from '../../lib/ortho-study-media';
import type { StudyEditorRevision } from '../../lib/ortho-case-study-editor-contract';
export function studyPreviewFixture(): StudyEditorRevision {
 const layout=CASE_LAYOUTS.find(l=>l.images.some(s=>s.sourceKind==='patient-document'))!,slot=layout.images.find(s=>s.sourceKind==='patient-document')!.slotId;
 return {patientId:19,orthoCaseId:41,clinicalCaseId:51,id:91,version:1,kind:'draft',actorId:7,contentHash:'a'.repeat(64),authoredHash:'b'.repeat(64),predecessorId:null,documentedFromId:null,baseDocumentedId:null,createdAt:'2026-11-06T00:00:00.000Z',reason:'Synthetic preview',authored:{template:{key:'full-orthodontic-case',version:CASE_TEMPLATE_VERSION,contentHash:STUDY_TEMPLATE_HASH},identityDisclosure:'case_only',comment:'',groups:[],sources:[{key:'doc1',kind:'document',id:61,version:null,contentHash:'c'.repeat(64)}],panels:[{instanceId:'panel1',layoutKey:layout.key,included:true,state:'available',sourceKeys:['doc1'],images:[{slot,useId:'use1'}],comment:''}],mediaUses:[{useId:'use1',documentId:61,sourceSha256:'c'.repeat(64),groupId:null,slotId:slot,order:0,view:'unassigned',caption:'Synthetic saved caption',recipe:defaultOrthoMediaRecipe(12,8,1)}]}};
}
