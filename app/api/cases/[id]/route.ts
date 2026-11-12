import { NextResponse } from "next/server";
import { changeClinicalCaseStatus, getClinicalCase } from "@/lib/db";
import { checkCaseStatusChange } from "@/lib/cases";
import { guardPatient, idOf, json, readBody } from "@/lib/case-route";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { canonicalPatientReadFailure, NO_STORE } from "@/lib/canonical-patient-http";
import { CanonicalCaseStatusRefusal, commandCanonicalCaseStatus } from "@/lib/canonical-case-status-command";

export const dynamic = "force-dynamic";

/** (CASE-MODEL-1) تغيير حالة الحالة التخصصية: المسار المسموح وحده، والمنتهية لا تُعاد فتحها (409). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rawId = (await params).id;
  const selected = await selectRequestStaffEnvelope();
  if(selected.kind === "denied")return NextResponse.json({message:"انتهت الجلسة. سجّل الدخول من جديد."},{status:401,headers:NO_STORE});
  if(selected.kind === "canonical"){
    const read=await readBody(request);
    if(!read.ok){read.response.headers.set("Cache-Control","private, no-store");return read.response;}
    try{
      if([...new URL(request.url).searchParams.keys()].length)throw new CanonicalCaseStatusRefusal("invalid_case_status",400,"طلب حالة العلاج لا يقبل مرشحات إضافية.");
      return NextResponse.json(await commandCanonicalCaseStatus(selected.handle,rawId,read.body),{headers:NO_STORE});
    }catch(error){
      if(error instanceof CanonicalCaseStatusRefusal)return NextResponse.json({code:error.code,message:error.message},{status:error.status,headers:NO_STORE});
      return canonicalPatientReadFailure(error,"تعذّر تأكيد تغيير الحالة. تحقّق من النتيجة الحالية قبل أي طلب جديد.");
    }
  }
  const id = idOf(rawId);
  if (!id) return json("رقم حالة غير صالح.", 400);
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const change = checkCaseStatusChange(read.body);
  if (!change.ok) return json(change.message, 400);
  try {
    const existing = await getClinicalCase(id);
    if (!existing) return json("لا توجد حالة بهذا الرقم.", 404);
    const guard = await guardPatient(existing.patientId, true);
    if (!guard.ok) return guard.response;
    const result = await changeClinicalCaseStatus({
      id, ...change.value, actor: guard.session.username, actorRole: guard.session.role,
    });
    if (!result.ok) {
      if (result.reason === "not_found") return json("لا توجد حالة بهذا الرقم.", 404);
      if (result.reason === "ortho_managed") return json("حالة التقويم تُدار وتُغلق من «التقويم وسيفالو».", 409);
      return json("لا يمكن نقل الحالة إلى هذه الحالة — المنتهية لا تُعاد فتحها؛ افتح حالةً جديدة.", 409);
    }
    return NextResponse.json(result.case);
  } catch {
    return json("تعذّر تحديث الحالة. أعد المحاولة.", 500);
  }
}
