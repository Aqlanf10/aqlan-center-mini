import {it,expect,vi} from 'vitest';
import type {DbClient} from '../lib/db';
import {requireRetentionCapacity,RETENTION_HISTORY_LIMITS} from '../lib/ortho-retention-persistence-history';
import type {RetentionSavedContent} from '../lib/ortho-retention-history-store';
const content:RetentionSavedContent={arch:'upper',supersedesEntryId:null,archCorrectionReason:null,savedVersion:2,documentWitnesses:[],payload:{kind:'debond',extent:'Synthetic',occurrence:{occurredOn:null,dateProvenance:'unknown',sourceNote:''},note:'',documentIds:[]}};
it('admits exact final capacity and refuses next row or next JSONB octet before reserve/execute',async()=>{
 const query=vi.fn().mockResolvedValue({rows:[{n:'999',bytes:String(RETENTION_HISTORY_LIMITS.contentBytes)}]}),client={query} as unknown as DbClient;
 await expect(requireRetentionCapacity(client,1,content)).resolves.toBeUndefined();
 expect(query.mock.calls[0][0]).toContain('octet_length($2::jsonb::text)');
 query.mockResolvedValue({rows:[{n:'1000',bytes:'1000'}]});await expect(requireRetentionCapacity(client,1,content)).rejects.toMatchObject({status:409,code:'history_limit_exceeded'});
 query.mockResolvedValue({rows:[{n:'999',bytes:String(RETENTION_HISTORY_LIMITS.contentBytes+1)}]});await expect(requireRetentionCapacity(client,1,content)).rejects.toMatchObject({status:409,code:'history_limit_exceeded'});
});
it('refuses an unreadable budget instead of publishing a partial history',async()=>{
 const client={query:vi.fn().mockResolvedValue({rows:[]})} as unknown as DbClient;await expect(requireRetentionCapacity(client,1,content)).rejects.toMatchObject({status:500});
});
it('reads a mixed historic legacy/v2 lineage without upgrading legacy provenance',async()=>{
 const {retentionHistory}=await import('../lib/ortho-retention-persistence-history');
 const {journeyContentHash}=await import('../lib/ortho-case-journey-hash');
 const owner={patientId:1,orthoCaseId:2,clinicalCaseId:3,status:'active' as const,recordingContext:'current' as const,planId:null};
 const legacy={arch:content.arch,supersedesEntryId:null,archCorrectionReason:null,payload:content.payload};
 const rows=[content,legacy].map((saved,index)=>{
  const version=2-index,id=12-index,predecessor=version===1?null:11,commandId=`synthetic_history_${version}`;
  const command={schemaVersion:version===1?1:2,clientRequestId:commandId,expectedHeadId:predecessor,reason:'Synthetic',arch:saved.arch,supersedesEntryId:null,archCorrectionReason:null,content:saved.payload,...(version===1?{}:{expectedDocuments:[]})};
  return {id,patient_id:1,recorded_patient_id:1,ortho_case_id:2,clinical_case_id:3,schema_version:1,version,predecessor_id:predecessor,actor_user_id:1,created_by:'Synthetic',created_at:'2026-10-01T00:00:00.000Z',reason:'Synthetic',recording_context:'current',case_status_at_capture:'active',command_id:commandId,request_fingerprint:journeyContentHash(command),content_sha256:journeyContentHash(saved),content:saved,arch:saved.arch,entry_kind:'debond',supersedes_entry_id:null,device_entry_id:null,replaces_device_id:null,expected_device_revision_id:null};
 });
 const client={query:vi.fn().mockResolvedValueOnce({rows:[{row_count:'2',content_bytes:'1000'}]}).mockResolvedValueOnce({rows})} as unknown as DbClient;
 const history=await retentionHistory(client,owner);expect(history.revisions.map(r=>r.content)).toEqual([content,legacy]);expect('savedVersion' in history.revisions[1].content).toBe(false);
});
