import type {SessionPayload} from './auth';
import {CLINIC_TIME_ZONE} from './db';
import {clinicDateString} from './schedule';
import {readAuthorizedOrthoFollowupBoard,OrthoFollowupAuthorityError} from './ortho-followup-authority';
import {isFollowupWorklistBucket,OrthoFollowupWorklistError,projectOrthoFollowupWorklist,type OrthoFollowupWorklist} from './ortho-followup-worklist-contract';
export {OrthoFollowupWorklistError} from './ortho-followup-worklist-contract';
export type {OrthoFollowupWorklist,OrthoFollowupWorklistRow} from './ortho-followup-worklist-contract';
/** Fresh server clock only. Never accepts client rows, patient IDs or as-of time. */
export async function prepareOrthoFollowupWorklist(session:SessionPayload,bucket:unknown):Promise<OrthoFollowupWorklist>{
 if(!isFollowupWorklistBucket(bucket))throw new OrthoFollowupWorklistError(400,'invalid_worklist_bucket');
 const asOf=new Date(),today=clinicDateString(asOf,CLINIC_TIME_ZONE);
 const board=await readAuthorizedOrthoFollowupBoard(session,today,asOf,{worklistBucket:bucket});
 if(session.expiresAt<Date.now())throw new OrthoFollowupAuthorityError(401,'انتهت الجلسة.');
 return projectOrthoFollowupWorklist(board,{bucket,today,asOf,timeZone:CLINIC_TIME_ZONE,actorId:session.userId});
}
