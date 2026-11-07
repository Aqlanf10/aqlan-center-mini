/** Dedicated bounded immutable space history. No generic journey writer extension. */
import { insertAuditRow, type DbClient } from './db';
import { decodeJourneyRow, type JourneyRow, type JourneyRevision } from './ortho-case-journey-history';
import { journeyContentHash, canonicalJourneyJSON } from './ortho-case-journey-hash';
import { journeyFail, assertJourneyCurrent, type JourneyOwner, type JourneyAuthority } from './ortho-case-journey-authority';
import type { SpacePersistenceCommand } from './ortho-space-command';
import {PURCHASE_RESET_FENCE} from './clinic-reset';
import { projectIpr } from './ortho-space-ledger';
import { readSpaceSavedContent, type SpaceSavedContent } from './ortho-space-saved';
export async function lockSpaceHistoryTables(client:DbClient){
 await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))',[PURCHASE_RESET_FENCE]);
 await client.query('LOCK TABLE ortho_space_entries IN ROW EXCLUSIVE MODE');
 await client.query('LOCK TABLE ortho_space_submissions IN ROW EXCLUSIVE MODE');
}
export type SpaceRevision=JourneyRevision<SpaceSavedContent>;
export async function spaceHistory(client:DbClient,owner:JourneyOwner,throughVersion?:number){
 if(throughVersion!==undefined&&(!Number.isSafeInteger(throughVersion)||throughVersion<1))journeyFail(400,'invalid_space_prefix');
 const filter=throughVersion===undefined?'':' AND version<=$2',args=throughVersion===undefined?[owner.orthoCaseId]:[owner.orthoCaseId,throughVersion];
 const {rows:[size]}=await client.query<{n:string;bytes:string}>(`SELECT COUNT(*)::text n,COALESCE(SUM(octet_length(content::text)),0)::text bytes FROM ortho_space_entries WHERE ortho_case_id=$1${filter}`,args);
 if(!size||!/^\d+$/.test(size.n)||!/^\d+$/.test(size.bytes))journeyFail(500,'space_history_size');
 if(BigInt(size.n)>1000n||BigInt(size.bytes)>4194304n)journeyFail(409,'space_history_budget');
 const {rows}=await client.query<JourneyRow>(`SELECT * FROM ortho_space_entries WHERE ortho_case_id=$1${filter} ORDER BY version DESC`,args);
 const revisions=rows.map(row=>decodeJourneyRow(row,owner,readSpaceSavedContent));
 for(const [i,r] of revisions.entries()){
  const next=revisions[i+1],row=rows[i],c=r.content.authored;
  const original={schemaVersion:1,clientRequestId:row.command_id,expectedHeadId:r.predecessorId,reason:r.reason,content:c};
  const witnessed=c.kind==='ipr'?{...original,schemaVersion:2,expectedSession:r.content.adjustment}:null;
  if(journeyContentHash(original)!==row.request_fingerprint&&(!witnessed||journeyContentHash(witnessed)!==row.request_fingerprint))journeyFail(500,'space_saved_command_fingerprint');
  if(r.recordedPatientId!==owner.patientId||r.version!==(next?.version??0)+1||r.predecessorId!==(next?.id??null))journeyFail(500,'space_saved_lineage');
  if(row.entry_kind!==c.kind||row.arch!==c.arch||row.strategy_revision_id!==(c.kind==='plan'?c.strategyRevisionId:null)
   ||row.assessment_revision_id!==(c.kind==='plan'?c.baseline.id:null)||row.plan_entry_id!==(c.kind==='ipr'?c.planEntryId:null)
   ||row.adjustment_id!==(c.kind==='ipr'?c.adjustmentId:null)||row.supersedes_entry_id!==(c.kind==='ipr'?c.supersedesEntryId:null))journeyFail(500,'space_saved_columns');
 }
 const events=revisions.map(r=>({id:r.id,version:r.version,content:r.content.authored}));
 const projection=projectIpr(events);if(!projection.ok)journeyFail(500,projection.code);
 return {rows,revisions,events,projection:projection.value};
}
export async function insertSpaceEntry(client:DbClient,owner:JourneyOwner,authority:JourneyAuthority,head:SpaceRevision|null,command:SpacePersistenceCommand,content:SpaceSavedContent){
 if(command.expectedHeadId!==(head?.id??null))journeyFail(409,'head_changed');
 const c=content.authored,serialized=canonicalJourneyJSON(content);
 const {rows:[size]}=await client.query<{n:string;bytes:string}>('SELECT COUNT(*)::text n,(COALESCE(SUM(octet_length(content::text)),0)+octet_length($2::jsonb::text))::text bytes FROM ortho_space_entries WHERE ortho_case_id=$1',[owner.orthoCaseId,serialized]);
 if(BigInt(size.n)>=1000n||BigInt(size.bytes)>4194304n)journeyFail(409,'space_history_budget');
 assertJourneyCurrent(authority);
 const {rows:[row]}=await client.query<JourneyRow>(`INSERT INTO ortho_space_entries
 (patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,version,predecessor_id,actor_user_id,created_by,reason,recording_context,case_status_at_capture,command_id,request_fingerprint,content_sha256,content,
 arch,entry_kind,strategy_revision_id,assessment_revision_id,plan_entry_id,adjustment_id,supersedes_entry_id)
 VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
 [owner.patientId,owner.orthoCaseId,owner.clinicalCaseId,(head?.version??0)+1,head?.id??null,authority.userId,authority.name,command.reason,owner.recordingContext,owner.status,command.clientRequestId,journeyContentHash(command),journeyContentHash(content),serialized,c.arch,c.kind,
 c.kind==='plan'?c.strategyRevisionId:null,c.kind==='plan'?c.baseline.id:null,c.kind==='ipr'?c.planEntryId:null,c.kind==='ipr'?c.adjustmentId:null,c.kind==='ipr'?c.supersedesEntryId:null]);
 const revision=decodeJourneyRow(row,owner,readSpaceSavedContent);
 await insertAuditRow(client,{action:'ortho.journey_record',entity:'ortho_space_entries',entityId:revision.id,actor:authority.name,actorRole:authority.session.role,details:{patientId:owner.patientId,orthoCaseId:owner.orthoCaseId,version:revision.version,contentHash:revision.contentHash}});
 return revision;
}
