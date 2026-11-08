/** Bounded exact retained history and immutable command reconstruction. */
import type { DbClient } from './db';
import { journeyHistory, type JourneyRevision } from './ortho-case-journey-history';
import { journeyContentHash, canonicalJourneyJSON } from './ortho-case-journey-hash';
import { journeyFail, type JourneyOwner } from './ortho-case-journey-authority';
import { decodeRetentionSavedContent, type RetentionSavedContent } from './ortho-retention-history-store';
import { projectRetentionEventHistory } from './ortho-retention-event-history';
import { PURCHASE_RESET_FENCE } from './clinic-reset';
export const RETENTION_HISTORY_LIMITS=Object.freeze({rows:1000,contentBytes:4194304});
export async function requireRetentionCapacity(client:DbClient,caseId:number,content:RetentionSavedContent){
 const {rows:[size]}=await client.query<{n:string;bytes:string}>('SELECT COUNT(*)::text n,(COALESCE(SUM(octet_length(content::text)),0)+octet_length($2::jsonb::text))::text bytes FROM ortho_retention_entries WHERE ortho_case_id=$1',[caseId,canonicalJourneyJSON(content)]);
 if(!size||!/^\d+$/.test(size.n)||!/^\d+$/.test(size.bytes))journeyFail(500,'retention_history_size');
 if(BigInt(size.n)>=BigInt(RETENTION_HISTORY_LIMITS.rows)||BigInt(size.bytes)>BigInt(RETENTION_HISTORY_LIMITS.contentBytes))journeyFail(409,'history_limit_exceeded');
}
export type RetentionRevision=JourneyRevision<RetentionSavedContent>;
export async function lockRetentionHistoryTables(client:DbClient){
 await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))',[PURCHASE_RESET_FENCE]);
 await client.query('LOCK TABLE ortho_retention_entries IN ROW EXCLUSIVE MODE');
 await client.query('LOCK TABLE ortho_retention_submissions IN ROW EXCLUSIVE MODE');
}
export function retentionProjection(revisions:RetentionRevision[]){
 const result=projectRetentionEventHistory(revisions.map(r=>({id:r.id,version:r.version,arch:r.content.arch,supersedesEntryId:r.content.supersedesEntryId,archCorrectionReason:r.content.archCorrectionReason,content:r.content.payload})));
 if(!result.ok)journeyFail(409,result.code);return result.value;
}
export async function retentionHistory(client:DbClient,owner:JourneyOwner){
 const history=await journeyHistory(client,'ortho_retention_entries',owner,decodeRetentionSavedContent,RETENTION_HISTORY_LIMITS);
 for(const [i,r] of history.revisions.entries()){
  const c=r.content,row=history.rows[i];
  const base={schemaVersion:1,clientRequestId:row.command_id,expectedHeadId:r.predecessorId,reason:r.reason,arch:c.arch,supersedesEntryId:c.supersedesEntryId,archCorrectionReason:c.archCorrectionReason,content:c.payload};
  const command='savedVersion' in c?{...base,schemaVersion:2,expectedDocuments:c.documentWitnesses}:base;
  if(r.recordedPatientId!==owner.patientId||journeyContentHash(command)!==row.request_fingerprint)journeyFail(500,'retention_saved_command_fingerprint');
  if('savedVersion' in c&&c.documentWitnesses.some(w=>w.patientId!==owner.patientId||w.orthoCaseId!==owner.orthoCaseId))journeyFail(500,'retention_saved_document_scope');
 }
 return {...history,projection:retentionProjection(history.revisions)};
}
