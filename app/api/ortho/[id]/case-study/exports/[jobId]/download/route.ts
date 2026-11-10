import { NextResponse } from 'next/server';
import { admitJourney, journeyRouteOwner, journeyRouteError, routeId } from '@/lib/ortho-journey-route';
import { orthoQuery, orthoRouteFailure } from '@/lib/ortho-route-handler';
import { readStudyExportArtifact } from '@/lib/ortho-study-export-archive-store';
import { readStudyExportArtifactBytes } from '@/lib/ortho-study-export-artifact-storage';
import { recordAudit } from '@/lib/db';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string; jobId: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const admission = await admitJourney(false); if (!admission.ok) return admission.response;
    const query = orthoQuery(request, ['patientId']);
    const patientId = routeId(query?.get('patientId')), jobId = routeId((await context.params).jobId);
    if (!query || !patientId || !jobId) return journeyRouteError(400, 'invalid_scope');
    const owner = await journeyRouteOwner(context, patientId, admission.session); if (!owner.ok) return owner.response;
    const archived = await readStudyExportArtifact({ ...owner, jobId });
    if (!archived.ok) return journeyRouteError(archived.status, archived.code);
    let bytes: Uint8Array;
    try { bytes = await readStudyExportArtifactBytes(archived.reference); }
    catch { return journeyRouteError(409, 'study_export_file_unavailable', 'تعذر التحقق من الملف المحفوظ. لم يُرسل ملف ناقص؛ راجع التخزين الخاص بالعيادة.'); }
    await recordAudit({ actor: admission.session.username, action: 'ortho.study_export',
      entity: 'ortho_study_export_jobs', entityId: jobId, details: { event: 'download_prepared', sha256: archived.reference.sha256 } });
    // Recheck live authority after storage and audit awaits. The immutable bytes
    // are never served by a public path or inferred from a receipt alone.
    const fresh = await readStudyExportArtifact({ ...owner, jobId });
    if (!fresh.ok) return journeyRouteError(fresh.status, fresh.code);
    if (fresh.reference.sha256 !== archived.reference.sha256 || fresh.reference.sizeBytes !== bytes.byteLength
      || fresh.reference.storageKey !== archived.reference.storageKey) return journeyRouteError(409, 'study_export_changed');
    return new NextResponse(new Uint8Array(bytes), { headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': `attachment; filename="ortho-${owner.orthoCaseId}-study-${fresh.job.revisionId}-export-${jobId}.pptx"`,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    } });
  } catch (error) { return orthoRouteFailure(error, false); }
}
