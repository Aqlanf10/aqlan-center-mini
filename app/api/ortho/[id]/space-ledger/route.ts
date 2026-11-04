import { admitJourney, journeyRouteOwner, journeyRouteError, parseJourneyBody, routeId, type JourneyRouteContext } from "@/lib/ortho-journey-route";
import { readJsonBody } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { orthoQuery, orthoResult, orthoRouteFailure } from "@/lib/ortho-route-handler";
import { getOrthoSpaceLedger, appendOrthoSpaceEntry } from "@/lib/ortho-space-store";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: JourneyRouteContext) {
  try {
    const admission = await admitJourney(false); if (!admission.ok) return admission.response;
    const query = orthoQuery(request, ["patientId"]);
    const patientId = routeId(query?.get("patientId"));
    if (!query || !patientId) return journeyRouteError(400, "invalid_scope");
    const owner = await journeyRouteOwner(context, patientId, admission.session); if (!owner.ok) return owner.response;
    return orthoResult(await getOrthoSpaceLedger(owner));
  } catch (error) { return orthoRouteFailure(error, false); }
}
export async function POST(request: Request, context: JourneyRouteContext) {
  try {
    const admission = await admitJourney(true); if (!admission.ok) return admission.response;
    if (!orthoQuery(request, [])) return journeyRouteError(400, "invalid_query");
    const body = parseJourneyBody(await readJsonBody(request, JSON_BODY_LIMIT_BYTES));
    if (!body) return journeyRouteError(400, "invalid_command");
    const owner = await journeyRouteOwner(context, body.patientId, admission.session); if (!owner.ok) return owner.response;
    return orthoResult(await appendOrthoSpaceEntry({ ...owner, command: body.command }), true);
  } catch (error) { return orthoRouteFailure(error, true); }
}
