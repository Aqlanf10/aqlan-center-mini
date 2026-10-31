import { NextResponse } from "next/server";
import { NO_STORE } from "@/lib/canonical-patient-http";
import { canonicalPlanCaseFailure, commandCanonicalSetPlanItemCase } from "@/lib/canonical-plans-and-cases";
import { getPlanItemPatient, setPlanItemCase } from "@/lib/db";
import { guardPatient, idOf, json, readBody } from "@/lib/case-route";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";

export const dynamic = "force-dynamic";

/** (CASE-MODEL-1) ربط بند الخطة بحالةٍ تخصصية وتحديد أولويته في الخطة الشاملة. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  }
  if (selected.kind === "canonical") {
    const read = await readBody(request);
    if (!read.ok) return read.response;
    try {
      const { id } = await params;
      return NextResponse.json(await commandCanonicalSetPlanItemCase(selected.handle, id, read.body), { headers: NO_STORE });
    } catch (error) {
      return canonicalPlanCaseFailure(error, "تعذّر حفظ الربط. أعد المحاولة.");
    }
  }
  const itemId = idOf((await params).id);
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
