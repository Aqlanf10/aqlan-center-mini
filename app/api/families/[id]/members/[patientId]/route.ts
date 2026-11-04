import { unlinkPatientFromFamily } from "@/lib/db";
import { idOf, json } from "@/lib/case-route";
import { familyFailure, familyResponse, familyWriter } from "@/lib/family-route";
import { canonicalFamilyRoute, commandCanonicalFamilyUnlink } from "@/lib/canonical-families";

export const dynamic = "force-dynamic";

/** (PAT-4) فكّ مريضٍ من العائلة. العائلة تبقى وإن فرغت. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; patientId: string }> }) {
  const raw = await params;
  const canonical = await canonicalFamilyRoute(null, handle => commandCanonicalFamilyUnlink(handle, raw.id, raw.patientId), "تعذّر فكّ الربط. أعد المحاولة.");
  if (canonical) return canonical;
  const guard = await familyWriter();
  if (!guard.ok) return guard.response;
  const familyId = idOf(raw.id);
  const patientId = idOf(raw.patientId);
  if (!familyId || !patientId) return json("رقم العائلة أو المريض غير صالح.", 400);
  try {
    const result = await unlinkPatientFromFamily({ familyId, patientId }, { actor: guard.session.username, actorRole: guard.session.role });
    if (!result.ok) return familyFailure(result.reason);
    return familyResponse(guard.session, result.family);
  } catch {
    return json("تعذّر فكّ الربط. أعد المحاولة.", 500);
  }
}
