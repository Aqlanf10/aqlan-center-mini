import { NextResponse } from "next/server";
import { admitJourney, journeyRouteOwner, journeyRouteError, routeId, type JourneyRouteContext } from "@/lib/ortho-journey-route";
import { orthoQuery, orthoResult, orthoRouteFailure } from "@/lib/ortho-route-handler";
import { getStudyImageBasis, getStudyImagePreview } from "@/lib/ortho-study-image-store";
import { readStudyImageCommand } from "@/lib/ortho-study-image-contract";
import { readJsonBody } from "@/lib/http-body";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: JourneyRouteContext) {
  try {
    const admission = await admitJourney(false); if (!admission.ok) return admission.response;
    const query = orthoQuery(request,['patientId','documentId','sha256']);
    const patientId = routeId(query?.get('patientId')), documentId = routeId(query?.get('documentId')), sha256 = query?.get('sha256');
    if (!query || !patientId || !documentId || !sha256 || !/^[a-f0-9]{64}$/.test(sha256)) return journeyRouteError(400,'invalid_scope');
    const owner = await journeyRouteOwner(context,patientId,admission.session); if (!owner.ok) return owner.response;
    return orthoResult(await getStudyImageBasis({...owner,documentId,sha256}));
  } catch (error) { return orthoRouteFailure(error,false); }
}
/** Read-only raster derivation. The POST contains a bounded display recipe,
 * never patient/file writes; the normal staff CSRF admission still applies. */
export async function POST(request: Request, context: JourneyRouteContext) {
  try {
    const admission = await admitJourney(false); if (!admission.ok) return admission.response;
    if (!orthoQuery(request,[])) return journeyRouteError(400,'invalid_query');
    const command = readStudyImageCommand(await readJsonBody(request,16*1024));
    if (!command) return journeyRouteError(400,'invalid_image_preview');
    const owner = await journeyRouteOwner(context,command.patientId,admission.session); if (!owner.ok) return owner.response;
    const result = await getStudyImagePreview({...owner,command}); if (!result.ok) return orthoResult(result);
    return new NextResponse(new Uint8Array(result.png), { headers: {
      'Content-Type':'image/png','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'inline',
      'X-Study-Patient':String(result.patientId),'X-Study-Case':String(result.orthoCaseId),'X-Study-Clinical-Case':String(result.clinicalCaseId),
      'X-Study-Document':String(result.documentId),'X-Study-Use':result.useId,'X-Study-Purpose':result.purpose,
      'X-Study-Source-SHA256':result.sourceSha256,'X-Study-Recipe-SHA256':result.recipeSha256,'X-Study-Geometry-SHA256':result.geometrySha256,
      'X-Study-Rendition-SHA256':result.renditionSha256,'X-Study-Processor':result.processorVersion,
      'X-Study-Width':String(result.width),'X-Study-Height':String(result.height),
    } });
  } catch (error) { return orthoRouteFailure(error,false); }
}
