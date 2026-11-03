import { IDEMPOTENCY_KEY_PATTERN } from "@/lib/idempotency-key";
import { visibleEndoTreatment } from "@/lib/endodontics-response";
import { NextResponse } from "next/server";
import { checkEndoAddendum } from "@/lib/endodontics";
import { addEndoAddendum, ENDO_ADDENDUM_MESSAGE } from "@/lib/endodontics-db";
import { canViewPlanItems, guardPatient, idOf, json, readBody } from "@/lib/case-route";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE } from "@/lib/canonical-patient-http";
import { canonicalEndoVisitFailure, createCanonicalEndoAddendum } from "@/lib/canonical-endo-visits";

export const dynamic = "force-dynamic";

/** (ENDO-2) ملحق على سجل علاج جذورٍ موقَّع — يُضاف ولا يمحو؛ يحمل كاتبه ووقته ويُدقَّق. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; treatmentId: string; endoVisitId: string }> }) {
  const { id, treatmentId: rawTreatment, endoVisitId: rawVisit } = await params;
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  }
  if (selected.kind === "canonical") {
    const read = await readBody(request);
    if (!read.ok) return read.response;
    try {
      const result = await createCanonicalEndoAddendum(
        selected.handle,
        Number(id),
        Number(rawTreatment),
        Number(rawVisit),
        read.body,
      );
      return NextResponse.json(result.treatment, { status: result.created ? 201 : 200, headers: NO_STORE });
    } catch (error) {
      return canonicalEndoVisitFailure(error, "تعذّر حفظ الملحق. أعد المحاولة.");
    }
  }
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
