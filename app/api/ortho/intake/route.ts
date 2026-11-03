import { admitJourney, parseJourneyBody, journeyRouteError, journeyResponse } from "@/lib/ortho-journey-route";
import { orthoQuery, orthoResult, orthoRouteFailure } from "@/lib/ortho-route-handler";
import { readJsonBody } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { openOrthoAssessment } from "@/lib/ortho-assessment-intake-store";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
    try {
        const admission = await admitJourney(true);
        if (!admission.ok)
            return admission.response;
        if (!orthoQuery(request, []))
            return journeyRouteError(400, "invalid_query");
        const body = parseJourneyBody(await readJsonBody(request, JSON_BODY_LIMIT_BYTES));
        if (!body)
            return journeyRouteError(400, "invalid_command");
        const result = await openOrthoAssessment({ ...body, session: admission.session });
        return result.ok ? journeyResponse(result, result.mode === "created" ? 201 : 200) : orthoResult(result);
    }
    catch (error) {
        return orthoRouteFailure(error, true);
    }
}
