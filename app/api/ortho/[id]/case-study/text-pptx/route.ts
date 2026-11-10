import { NextResponse } from "next/server";
import { admitJourney, journeyRouteOwner, journeyRouteError, routeId, type JourneyRouteContext } from "@/lib/ortho-journey-route";
import { getOrthoCaseStudy } from "@/lib/ortho-case-study-store";
import { studyTextPresentation } from "@/lib/ortho-study-text-export";
import { renderStudyTextPptx } from "@/lib/ortho-study-pptx";
import { orthoQuery } from "@/lib/ortho-route-handler";
import { recordAudit } from "@/lib/db";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: JourneyRouteContext) {
  const admission = await admitJourney(false); if (!admission.ok) return admission.response;
  const query = orthoQuery(request, ["patientId", "revisionId"]);
  const patientId = routeId(query?.get("patientId")), revisionId = routeId(query?.get("revisionId"));
  if (!query || !patientId || !revisionId) return journeyRouteError(400, "invalid_scope");
  const owner = await journeyRouteOwner(context, patientId, admission.session); if (!owner.ok) return owner.response;
  try {
    const result = await getOrthoCaseStudy({ ...owner, revisionId, exportAccess: true });
    if (!result.ok) return journeyRouteError(result.status, result.code);
    if (!result.revision) return journeyRouteError(404, "study_revision_not_found");
    const value = studyTextPresentation(result.revision, result);
    const bytes = await renderStudyTextPptx(value);
    await recordAudit({ actor: admission.session.username, action: "ortho.study_text_export", entity: "ortho_case_study_revisions", entityId: revisionId,
      details: { format: "pptx-text", revisionHash: value.revisionHash, pages: value.pages.length } });
    // Preparation/audit is not a download receipt. Recheck after all awaited work.
    const fresh = await getOrthoCaseStudy({ ...owner, revisionId, exportAccess: true });
    if (!fresh.ok) return journeyRouteError(fresh.status, fresh.code);
    if (fresh.revision?.contentHash !== value.revisionHash) return journeyRouteError(409, "study_changed");
    return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "Content-Disposition": `attachment; filename="ortho-${owner.orthoCaseId}-revision-${value.version}-text.pptx"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch { return journeyRouteError(409, "study_text_export_unavailable", "تعذّر إخراج النسخة النصية؛ لم يُصدر ملف ناقص. راجع النسخة المحفوظة وحجمها."); }
}
