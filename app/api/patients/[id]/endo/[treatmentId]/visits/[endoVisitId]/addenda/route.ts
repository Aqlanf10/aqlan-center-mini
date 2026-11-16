import { IDEMPOTENCY_KEY_PATTERN } from "@/lib/idempotency-key";
import { visibleEndoTreatment } from "@/lib/endodontics-response";
import { NextResponse } from "next/server";
import { canonicalEndoRoute, commandCanonicalEndoAddendum } from "@/lib/canonical-endo";
import { checkEndoAddendum } from "@/lib/endodontics";
import { addEndoAddendum, ENDO_ADDENDUM_MESSAGE } from "@/lib/endodontics-db";
import { canViewPlanItems, guardPatient, idOf, json, readBody } from "@/lib/case-route";

export const dynamic = "force-dynamic";

/** (ENDO-2) ملحق على سجل علاج جذورٍ موقَّع — يُضاف ولا يمحو؛ يحمل كاتبه ووقته ويُدقَّق. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; treatmentId: string; endoVisitId: string }> }) {
  /* M2 slice 77: clinical.visits.document and clinical.visits.sign inside the scope, the clinician link or the owner. */
  const canonical = await canonicalEndoRoute(request, async (handle, body) => { const { id, treatmentId, endoVisitId } = await params; return commandCanonicalEndoAddendum(handle, id, treatmentId, endoVisitId, body); }, "تعذّر حفظ الملحق. أعد المحاولة.");
  if (canonical) return canonical;
  const { id, treatmentId: rawTreatment, endoVisitId: rawVisit } = await params;
  const patientId = idOf(id);
  const treatmentId = idOf(rawTreatment);
  const endoVisitId = idOf(rawVisit);
  if (!patientId || !treatmentId || !endoVisitId) return json("رقم غير صالح.", 400);
  const guard = await guardPatient(patientId, true);
  if (!guard.ok) return guard.response;
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const text = checkEndoAddendum(read.body);
  if (!text.ok) return json(text.message, 400);
  const requestKey = read.body.requestKey;
  if (typeof requestKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(requestKey)) return json("مفتاح إعادة محاولة الملحق غير صالح.", 400);
  try {
    const result = await addEndoAddendum({
      patientId, treatmentId, endoVisitId, text: text.value, requestKey,
      actor: guard.session.username, actorRole: guard.session.role,
    });
    if (!result.ok) return json(ENDO_ADDENDUM_MESSAGE[result.reason], result.reason === "not_found" ? 404 : ["bad_key", "bad_text"].includes(result.reason) ? 400 : 409);
    return NextResponse.json(visibleEndoTreatment(result.treatment, await canViewPlanItems(guard.session, patientId)), { status: result.created ? 201 : 200 });
  } catch {
    return json("تعذّر حفظ الملحق. أعد المحاولة.", 500);
  }
}
