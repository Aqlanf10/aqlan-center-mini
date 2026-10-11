import { admitJourney, journeyRouteOwner, journeyRouteError, routeId, type JourneyRouteContext } from "@/lib/ortho-journey-route";
import { orthoQuery, orthoResult, orthoRouteFailure } from "@/lib/ortho-route-handler";
import { getOrthoStudySourceChoices } from "@/lib/ortho-case-study-inventory";
import { STUDY_SOURCE_KINDS, type StudySourceKind } from "@/lib/ortho-case-study";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: JourneyRouteContext) {
  try {
    const admission = await admitJourney(false); if (!admission.ok) return admission.response;
    const query = orthoQuery(request, ["patientId", "kind", "afterId"]), patientId = routeId(query?.get("patientId"));
    const kind = query?.get("kind"), afterId = query?.has("afterId") ? routeId(query.get("afterId")) : undefined;
    if (!query || !patientId || !STUDY_SOURCE_KINDS.includes(kind as StudySourceKind) || afterId === null) return journeyRouteError(400, "invalid_query");
    const owner = await journeyRouteOwner(context, patientId, admission.session); if (!owner.ok) return owner.response;
    return orthoResult(await getOrthoStudySourceChoices({ ...owner, kind: kind as StudySourceKind, afterId }));
  } catch (error) { return orthoRouteFailure(error, false); }
}
