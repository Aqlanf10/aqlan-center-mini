import { parseStudySubmissionBody } from '@/lib/ortho-study-submission-contract';
import { admitJourney, journeyRouteOwner, journeyRouteError, routeId, type JourneyRouteContext } from "@/lib/ortho-journey-route";
import { readJsonBody } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { orthoQuery, orthoResult, orthoRouteFailure } from "@/lib/ortho-route-handler";
import { getOrthoCaseStudy, saveOrthoCaseStudy } from "@/lib/ortho-case-study-store";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: JourneyRouteContext) {
  try {
    const admission = await admitJourney(false); if (!admission.ok) return admission.response;
    const query = orthoQuery(request, ["patientId", "revisionId"]);
    const patientId = routeId(query?.get("patientId"));
    const revisionId = query?.has("revisionId") ? routeId(query.get("revisionId")) : undefined;
    if (!query || !patientId || revisionId === null) return journeyRouteError(400, "invalid_scope");
    const owner = await journeyRouteOwner(context, patientId, admission.session); if (!owner.ok) return owner.response;
    return orthoResult(await getOrthoCaseStudy({ ...owner, revisionId }));
  } catch (error) { return orthoRouteFailure(error, false); }
}
export async function POST(request: Request, context: JourneyRouteContext) {
  try {
    const admission = await admitJourney(true); if (!admission.ok) return admission.response;
    if (!orthoQuery(request, [])) return journeyRouteError(400, "invalid_query");
    const body = parseStudySubmissionBody(await readJsonBody(request, JSON_BODY_LIMIT_BYTES));
    if (!body) return journeyRouteError(400, "invalid_command");
    const owner = await journeyRouteOwner(context, body.patientId, admission.session); if (!owner.ok) return owner.response;
    return orthoResult(await saveOrthoCaseStudy({ ...owner, clinicalCaseId: body.clinicalCaseId, actorId: body.actorId, command: body.command }), true);
  } catch (error) { return orthoRouteFailure(error, true); }
}
