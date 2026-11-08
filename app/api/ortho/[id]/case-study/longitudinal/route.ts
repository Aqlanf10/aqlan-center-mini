import {admitJourney,journeyRouteOwner,journeyRouteError,routeId,type JourneyRouteContext} from '@/lib/ortho-journey-route';
import {orthoQuery,orthoResult,orthoRouteFailure} from '@/lib/ortho-route-handler';
import {getStudyLongitudinalEligibility} from '@/lib/ortho-study-longitudinal-store';
export const dynamic='force-dynamic';
export async function GET(request:Request,context:JourneyRouteContext){
 try{const admission=await admitJourney(false);if(!admission.ok)return admission.response;
  const query=orthoQuery(request,['patientId','revisionId']),patientId=routeId(query?.get('patientId')),revisionId=routeId(query?.get('revisionId'));
  if(!query||!patientId||!revisionId)return journeyRouteError(400,'invalid_query');
  const owner=await journeyRouteOwner(context,patientId,admission.session);if(!owner.ok)return owner.response;
  return orthoResult(await getStudyLongitudinalEligibility({...owner,revisionId}));
 }catch(error){return orthoRouteFailure(error,false);}
}
