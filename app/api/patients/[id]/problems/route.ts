import { canonicalPatientGet } from "@/lib/canonical-patient-http";
import { readCanonicalProblems } from "@/lib/canonical-patient-reads";
import { NextResponse } from "next/server";
import { createPatientProblem, listPatientProblems } from "@/lib/db";
import { checkProblemDraft } from "@/lib/cases";
import { guardPatient, idOf, json, readBody } from "@/lib/case-route";

import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { canonicalPatientReadFailure, NO_STORE } from "@/lib/canonical-patient-http";
import { CanonicalProblemCreateRefusal, commandCanonicalProblemCreate } from "@/lib/canonical-problem-create-command";

export const dynamic = "force-dynamic";

/** (CASE-MODEL-1) قائمة مشاكل المريض. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Canonical identity (M2 slice 3): owning snapshot, patient inside the scope, projection by grant.
  const canonical = await canonicalPatientGet((await params).id, readCanonicalProblems, "تعذّر تحميل قائمة المشاكل.");
  if (canonical) return canonical;
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
  const rawId = (await params).id, selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({message:"انتهت الجلسة. سجّل الدخول من جديد."},{status:401,headers:NO_STORE});
  if (selected.kind === "canonical") {
    const read = await readBody(request);
    if (!read.ok) { read.response.headers.set("Cache-Control","private, no-store"); return read.response; }
    try {
      if ([...new URL(request.url).searchParams.keys()].length) throw new CanonicalProblemCreateRefusal("invalid_problem_create",400,"طلب إنشاء المشكلة لا يقبل مرشحات إضافية.");
      return NextResponse.json(await commandCanonicalProblemCreate(selected.handle,rawId,read.body),{status:201,headers:NO_STORE});
    } catch (error) {
      if (error instanceof CanonicalProblemCreateRefusal) return NextResponse.json({code:error.code,message:error.message},{status:error.status,headers:NO_STORE});
      return canonicalPatientReadFailure(error,"تعذّر تأكيد حفظ المشكلة. راجع القائمة الحالية قبل أي طلب جديد.");
    }
  }
  const patientId = idOf(rawId);
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
