import type {DbClient} from './db';
import type {SessionPayload} from './auth';
import type {FollowupCase} from './ortho-followup';
import {isRetentionFollowup} from './ortho-followup';
import {canAccessPatient} from './patient-access';
import {discoverJourneyOwner,JourneyFault} from './ortho-case-journey-authority';
import {retentionHistory} from './ortho-retention-persistence-history';
import {readRetentionSourceEvidence} from './ortho-retention-event-store';
import {projectRetentionFollowupContext,RETENTION_FOLLOWUP_CONTEXT_LIMITS} from './ortho-retention-followup-context';

/** Only called AFTER board ownership filtering in its authorized REPEATABLE READ
 * transaction. The same snapshot stabilizes the complete append-only history,
 * case/bridge and source checks. No bootstrap, nested transaction or writes.
 * Expected documentary refusals withhold the entire context, never a subset. */
export async function enrichRetentionFollowupContext<T extends FollowupCase>(client:DbClient,session:SessionPayload,board:T[]):Promise<T[]>{
 let attempted=0;
 const result:T[]=[];
 for(const row of board){
  if(!isRetentionFollowup(row)){result.push(row);continue;}
  const unavailable={...row,retentionContext:{state:'unavailable' as const}};
  if(++attempted>RETENTION_FOLLOWUP_CONTEXT_LIMITS.cases){result.push(unavailable);continue;}
  try{
   if(!await canAccessPatient(session,row.patientId,undefined,client)){result.push(unavailable);continue;}
   const input={session,patientId:row.patientId,orthoCaseId:row.caseId};
   const owner=await discoverJourneyOwner(client,input);
   if(!['active','retention'].includes(owner.status)){result.push(unavailable);continue;}
   const history=await retentionHistory(client,owner);
   const canViewImages=await canAccessPatient(session,row.patientId,'canViewXrays',client);
   const {sourceMatches}=await readRetentionSourceEvidence(client,owner,history.revisions,canViewImages);
   const retentionContext=projectRetentionFollowupContext({ok:true,scope:owner,actorId:session.userId!,writable:false,
    headId:history.revisions[0]?.id??null,history:history.revisions,...history.projection,sourceMatches});
   result.push({...row,retentionContext});
  }catch(error){
   // Database/serialization faults must reach the board's rollback/retry fence.
   if(!(error instanceof JourneyFault)||error.status===401)throw error;
   result.push(unavailable);
  }
 }
 return result;
}
