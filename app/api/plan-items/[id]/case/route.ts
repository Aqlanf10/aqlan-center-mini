import { NextResponse } from "next/server";
import { getPlanItemPatient, setPlanItemCase } from "@/lib/db";
import { guardPatient, idOf, json, readBody } from "@/lib/case-route";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { canonicalPatientReadFailure, NO_STORE } from "@/lib/canonical-patient-http";
import { CanonicalPlanCaseRefusal, commandCanonicalPlanItemCase } from "@/lib/canonical-plan-case-command";

export const dynamic = "force-dynamic";

/** (CASE-MODEL-1) ربط بند الخطة بحالةٍ تخصصية وتحديد أولويته في الخطة الشاملة. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rawId = (await params).id;
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    const read = await readBody(request);
    if (!read.ok) { read.response.headers.set("Cache-Control", "private, no-store"); return read.response; }
    try {
      if ([...new URL(request.url).searchParams.keys()].length) throw new CanonicalPlanCaseRefusal("invalid_plan_case", 400, "طلب الربط لا يقبل مرشحات إضافية.");
      return NextResponse.json(await commandCanonicalPlanItemCase(selected.handle, rawId, read.body), { headers: NO_STORE });
    } catch (error) {
      if (error instanceof CanonicalPlanCaseRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
      return canonicalPatientReadFailure(error, "تعذّر تأكيد حفظ الربط. تحقّق من الحالة الحالية قبل أي محاولة جديدة.");
    }
  }
  const itemId = idOf(rawId);
  if (!itemId) return json("رقم بند غير صالح.", 400);
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const rawCase = read.body.caseId;
  const caseId = rawCase === null || rawCase === undefined || rawCase === "" ? null : idOf(String(rawCase));
  if (rawCase !== null && rawCase !== undefined && rawCase !== "" && caseId === null) return json("الحالة غير صالحة.", 400);
  const rawPriority = read.body.priority;
  const priority = rawPriority === null || rawPriority === undefined || rawPriority === "" ? null : Number(rawPriority);
  if (priority !== null && (!Number.isInteger(priority) || priority < 1 || priority > 999)) {
    return json("الأولوية رقمٌ من ١ إلى ٩٩٩ (الأصغر أولًا).", 400);
  }
  try {
    const patientId = await getPlanItemPatient(itemId);
    if (!patientId) return json("لا يوجد بند بهذا الرقم.", 404);
    const guard = await guardPatient(patientId, true, "edit");
    if (!guard.ok) return guard.response;
    const result = await setPlanItemCase({
      itemId, caseId, priority, actor: guard.session.username, actorRole: guard.session.role,
    });
    if (!result.ok) {
      if (result.reason === "billed_case_lock") {
        return json("لا يمكن تغيير الحالة المرتبطة ببند صدرت له فاتورة حفاظًا على السجل المالي والعمولات. يمكنك تعديل الأولوية فقط.", 409);
      }
      return result.reason === "not_found" ? json("لا يوجد بند بهذا الرقم.", 404) : json("الحالة المختارة لا تخص هذا المريض.", 400);
    }
    return NextResponse.json({ ok: true });
  } catch {
    return json("تعذّر حفظ الربط. أعد المحاولة.", 500);
  }
}
