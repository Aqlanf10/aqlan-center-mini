import { NextResponse } from "next/server";
import { changePatientProblemStatus, getPatientProblemOwner } from "@/lib/db";
import { checkProblemStatus } from "@/lib/cases";
import { guardPatient, idOf, json, readBody } from "@/lib/case-route";

export const dynamic = "force-dynamic";

/** (CASE-MODEL-1) تغيير حالة مشكلة: نشطة / محلولة / غير نشطة — مُدقَّق. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = idOf((await params).id);
  if (!id) return json("رقم مشكلة غير صالح.", 400);
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const status = checkProblemStatus(read.body);
  if (!status.ok) return json(status.message, 400);
  try {
    const patientId = await getPatientProblemOwner(id);
    if (!patientId) return json("لا توجد مشكلة بهذا الرقم.", 404);
    const guard = await guardPatient(patientId, true);
    if (!guard.ok) return guard.response;
    const result = await changePatientProblemStatus({
      id, status: status.value, actor: guard.session.username, actorRole: guard.session.role,
    });
    if (!result.ok) {
      return result.reason === "not_found" ? json("لا توجد مشكلة بهذا الرقم.", 404) : json("المشكلة بهذه الحالة سلفًا.", 409);
    }
    return NextResponse.json(result.problem);
  } catch {
    return json("تعذّر تحديث المشكلة. أعد المحاولة.", 500);
  }
}
