import { admitJourney, journeyRouteOwner, journeyRouteError, routeId, type JourneyRouteContext } from "@/lib/ortho-journey-route";
import { orthoQuery, orthoResult, orthoRouteFailure } from "@/lib/ortho-route-handler";
import { getOrthoStudyPanelReview } from "@/lib/ortho-case-study-review-store";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: JourneyRouteContext) {
  try {
    const admission = await admitJourney(false); if (!admission.ok) return admission.response;
    const query = orthoQuery(request, ["patientId", "revisionId", "panelId"]), patientId = routeId(query?.get("patientId"));
    const revisionId = routeId(query?.get("revisionId")), panelId = query?.get("panelId");
    if (!query || !patientId || !revisionId || !panelId || !/^[A-Za-z0-9_-]{1,80}$/.test(panelId)) return journeyRouteError(400, "invalid_query");
    const owner = await journeyRouteOwner(context, patientId, admission.session); if (!owner.ok) return owner.response;
    return orthoResult(await getOrthoStudyPanelReview({ ...owner, revisionId, panelId }));
  } catch (error) { return orthoRouteFailure(error, false); }
}
