import { NextResponse } from "next/server";
import { admitJourney, journeyRouteOwner, journeyRouteError, routeId, type JourneyRouteContext } from "@/lib/ortho-journey-route";
import { orthoQuery, orthoResult, orthoRouteFailure } from "@/lib/ortho-route-handler";
import { getFacialImage } from "@/lib/ortho-facial-store";
export const dynamic="force-dynamic";
export async function GET(request:Request,context:JourneyRouteContext){
  try{
    const admission=await admitJourney(false);if(!admission.ok)return admission.response;
    const query=orthoQuery(request,["patientId","documentId","sha256"]),patientId=routeId(query?.get("patientId")),documentId=routeId(query?.get("documentId")),sha256=query?.get("sha256");
    if(!query||!patientId||!documentId||!sha256||!/^[a-f0-9]{64}$/.test(sha256))return journeyRouteError(400,"invalid_scope");
    const owner=await journeyRouteOwner(context,patientId,admission.session);if(!owner.ok)return owner.response;
    const result=await getFacialImage({...owner,documentId,sha256});if(!result.ok)return orthoResult(result);
    return new NextResponse(new Uint8Array(result.png),{headers:{"Content-Type":"image/png","Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Disposition":"inline"}});
  }catch(error){return orthoRouteFailure(error,false);}
}
