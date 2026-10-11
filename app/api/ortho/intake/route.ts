import { admitJourney, journeyRouteError, routeId } from "@/lib/ortho-journey-route";
import { readJsonBody } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { orthoQuery, orthoResult, orthoRouteFailure } from "@/lib/ortho-route-handler";
import { readOrthoLifecycle, recordOrthoLifecycle } from "@/lib/ortho-assessment-lifecycle-store";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const admission = await admitJourney(false); if (!admission.ok) return admission.response;
    const query = orthoQuery(request, ["patientId", "orthoCaseId"]), patientId = routeId(query?.get("patientId"));
    const orthoCaseId = query?.has("orthoCaseId") ? routeId(query.get("orthoCaseId")) : undefined;
    if (!query || !patientId || orthoCaseId === null) return journeyRouteError(400, "invalid_scope");
    return orthoResult(await readOrthoLifecycle({ session: admission.session, patientId, orthoCaseId }));
  } catch (error) { return orthoRouteFailure(error, false); }
}
export async function POST(request: Request) {
  try {
    const admission = await admitJourney(true); if (!admission.ok) return admission.response;
    const query = orthoQuery(request, ["patientId"]), patientId = routeId(query?.get("patientId"));
    if (!query || !patientId) return journeyRouteError(400, "invalid_scope");
    const command = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    return orthoResult(await recordOrthoLifecycle({ session: admission.session, patientId, command }), true);
  } catch (error) { return orthoRouteFailure(error, true); }
}
