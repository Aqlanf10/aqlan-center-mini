import {admitJourney,journeyRouteOwner,journeyRouteError,routeId,type JourneyRouteContext} from '@/lib/ortho-journey-route';
import {orthoQuery,orthoResult,orthoRouteFailure} from '@/lib/ortho-route-handler';
import {getSpaceSubmissionRecovery,transitionSpaceSubmission} from '@/lib/ortho-space-submission-store';
import {journeyId,journeyHash} from '@/lib/ortho-case-journey-records';
import {readJsonBody} from '@/lib/http-body';
export const dynamic='force-dynamic';
export async function GET(request:Request,context:JourneyRouteContext){
 try{const admission=await admitJourney(false);if(!admission.ok)return admission.response;
  const query=orthoQuery(request,['patientId']),patientId=routeId(query?.get('patientId'));if(!query||!patientId)return journeyRouteError(400,'invalid_scope');
  const owner=await journeyRouteOwner(context,patientId,admission.session);if(!owner.ok)return owner.response;
  return orthoResult(await getSpaceSubmissionRecovery(owner));
 }catch(error){return orthoRouteFailure(error,false);}
}
export async function POST(request:Request,context:JourneyRouteContext){
 try{const admission=await admitJourney(true);if(!admission.ok)return admission.response;if(!orthoQuery(request,[]))return journeyRouteError(400,'invalid_query');
  const raw=await readJsonBody(request,4096);
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join('|')!=='action|actorId|clinicalCaseId|commandId|patientId|requestFingerprint')return journeyRouteError(400,'invalid_space_submission_transition');
  const body=raw as {patientId:number;clinicalCaseId:number;actorId:number;commandId:string;requestFingerprint:string;action:'acknowledge'|'cancel'};
  if(!journeyId(body.patientId)||!journeyId(body.clinicalCaseId)||!journeyId(body.actorId)||typeof body.commandId!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(body.commandId)||!journeyHash(body.requestFingerprint)||!['cancel','acknowledge'].includes(body.action))return journeyRouteError(400,'invalid_space_submission_transition');
  const owner=await journeyRouteOwner(context,body.patientId,admission.session);if(!owner.ok)return owner.response;
  return orthoResult(await transitionSpaceSubmission({...owner,...body}));
 }catch(error){return orthoRouteFailure(error,true);}
}
