import { setFamilyGuarantor } from "@/lib/db";
import { idOf, json, readBody } from "@/lib/case-route";
import { familyFailure, familyResponse, familyWriter } from "@/lib/family-route";
import { parseGuarantor } from "@/lib/patient-families";

export const dynamic = "force-dynamic";

/**
 * (PAT-4) تعيين ضامن العائلة أو تغييره أو إزالته (`{ kind: "none" }`). معلومةٌ وكشفٌ فقط — لا يمسّ
 * دفتر أي فرد (قرار المالك).
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await familyWriter();
  if (!guard.ok) return guard.response;
  const familyId = idOf((await params).id);
  if (!familyId) return json("رقم العائلة غير صالح.", 400);
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const guarantor = parseGuarantor(read.body.guarantor ?? read.body);
  if (!guarantor.ok) return json(guarantor.message, 400);
  try {
    const result = await setFamilyGuarantor({ familyId, guarantor: guarantor.value }, { actor: guard.session.username, actorRole: guard.session.role });
    if (!result.ok) return familyFailure(result.reason);
    return familyResponse(guard.session, result.family);
  } catch {
    return json("تعذّر حفظ الضامن. أعد المحاولة.", 500);
  }
}
