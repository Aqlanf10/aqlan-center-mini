import { admitJourney, journeyRouteOwner, journeyRouteError, routeId, type JourneyRouteContext } from '@/lib/ortho-journey-route';
import { orthoQuery, orthoResult, orthoRouteFailure } from '@/lib/ortho-route-handler';
import { readJsonBody } from '@/lib/http-body';
import { isReopenRequestId } from '@/lib/ortho-reopen-contract';
import { readOrthoReopen, reopenOrthoCase } from '@/lib/ortho-reopen-store';
import { journeyId } from '@/lib/ortho-case-journey-records';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: JourneyRouteContext) {
  try {
    const admission = await admitJourney(true); if (!admission.ok) return admission.response;
    const query = orthoQuery(request, ['patientId', 'requestId', 'after']);
    const patientId = routeId(query?.get('patientId'));
    const after = query?.has('after') ? routeId(query.get('after')) : undefined;
    const requestId = query?.has('requestId') ? query.get('requestId') : undefined;
    if (!query || !patientId || after === null || requestId !== undefined && !isReopenRequestId(requestId)) return journeyRouteError(400, 'invalid_reopen_query');
    const owner = await journeyRouteOwner(context, patientId, admission.session); if (!owner.ok) return owner.response;
    return orthoResult(await readOrthoReopen({ ...owner, after, requestId }));
  } catch (error) { return orthoRouteFailure(error, false); }
}
export async function POST(request: Request, context: JourneyRouteContext) {
  try {
    const admission = await admitJourney(true); if (!admission.ok) return admission.response;
    if (!orthoQuery(request, [])) return journeyRouteError(400, 'invalid_query');
    const raw = await readJsonBody(request, 8192);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return journeyRouteError(400, 'invalid_reopen_command');
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).sort().join(',') !== 'clinicalCaseId,command,patientId'
      || !journeyId(body.patientId) || !journeyId(body.clinicalCaseId)) return journeyRouteError(400, 'invalid_scope');
    const owner = await journeyRouteOwner(context, body.patientId, admission.session); if (!owner.ok) return owner.response;
    const result = await reopenOrthoCase({ ...owner, clinicalCaseId: body.clinicalCaseId, command: body.command });
    return orthoResult(result, result.ok && !result.replayed);
  } catch (error) { return orthoRouteFailure(error, true); }
}
