import { journeyRouteError, routeId, type JourneyRouteContext } from "@/lib/ortho-journey-route";
import { readJsonBody } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { orthoQuery, orthoResult, orthoRouteFailure } from "@/lib/ortho-route-handler";
import { getOrthoAssessment, appendOrthoAssessment } from "@/lib/ortho-assessment-store";
import { ensureSchema, getPool } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";
export const dynamic = "force-dynamic";
async function scope(context: JourneyRouteContext, write: boolean) {
  const session = await requireSession();
  if (!session) return { ok: false as const, response: journeyRouteError(401, "session_expired") };
  if (!["admin", "doctor", "reception"].includes(session.role) || write && session.role === "reception") {
    return { ok: false as const, response: journeyRouteError(403, "clinical_access_denied") };
  }
  const orthoCaseId = routeId((await context.params).id);
  if (!orthoCaseId) return { ok: false as const, response: journeyRouteError(400, "invalid_scope") };
  await ensureSchema();
  const { rows: [row] } = await getPool().query<{ patient_id: number }>("SELECT patient_id FROM ortho_cases WHERE id=$1", [orthoCaseId]);
  if (!row) return { ok: false as const, response: journeyRouteError(404, "case_missing") };
  if (!await canAccessPatient(session, row.patient_id)) return { ok: false as const, response: journeyRouteError(403, "patient_access_denied") };
  return { ok: true as const, session, patientId: row.patient_id, orthoCaseId };
}
export async function GET(request: Request, context: JourneyRouteContext) {
  try {
    const owner = await scope(context, false); if (!owner.ok) return owner.response;
    const query = orthoQuery(request, ["acceptSchema", "revisionId"]);
    const revisionId = query?.has("revisionId") ? routeId(query.get("revisionId")) : undefined;
    if (!query || revisionId === null) return journeyRouteError(400, "invalid_query");
    if (query.get("acceptSchema") !== "1,2" && query.get("acceptSchema") !== "2") return journeyRouteError(409, "schema_negotiation_required");
    return orthoResult(await getOrthoAssessment({ ...owner, revisionId, acceptedSchemas: [2] }));
  } catch (error) { return orthoRouteFailure(error, false); }
}
export async function POST(request: Request, context: JourneyRouteContext) {
  try {
    const owner = await scope(context, true); if (!owner.ok) return owner.response;
    if (!orthoQuery(request, [])) return journeyRouteError(400, "invalid_query");
    const command = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    return orthoResult(await appendOrthoAssessment({ ...owner, command }), true);
  } catch (error) { return orthoRouteFailure(error, true); }
}
