import { admitJourney, journeyRouteOwner, journeyRouteError, routeId } from '@/lib/ortho-journey-route';
import { readJsonBody } from '@/lib/http-body';
import { orthoQuery, orthoResult, orthoRouteFailure } from '@/lib/ortho-route-handler';
import { runStudyExport } from '@/lib/ortho-study-export-runner';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string; jobId: string }> };
export async function POST(request: Request, context: Context) {
  try {
    const admission = await admitJourney(false); if (!admission.ok) return admission.response;
    if (!orthoQuery(request, [])) return journeyRouteError(400, 'invalid_query');
    const raw = await readJsonBody(request, 1024);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return journeyRouteError(400, 'invalid_command');
    const body = raw as Record<string, unknown>, jobId = routeId((await context.params).jobId);
    if (!jobId || Object.keys(body).sort().join(',') !== 'expectedGeneration,patientId'
      || typeof body.patientId !== 'number' || !Number.isSafeInteger(body.patientId) || body.patientId < 1
      || typeof body.expectedGeneration !== 'number' || !Number.isSafeInteger(body.expectedGeneration) || body.expectedGeneration < 0)
      return journeyRouteError(400, 'invalid_command');
    const owner = await journeyRouteOwner(context, body.patientId, admission.session); if (!owner.ok) return owner.response;
    return orthoResult(await runStudyExport({ ...owner, jobId, expectedGeneration: body.expectedGeneration }));
  } catch (error) { return orthoRouteFailure(error, true); }
}
