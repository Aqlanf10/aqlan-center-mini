import { NextResponse } from "next/server";
import { checkEndoAddendum } from "@/lib/endodontics";
import { addEndoAddendum, ENDO_ADDENDUM_MESSAGE } from "@/lib/endodontics-db";
import { guardPatient, idOf, json, readBody } from "@/lib/case-route";

export const dynamic = "force-dynamic";

/** (ENDO-2) ملحق على سجل علاج جذورٍ موقَّع — يُضاف ولا يمحو؛ يحمل كاتبه ووقته ويُدقَّق. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; treatmentId: string; endoVisitId: string }> }) {
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
  try {
    const result = await addEndoAddendum({
      patientId, treatmentId, endoVisitId, text: text.value,
      actor: guard.session.username, actorRole: guard.session.role,
    });
    if (!result.ok) return json(ENDO_ADDENDUM_MESSAGE[result.reason], result.reason === "not_found" ? 404 : 409);
    return NextResponse.json(result.treatment, { status: 201 });
  } catch {
    return json("تعذّر حفظ الملحق. أعد المحاولة.", 500);
  }
}
