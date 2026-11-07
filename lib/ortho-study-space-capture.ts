/** Frozen ledger prefix. patientId is capture-time identity, never authority. */
import {journeyContentHash} from './ortho-case-journey-hash';
import {journeyId,journeyHash,type JourneyScope} from './ortho-case-journey-records';
import {readSpaceSavedContent} from './ortho-space-saved';
import {projectIpr} from './ortho-space-ledger';
import type {SpaceRevision} from './ortho-space-history';
import type {StudySourceSelection} from './ortho-case-study';
import {permitsOrthoDocumentation,orthoDocumentationContext} from './ortho-documentation-context';
export interface StudySpaceCapture {captureVersion:1;patientId:number;orthoCaseId:number;clinicalCaseId:number;headId:number;headVersion:number;history:SpaceRevision[]}
function fail():never{throw Error('invalid_study_space_capture');}
function object(raw:unknown,keys:string[]):Record<string,unknown>{if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==keys.length||keys.some(k=>!Object.hasOwn(raw,k)))fail();return raw as Record<string,unknown>;}
const text=(v:unknown,n:number)=>typeof v==='string'&&!!v.trim()&&v.length<=n;
export function readStudySpaceCapture(raw:unknown,selection:StudySourceSelection,scope?:JourneyScope):StudySpaceCapture{
 const c=object(raw,['captureVersion','patientId','orthoCaseId','clinicalCaseId','headId','headVersion','history']);
 if(c.captureVersion!==1||![c.patientId,c.orthoCaseId,c.clinicalCaseId,c.headId,c.headVersion].every(journeyId)||selection.kind!=='space_ledger'||selection.id!==c.headId||selection.version!==c.headVersion||scope&&(c.patientId!==scope.patientId||c.orthoCaseId!==scope.orthoCaseId||c.clinicalCaseId!==scope.clinicalCaseId)||!Array.isArray(c.history)||!c.history.length||c.history.length>1000||Buffer.byteLength(JSON.stringify(raw))>2097152)fail();
 const history=c.history.map((raw,index)=>{
  const r=object(raw,['patientId','orthoCaseId','clinicalCaseId','id','recordedPatientId','schemaVersion','version','predecessorId','createdBy','createdAt','reason','recordingContext','caseStatusAtCapture','contentHash','content']);
  if(r.patientId!==c.patientId||r.orthoCaseId!==c.orthoCaseId||r.clinicalCaseId!==c.clinicalCaseId||!journeyId(r.id)||r.recordedPatientId!==c.patientId||r.schemaVersion!==1||r.version!==Number(c.headVersion)-index||!text(r.createdBy,200)||!text(r.reason,500)||typeof r.createdAt!=='string'||!Number.isFinite(Date.parse(r.createdAt))||!journeyHash(r.contentHash)||!permitsOrthoDocumentation(r.caseStatusAtCapture)||r.recordingContext!==orthoDocumentationContext(r.caseStatusAtCapture))fail();
  const content=readSpaceSavedContent(r.content);if(!content.ok||journeyContentHash(content.value)!==r.contentHash||journeyContentHash(r.content)!==r.contentHash||content.value.authored.kind==='ipr'&&r.caseStatusAtCapture==='assessment')fail();
  if(content.value.adjustment){const day=content.value.adjustment.occurredOn;if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)fail();}
  return {...r,content:content.value} as unknown as SpaceRevision;
 });
 if(history[0].id!==c.headId||history.length!==c.headVersion||new Set(history.map(r=>r.id)).size!==history.length||history.some((r,i)=>r.predecessorId!==(history[i+1]?.id??null)))fail();
 const projection=projectIpr(history.map(r=>({id:r.id,version:r.version,content:r.content.authored})));if(!projection.ok||journeyContentHash(raw)!==selection.contentHash)fail();
 return {...c,history} as unknown as StudySpaceCapture;
}
