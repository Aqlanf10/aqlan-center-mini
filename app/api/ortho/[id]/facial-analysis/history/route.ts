import {admitJourney,journeyRouteOwner,journeyRouteError,routeId,type JourneyRouteContext} from '@/lib/ortho-journey-route';
import {orthoQuery,orthoResult,orthoRouteFailure} from '@/lib/ortho-route-handler';
import {getFacialHistoryPage} from '@/lib/ortho-facial-history-store';
export const dynamic='force-dynamic';
export async function GET(request:Request,context:JourneyRouteContext){
 try{
  const admission=await admitJourney(false);if(!admission.ok)return admission.response;
  const q=orthoQuery(request,['patientId','documentId','beforeRevisionId','beforeContentHash']);
  const patientId=routeId(q?.get('patientId')),documentId=routeId(q?.get('documentId')),beforeRevisionId=routeId(q?.get('beforeRevisionId')),beforeContentHash=q?.get('beforeContentHash');
  if(!q||!patientId||!documentId||!beforeRevisionId||!beforeContentHash||!/^[a-f0-9]{64}$/.test(beforeContentHash))return journeyRouteError(400,'invalid_history_cursor');
  const owner=await journeyRouteOwner(context,patientId,admission.session);if(!owner.ok)return owner.response;
  return orthoResult(await getFacialHistoryPage({...owner,documentId,beforeRevisionId,beforeContentHash}));
 }catch(error){return orthoRouteFailure(error,false);}
}
