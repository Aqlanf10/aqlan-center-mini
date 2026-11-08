/** Browser transport proofs. Server authority remains the source of access decisions. */
import {canonicalJourneyJSON} from './ortho-case-journey-json';
import {journeyId,journeyHash,type JourneyScope} from './ortho-case-journey-records';
import {decodeRetentionSavedContent,type RetentionSavedContent} from './ortho-retention-history-store';
import {projectRetentionEventHistory} from './ortho-retention-event-history';
import {readRetentionPersistenceCommand,type RetentionPersistenceCommand} from './ortho-retention-command';
import {readRetentionDocumentWitnesses,type RetentionDocumentWitness} from './ortho-retention-document-witness';
import {permitsOrthoDocumentation,orthoDocumentationContext} from './ortho-documentation-context';
import type {JourneyRevision} from './ortho-case-journey-history';
export type RetentionRevision=JourneyRevision<RetentionSavedContent>;
type Projection=Extract<ReturnType<typeof projectRetentionEventHistory>,{ok:true}>['value'];
export interface RetentionLedgerRead extends Projection {ok:true;scope:JourneyScope;actorId:number;writable:boolean;headId:number|null;history:RetentionRevision[];sourceMatches:{entryId:number;documentId:number;identityMatch:boolean|null}[]}
export const retentionRecord=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export const retentionKeys=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k))&&Object.getOwnPropertySymbols(v).length===0;
export function retentionScopeMatches(raw:unknown,scope:JourneyScope){return retentionRecord(raw)&&retentionKeys(raw,['patientId','orthoCaseId','clinicalCaseId'])&&(['patientId','orthoCaseId','clinicalCaseId'] as const).every(k=>journeyId(scope[k])&&raw[k]===scope[k]);}
export async function retentionHash(value:unknown){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalJourneyJSON(value))))].map(v=>v.toString(16).padStart(2,'0')).join('');}
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=max;
const dense=(v:unknown,max:number):v is unknown[]=>Array.isArray(v)&&v.length<=max&&Object.keys(v).length===v.length&&Object.getOwnPropertySymbols(v).length===0&&Array.from({length:v.length},(_,i)=>Object.hasOwn(v,i)).every(Boolean);
export async function readRetentionRevision(raw:unknown,scope:JourneyScope):Promise<RetentionRevision|null>{
 if(!retentionRecord(raw)||!retentionKeys(raw,['patientId','orthoCaseId','clinicalCaseId','id','recordedPatientId','schemaVersion','version','predecessorId','createdBy','createdAt','reason','recordingContext','caseStatusAtCapture','contentHash','content'])||!journeyId(raw.id)||raw.patientId!==scope.patientId||raw.orthoCaseId!==scope.orthoCaseId||raw.clinicalCaseId!==scope.clinicalCaseId||raw.recordedPatientId!==scope.patientId||raw.schemaVersion!==1||!journeyId(raw.version)||raw.predecessorId!==null&&!journeyId(raw.predecessorId)||!text(raw.createdBy,200)||!text(raw.reason,500)||typeof raw.createdAt!=='string'||!Number.isFinite(Date.parse(raw.createdAt))||!journeyHash(raw.contentHash)||!permitsOrthoDocumentation(raw.caseStatusAtCapture)||!['active','retention','completed','discontinued'].includes(raw.caseStatusAtCapture)||raw.recordingContext!==orthoDocumentationContext(raw.caseStatusAtCapture))return null;
 const content=decodeRetentionSavedContent(raw.content);if(!content.ok||await retentionHash(content.value)!==raw.contentHash||await retentionHash(raw.content)!==raw.contentHash)return null;
 if('savedVersion' in content.value&&content.value.documentWitnesses.some(w=>w.patientId!==scope.patientId||w.orthoCaseId!==scope.orthoCaseId))return null;
 return {...raw,content:content.value} as RetentionRevision;
}
export async function verifyRetentionRead(raw:unknown,patientId:number,orthoCaseId:number,binding?:{scope:JourneyScope;actorId:number}):Promise<RetentionLedgerRead|null>{
 try{
 if(!retentionRecord(raw)||!retentionKeys(raw,['ok','scope','actorId','writable','headId','history','devices','currentEvents','sourceMatches'])||raw.ok!==true||!journeyId(patientId)||!journeyId(orthoCaseId)||!retentionRecord(raw.scope)||!journeyId(raw.scope.clinicalCaseId)||!journeyId(raw.actorId)||typeof raw.writable!=='boolean'||!dense(raw.history,1000)||!dense(raw.sourceMatches,30000))return null;
 const scope={patientId,orthoCaseId,clinicalCaseId:raw.scope.clinicalCaseId};if(!retentionScopeMatches(raw.scope,scope)||binding&&(!retentionScopeMatches(binding.scope,scope)||raw.actorId!==binding.actorId))return null;
 const history:RetentionRevision[]=[];for(const item of raw.history){const revision=await readRetentionRevision(item,scope);if(!revision)return null;history.push(revision);}
 if(new Set(history.map(h=>h.id)).size!==history.length||raw.headId!==(history[0]?.id??null)||history.some((h,i)=>h.version!==history.length-i||h.predecessorId!==(history[i+1]?.id??null)))return null;
 const projection=projectRetentionEventHistory(history.map(r=>({id:r.id,version:r.version,arch:r.content.arch,supersedesEntryId:r.content.supersedesEntryId,archCorrectionReason:r.content.archCorrectionReason,content:r.content.payload})));
 if(!projection.ok||canonicalJourneyJSON(projection.value)!==canonicalJourneyJSON({devices:raw.devices,currentEvents:raw.currentEvents}))return null;
 const expected=history.flatMap(h=>h.content.payload.documentIds.map(documentId=>({entryId:h.id,documentId,witnessed:'savedVersion' in h.content})));
 if(expected.length!==raw.sourceMatches.length)return null;
 const sourceMatches:RetentionLedgerRead['sourceMatches']=[];
 for(let i=0;i<expected.length;i++){const s=raw.sourceMatches[i],e=expected[i];if(!retentionRecord(s)||!retentionKeys(s,['entryId','documentId','identityMatch'])||s.entryId!==e.entryId||s.documentId!==e.documentId||(e.witnessed?typeof s.identityMatch!=='boolean':s.identityMatch!==null))return null;sourceMatches.push({entryId:e.entryId,documentId:e.documentId,identityMatch:s.identityMatch as boolean|null});}
 return {ok:true,scope,actorId:raw.actorId,writable:raw.writable,headId:history[0]?.id??null,history,...projection.value,sourceMatches};
 }catch{return null;}
}
export async function verifyRetentionReceipt(raw:unknown,binding:{scope:JourneyScope;actorId:number},command:RetentionPersistenceCommand,status:number):Promise<RetentionRevision>{
 const checked=readRetentionPersistenceCommand(command);
 if(!checked.ok||canonicalJourneyJSON(checked.value)!==canonicalJourneyJSON(command)||!retentionRecord(raw)||!retentionKeys(raw,['ok','actorId','scope','replayed','revision','entryId','commandId','requestFingerprint'])||raw.ok!==true||!journeyId(binding.actorId)||raw.actorId!==binding.actorId||!retentionScopeMatches(raw.scope,binding.scope)||typeof raw.replayed!=='boolean'||status!==(raw.replayed?200:201)||raw.commandId!==command.clientRequestId||raw.requestFingerprint!==await retentionHash(command))throw Error('invalid_retention_receipt');
 const revision=await readRetentionRevision(raw.revision,binding.scope);
 const expected={arch:command.arch,supersedesEntryId:command.supersedesEntryId,archCorrectionReason:command.archCorrectionReason,payload:command.content,savedVersion:2,documentWitnesses:command.expectedDocuments};
 if(!revision||raw.entryId!==revision.id||revision.id===revision.predecessorId||(command.expectedHeadId===null?revision.version!==1:revision.version<2)||revision.predecessorId!==command.expectedHeadId||revision.reason!==command.reason||canonicalJourneyJSON(revision.content)!==canonicalJourneyJSON(expected))throw Error('invalid_retention_receipt');
 return revision;
}
export interface RetentionDocumentChoices {ok:true;scope:JourneyScope;actorId:number;items:{witness:RetentionDocumentWitness;title:string;mimeType:string}[];nextCursor:number|null}
export function verifyRetentionDocumentChoices(raw:unknown,binding:{scope:JourneyScope;actorId:number},afterId?:number):RetentionDocumentChoices{
 if(afterId!==undefined&&!journeyId(afterId)||!retentionRecord(raw)||!retentionKeys(raw,['ok','scope','actorId','items','nextCursor'])||raw.ok!==true||!journeyId(binding.actorId)||raw.actorId!==binding.actorId||!retentionScopeMatches(raw.scope,binding.scope)||!dense(raw.items,50))throw Error('invalid_retention_documents');
 const items:RetentionDocumentChoices['items']=[];let previous=afterId??0;
 for(const item of raw.items){if(!retentionRecord(item)||!retentionKeys(item,['witness','title','mimeType'])||!retentionRecord(item.witness)||!journeyId(item.witness.id)||item.witness.id<=previous||typeof item.title!=='string'||item.title.length>65536||!text(item.mimeType,65536))throw Error('invalid_retention_documents');const w=readRetentionDocumentWitnesses([item.witness],[item.witness.id]);if(!w.ok||w.value[0].patientId!==binding.scope.patientId||w.value[0].orthoCaseId!==binding.scope.orthoCaseId)throw Error('invalid_retention_documents');items.push({witness:w.value[0],title:item.title,mimeType:item.mimeType});previous=item.witness.id;}
 if(raw.nextCursor!==null&&(items.length!==50||raw.nextCursor!==previous))throw Error('invalid_retention_documents');
 return {ok:true,scope:binding.scope,actorId:binding.actorId,items,nextCursor:raw.nextCursor as number|null};
}
