import {admitJourney,journeyRouteOwner,journeyRouteError,routeId,type JourneyRouteContext} from '@/lib/ortho-journey-route';
import {orthoQuery,orthoResult,orthoRouteFailure} from '@/lib/ortho-route-handler';
import {getRetentionDocumentChoices} from '@/lib/ortho-retention-event-store';
export const dynamic='force-dynamic';
export async function GET(request:Request,context:JourneyRouteContext){
 try{const admission=await admitJourney(false);if(!admission.ok)return admission.response;
  const query=orthoQuery(request,['patientId','afterId']),patientId=routeId(query?.get('patientId'));
  const afterId=query?.has('afterId')?routeId(query.get('afterId')):undefined;
  if(!query||!patientId||afterId===null)return journeyRouteError(400,'invalid_scope');
  const owner=await journeyRouteOwner(context,patientId,admission.session);if(!owner.ok)return owner.response;
  return orthoResult(await getRetentionDocumentChoices({...owner,...(afterId===undefined?{}:{afterId})}));
 }catch(error){return orthoRouteFailure(error,false);}
}
