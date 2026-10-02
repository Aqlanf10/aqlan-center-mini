import { NextResponse } from "next/server";
import { checkEndoStatusChange } from "@/lib/endodontics";
import { changeEndoStatus, ENDO_STATUS_MESSAGE } from "@/lib/endodontics-db";
import { guardPatient, idOf, json, readBody } from "@/lib/case-route";

export const dynamic = "force-dynamic";

/** (ENDO-2) إكمال علاج الجذور أو إيقافه (بسبب) — النوبة المنتهية لا تعود. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; treatmentId: string }> }) {
  const { id, treatmentId: rawTreatment } = await params;
  const patientId = idOf(id);
  const treatmentId = idOf(rawTreatment);
  if (!patientId || !treatmentId) return json("رقم غير صالح.", 400);
  const guard = await guardPatient(patientId, true);
  if (!guard.ok) return guard.response;
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const change = checkEndoStatusChange(read.body);
  if (!change.ok) return json(change.message, 400);
  try {
    const result = await changeEndoStatus({
      patientId, treatmentId, status: change.value.status as "completed" | "abandoned", outcome: change.value.outcome,
      actor: guard.session.username, actorRole: guard.session.role,
    });
    if (!result.ok) {
      if (result.reason === "not_ready") return json(result.message ?? "علاج الجذور غير جاهز للإكمال.", 409);
      return json(ENDO_STATUS_MESSAGE[result.reason], result.reason === "not_found" ? 404 : 409);
    }
    return NextResponse.json(result.treatment);
  } catch {
    return json("تعذّر تغيير حالة علاج الجذور. أعد المحاولة.", 500);
  }
}
