import { admitJourney, journeyRouteOwner, journeyRouteError, routeId, parseJourneyBody, type JourneyRouteContext } from '@/lib/ortho-journey-route';
import { readJsonBody } from '@/lib/http-body';
import { orthoQuery, orthoResult, orthoRouteFailure } from '@/lib/ortho-route-handler';
import { listStudyExports, reserveStudyExport } from '@/lib/ortho-study-export-archive-store';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: JourneyRouteContext) {
  try {
    const admission = await admitJourney(false); if (!admission.ok) return admission.response;
    const query = orthoQuery(request, ['patientId', 'revisionId', 'after']);
    const patientId = routeId(query?.get('patientId')), revisionId = routeId(query?.get('revisionId'));
    const after = query?.has('after') ? routeId(query.get('after')) : undefined;
    if (!query || !patientId || !revisionId || after === null) return journeyRouteError(400, 'invalid_scope');
    const owner = await journeyRouteOwner(context, patientId, admission.session); if (!owner.ok) return owner.response;
    return orthoResult(await listStudyExports({ ...owner, revisionId, after }));
  } catch (error) { return orthoRouteFailure(error, false); }
}
export async function POST(request: Request, context: JourneyRouteContext) {
  try {
    // Export is an independent grant; it does not confer clinical-write access.
    const admission = await admitJourney(false); if (!admission.ok) return admission.response;
    if (!orthoQuery(request, [])) return journeyRouteError(400, 'invalid_query');
    const body = parseJourneyBody(await readJsonBody(request, 4096));
    if (!body) return journeyRouteError(400, 'invalid_command');
    const owner = await journeyRouteOwner(context, body.patientId, admission.session); if (!owner.ok) return owner.response;
    return orthoResult(await reserveStudyExport({ ...owner, command: body.command }), true);
  } catch (error) { return orthoRouteFailure(error, true); }
}
