import { NextResponse } from "next/server";
import { createPatientProblem, listPatientProblems } from "@/lib/db";
import { checkProblemDraft } from "@/lib/cases";
import { guardPatient, idOf, json, readBody } from "@/lib/case-route";

export const dynamic = "force-dynamic";

/** (CASE-MODEL-1) قائمة مشاكل المريض. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const patientId = idOf((await params).id);
  if (!patientId) return json("رقم مريض غير صالح.", 400);
  const guard = await guardPatient(patientId, false);
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json(await listPatientProblems(patientId));
  } catch {
    return json("تعذّر تحميل قائمة المشاكل.", 500);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const patientId = idOf((await params).id);
  if (!patientId) return json("رقم مريض غير صالح.", 400);
  const guard = await guardPatient(patientId, true);
  if (!guard.ok) return guard.response;
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const draft = checkProblemDraft(read.body);
  if (!draft.ok) return json(draft.message, 400);
  try {
    const result = await createPatientProblem({
      ...draft.value, patientId, actor: guard.session.username, actorRole: guard.session.role,
    });
    if (!result.ok) {
      return result.reason === "no_patient"
        ? json("لا يوجد مريض بهذا الرقم.", 404)
        : json("الحالة المختارة لا تخص هذا المريض.", 400);
    }
    return NextResponse.json(result.problem, { status: 201 });
  } catch {
    return json("تعذّر حفظ المشكلة. أعد المحاولة.", 500);
  }
}
