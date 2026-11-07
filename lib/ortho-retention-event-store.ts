/** Documentary events only. Public writes go through the separately committed journal. */
import type {DbClient} from './db';
import {authorizeJourney,discoverJourneyOwner,lockJourneyOwner,assertJourneyCurrent,journeyTransaction,journeyFail,type JourneyOwnerInput,type JourneyOwner} from './ortho-case-journey-authority';
import {journeyContentHash} from './ortho-case-journey-hash';
import {replayJourney,insertJourneyRevision} from './ortho-case-journey-history';
import {retentionHistory,retentionProjection,lockRetentionHistoryTables,requireRetentionCapacity} from './ortho-retention-persistence-history';
import {decodeRetentionSavedContent,type RetentionSavedContent} from './ortho-retention-history-store';
import type {RetentionPersistenceCommand} from './ortho-retention-command';
import {journeyHash,journeyId} from './ortho-case-journey-records';
import type {RetentionDocumentWitness} from './ortho-retention-document-witness';
interface DocumentRow {id:number;patient_id:number;ortho_case_id:number;sha256:string;title:string;mime_type:string;size_bytes:number;width:number|null;height:number|null}
export const RETENTION_SOURCE_LIMITS=Object.freeze({documents:256,metadataBytes:1048576,documentMetadataBytes:65536});
async function readDocuments(client:DbClient,owner:JourneyOwner,selection:{ids:number[]}|{afterId:number}):Promise<DocumentRow[]>{
 // Lock identity and bounded byte counts first. Never fetch unbounded source text before admission.
 const selected='ids' in selection;
 const {rows:admission}=await client.query<{id:number;bytes:number;valid_hash:boolean}>(`SELECT id,octet_length(coalesce(title,''))+octet_length(mime_type)+octet_length(sha256) AS bytes,sha256 ~ '^[a-f0-9]{64}$' AS valid_hash FROM patient_documents
 WHERE patient_id=$1 AND ortho_case_id=$2 AND removed_at IS NULL AND ${selected?'id=ANY($3::int[])':'id>$3'} ORDER BY id ${selected?'':'LIMIT 51'} FOR SHARE`,[owner.patientId,owner.orthoCaseId,selected?selection.ids:selection.afterId]);
 if(selected&&admission.length!==selection.ids.length)journeyFail(403,'retention_document_unavailable');
 let bytes=0;for(const row of admission){if(!row.valid_hash)journeyFail(409,'retention_document_identity');if(!Number.isSafeInteger(row.bytes)||row.bytes<0||row.bytes>RETENTION_SOURCE_LIMITS.documentMetadataBytes)journeyFail(409,'retention_source_metadata_budget');bytes+=row.bytes;}
 if(bytes>RETENTION_SOURCE_LIMITS.metadataBytes)journeyFail(409,'retention_source_metadata_budget');
 if(!admission.length)return [];
 return (await client.query<DocumentRow>(`SELECT id,patient_id,ortho_case_id,sha256,title,mime_type,size_bytes::float8 AS size_bytes,width,height FROM patient_documents
 WHERE id=ANY($1::int[]) ORDER BY id`,[admission.map(r=>r.id)])).rows;
}
function documentWitness(r:DocumentRow):RetentionDocumentWitness {
 if(!journeyId(r.id)||!journeyHash(r.sha256)||!Number.isSafeInteger(r.size_bytes)||r.size_bytes<0)journeyFail(500,'retention_document_identity');
 return {id:r.id,patientId:r.patient_id,orthoCaseId:r.ortho_case_id,sha256:r.sha256,metadataHash:journeyContentHash({title:r.title,mimeType:r.mime_type,sizeBytes:r.size_bytes,width:r.width,height:r.height})};
}
/** Read-only scoped picker. The cursor is a document ID, never a guessed source URL. */
export async function getRetentionDocumentChoices(input:JourneyOwnerInput&{afterId?:number}){return journeyTransaction(false,async client=>{
 if(input.afterId!==undefined&&!journeyId(input.afterId))journeyFail(400,'invalid_retention_document_cursor');
 const authority=await authorizeJourney(client,input,false);if(!authority.canViewImages)journeyFail(403,'retention_images_restricted');
 const discovered=await discoverJourneyOwner(client,input);
 const rows=await readDocuments(client,discovered,{afterId:input.afterId??0});
 const owner=await lockJourneyOwner(client,input,false);
 if(owner.patientId!==discovered.patientId||owner.clinicalCaseId!==discovered.clinicalCaseId)journeyFail(409,'retention_owner_changed');
 const items=rows.slice(0,50).map(r=>({witness:documentWitness(r),title:r.title,mimeType:r.mime_type}));
 assertJourneyCurrent(authority);return {ok:true as const,actorId:authority.userId,scope:{patientId:owner.patientId,orthoCaseId:owner.orthoCaseId,clinicalCaseId:owner.clinicalCaseId},items,nextCursor:rows.length>50?rows[49].id:null};
});}
async function prepare(client:DbClient,input:JourneyOwnerInput,write:boolean,command?:RetentionPersistenceCommand,historicalOnly=false){
 const authority=await authorizeJourney(client,input,write);
 const discovered=await discoverJourneyOwner(client,input),history=await retentionHistory(client,discovered);
 const ids=[...new Set([...history.revisions.flatMap(r=>r.content.payload.documentIds),...(command?.content.documentIds??[])])].sort((a,b)=>a-b);
 if(ids.length>RETENTION_SOURCE_LIMITS.documents)journeyFail(409,'retention_source_budget');
 if(ids.length&&!authority.canViewImages)journeyFail(403,'retention_images_restricted');
 const rows=ids.length?await readDocuments(client,discovered,{ids}):[];
 const documents=new Map<number,RetentionDocumentWitness>();
 for(const r of rows){
  documents.set(r.id,documentWitness(r));
 }
 const owner=await lockJourneyOwner(client,input,write);
 if(owner.clinicalCaseId!==discovered.clinicalCaseId||owner.patientId!==discovered.patientId||owner.status!==discovered.status)journeyFail(409,'retention_owner_changed');
 // Historical source bytes may evolve, but never substitute them for captured proof.
 const sourceMatches=history.revisions.flatMap(r=>r.content.payload.documentIds.map(id=>({entryId:r.id,documentId:id,
  identityMatch:'savedVersion' in r.content?journeyContentHash(r.content.documentWitnesses.find(w=>w.id===id))===journeyContentHash(documents.get(id)):null})));
 if(command&&!historicalOnly){
  if(owner.status==='assessment')journeyFail(409,'retention_case_not_treatment');
  if(journeyContentHash(command.expectedDocuments)!==journeyContentHash(command.content.documentIds.map(id=>documents.get(id))))journeyFail(409,'retention_document_changed');
 }
 assertJourneyCurrent(authority);return {authority,owner,history,sourceMatches,documents};
}
export async function runRetentionCommand(client:DbClient,input:JourneyOwnerInput,command:RetentionPersistenceCommand,dryRun=false,historicalOnly=false,readOnly=false){
 if(readOnly&&!dryRun)journeyFail(500,'retention_read_only_execution');
 const p=await prepare(client,input,!readOnly,command,historicalOnly),fingerprint=journeyContentHash(command);
 const replay=replayJourney(p.history.rows,p.history.revisions,p.authority,command.clientRequestId,fingerprint);
 const receipt=(revision:typeof p.history.revisions[number],replayed:boolean)=>({ok:true as const,actorId:p.authority.userId,scope:{patientId:p.owner.patientId,orthoCaseId:p.owner.orthoCaseId,clinicalCaseId:p.owner.clinicalCaseId},replayed,revision,entryId:revision.id,commandId:command.clientRequestId,requestFingerprint:fingerprint});
 if(replay)return {receipt:receipt(replay,true)};
 if(historicalOnly)journeyFail(409,'retention_receipt_missing');
 if(command.expectedHeadId!==(p.history.revisions[0]?.id??null))journeyFail(409,'head_changed');
 const content:RetentionSavedContent={arch:command.arch,supersedesEntryId:command.supersedesEntryId,archCorrectionReason:command.archCorrectionReason,payload:command.content,savedVersion:2,documentWitnesses:command.expectedDocuments};
 await requireRetentionCapacity(client,p.owner.orthoCaseId,content);
 const tentativeId=Math.max(0,...p.history.revisions.map(r=>r.id))+1;
 retentionProjection([{id:tentativeId,version:p.history.revisions.length+1,content} as typeof p.history.revisions[number],...p.history.revisions]);
 if(dryRun)return {receipt:null};
 const payload=command.content,device='device' in payload?payload.device:null,replaces=payload.kind==='device_replacement'?payload.replaces:null;
 const revision=await insertJourneyRevision(client,{table:'ortho_retention_entries',owner:p.owner,authority:p.authority,head:p.history.revisions[0]??null,expectedHeadId:command.expectedHeadId,commandId:command.clientRequestId,fingerprint,reason:command.reason,content,
 retention:{arch:command.arch,kind:payload.kind,supersedesEntryId:command.supersedesEntryId,deviceEntryId:device?.deviceId??null,replacesDeviceId:replaces?.deviceId??null,expectedDeviceRevisionId:device?.expectedDeviceRevisionId??replaces?.expectedDeviceRevisionId??null},decode:decodeRetentionSavedContent});
 retentionProjection([revision,...p.history.revisions]);assertJourneyCurrent(p.authority);return {receipt:receipt(revision,false)};
}
export async function getOrthoRetentionEvents(input:JourneyOwnerInput){return journeyTransaction(false,async client=>{
 await lockRetentionHistoryTables(client);const p=await prepare(client,input,false);
 return {ok:true as const,scope:{patientId:p.owner.patientId,orthoCaseId:p.owner.orthoCaseId,clinicalCaseId:p.owner.clinicalCaseId},actorId:p.authority.userId,
 writable:p.authority.canWrite&&p.owner.status!=='assessment',headId:p.history.revisions[0]?.id??null,history:p.history.revisions,...p.history.projection,sourceMatches:p.sourceMatches};
});}
