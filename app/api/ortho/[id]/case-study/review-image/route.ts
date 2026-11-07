import {NextResponse} from 'next/server';
import {admitJourney,journeyRouteOwner,journeyRouteError,routeId,type JourneyRouteContext} from '@/lib/ortho-journey-route';
import {orthoQuery,orthoResult,orthoRouteFailure} from '@/lib/ortho-route-handler';
import {getSavedStudyPanelImage} from '@/lib/ortho-study-illustrated-store';
export const dynamic='force-dynamic';
export async function GET(request:Request,context:JourneyRouteContext){
 try{
  const admission=await admitJourney(false);if(!admission.ok)return admission.response;
  const q=orthoQuery(request,['patientId','clinicalCaseId','revisionId','revisionHash','panelId','useId','slot']);
  const patientId=routeId(q?.get('patientId')),clinicalCaseId=routeId(q?.get('clinicalCaseId')),revisionId=routeId(q?.get('revisionId')),revisionHash=q?.get('revisionHash'),panelId=q?.get('panelId'),useId=q?.get('useId'),slot=q?.get('slot');
  if(!q||!patientId||!clinicalCaseId||!revisionId||!revisionHash||!/^[a-f0-9]{64}$/.test(revisionHash)||!panelId||!useId||!slot||![panelId,useId,slot].every(v=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v)))return journeyRouteError(400,'invalid_saved_image_scope');
  const owner=await journeyRouteOwner(context,patientId,admission.session);if(!owner.ok)return owner.response;
  const r=await getSavedStudyPanelImage({...owner,clinicalCaseId,revisionId,revisionHash,panelId,useId,slot});if(!r.ok)return orthoResult(r);
  return new NextResponse(new Uint8Array(r.png),{headers:{'Content-Type':'image/png','Cache-Control':'private, no-store','Content-Disposition':'inline','X-Content-Type-Options':'nosniff',
   'X-Study-Patient':String(r.patientId),'X-Study-Case':String(r.orthoCaseId),'X-Study-Clinical-Case':String(r.clinicalCaseId),'X-Study-Actor':String(r.actorId),
   'X-Study-Revision':String(r.revisionId),'X-Study-Revision-SHA256':r.revisionHash,'X-Study-Panel':r.panelId,'X-Study-Slot':r.slot,
   'X-Study-Document':String(r.documentId),'X-Study-Use':r.useId,'X-Study-Purpose':r.purpose,'X-Study-Source-SHA256':r.sourceSha256,
   'X-Study-Recipe-SHA256':r.recipeSha256,'X-Study-Geometry-SHA256':r.geometrySha256,'X-Study-Rendition-SHA256':r.renditionSha256,'X-Study-Processor':r.processorVersion,'X-Study-Width':String(r.width),'X-Study-Height':String(r.height)}});
 }catch(error){return orthoRouteFailure(error,false);}
}
