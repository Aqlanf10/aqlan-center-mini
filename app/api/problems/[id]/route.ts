import { NextResponse } from "next/server";
import { changePatientProblemStatus, getPatientProblemOwner } from "@/lib/db";
import { checkProblemStatus } from "@/lib/cases";
import { guardPatient, idOf, json, readBody } from "@/lib/case-route";

import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { canonicalPatientReadFailure, NO_STORE } from "@/lib/canonical-patient-http";
import { CanonicalProblemStatusRefusal, commandCanonicalProblemStatus } from "@/lib/canonical-problem-status-command";

export const dynamic = "force-dynamic";

/** (CASE-MODEL-1) تغيير حالة مشكلة: نشطة / محلولة / غير نشطة — مُدقَّق. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rawId = (await params).id;
  const selected = await selectRequestStaffEnvelope();
  if(selected.kind === "denied")return NextResponse.json({message:"انتهت الجلسة. سجّل الدخول من جديد."},{status:401,headers:NO_STORE});
  if(selected.kind === "canonical"){
    const read=await readBody(request);
    if(!read.ok){read.response.headers.set("Cache-Control","private, no-store");return read.response;}
    try{
      if([...new URL(request.url).searchParams.keys()].length)throw new CanonicalProblemStatusRefusal("invalid_problem_status",400,"طلب حالة المشكلة لا يقبل مرشحات إضافية.");
      return NextResponse.json(await commandCanonicalProblemStatus(selected.handle,rawId,read.body),{headers:NO_STORE});
    }catch(error){
      if(error instanceof CanonicalProblemStatusRefusal)return NextResponse.json({code:error.code,message:error.message},{status:error.status,headers:NO_STORE});
      return canonicalPatientReadFailure(error,"تعذّر تأكيد تغيير المشكلة. تحقّق من النتيجة الحالية قبل أي طلب جديد.");
    }
  }
  const id = idOf(rawId);
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
