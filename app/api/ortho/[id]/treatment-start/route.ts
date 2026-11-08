import { requireSession } from "@/lib/session";
import { parseJourneyBody, journeyRouteOwner, journeyRouteError, journeyResponse, type JourneyRouteContext } from "@/lib/ortho-journey-route";
import { orthoQuery, orthoResult, orthoRouteFailure } from "@/lib/ortho-route-handler";
import { readJsonBody } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { startOrthoTreatment } from "@/lib/ortho-assessment-intake-store";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: JourneyRouteContext) {
    try {
        const session = await requireSession();
        if (!session) return journeyRouteError(401, "session_expired");
        if (session.role !== "admin" && session.role !== "doctor") return journeyRouteError(403, "clinical_access_denied");
        if (!orthoQuery(request, []))
            return journeyRouteError(400, "invalid_query");
        const body = parseJourneyBody(await readJsonBody(request, JSON_BODY_LIMIT_BYTES));
        if (!body)
            return journeyRouteError(400, "invalid_command");
        const owner = await journeyRouteOwner(context, body.patientId, session);
        if (!owner.ok)
            return owner.response;
        const result = await startOrthoTreatment({ ...owner, command: body.command });
        return result.ok ? journeyResponse(result, result.mode === "started" ? 201 : 200) : orthoResult(result);
    }
    catch (error) {
        return orthoRouteFailure(error, true);
    }
}
