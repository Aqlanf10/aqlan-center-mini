import {admitJourney,journeyRouteOwner,journeyRouteError,routeId,type JourneyRouteContext} from '@/lib/ortho-journey-route';
import {orthoQuery,orthoResult,orthoRouteFailure} from '@/lib/ortho-route-handler';
import {getProblemSubmissionRecovery,transitionProblemSubmission} from '@/lib/ortho-problem-submission-store';
import {readJsonBody} from '@/lib/http-body';
export const dynamic='force-dynamic';
export async function GET(request:Request,context:JourneyRouteContext){
 try{const admission=await admitJourney(false);if(!admission.ok)return admission.response;
  const query=orthoQuery(request,['patientId']),patientId=routeId(query?.get('patientId'));if(!query||!patientId)return journeyRouteError(400,'invalid_scope');
  const owner=await journeyRouteOwner(context,patientId,admission.session);if(!owner.ok)return owner.response;
  return orthoResult(await getProblemSubmissionRecovery(owner));
 }catch(error){return orthoRouteFailure(error,false);}
}
export async function POST(request:Request,context:JourneyRouteContext){
 try{const admission=await admitJourney(true);if(!admission.ok)return admission.response;if(!orthoQuery(request,[]))return journeyRouteError(400,'invalid_query');
  const raw=await readJsonBody(request,4096);
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join('|')!=='action|actorId|clinicalCaseId|commandId|patientId|requestFingerprint')return journeyRouteError(400,'invalid_problem_submission_transition');
  const body=raw as {patientId:number;clinicalCaseId:number;actorId:number;commandId:string;requestFingerprint:string;action:'acknowledge'|'cancel'};
  if(typeof body.commandId!=='string'||typeof body.requestFingerprint!=='string'||typeof body.action!=='string')return journeyRouteError(400,'invalid_problem_submission_transition');
  const owner=await journeyRouteOwner(context,body.patientId,admission.session);if(!owner.ok)return owner.response;
  return orthoResult(await transitionProblemSubmission({...owner,...body}));
 }catch(error){return orthoRouteFailure(error,true);}
}
