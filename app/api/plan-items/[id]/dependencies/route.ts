import { NextResponse } from "next/server";
import { addPlanItemDependency, getPlanItemPatient, removePlanItemDependency } from "@/lib/db";
import { checkDependencyDraft } from "@/lib/cases";
import { guardPatient, idOf, json, readBody } from "@/lib/case-route";

import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { canonicalPatientReadFailure, NO_STORE } from "@/lib/canonical-patient-http";
import { CanonicalPlanDependencyRefusal, commandCanonicalPlanDependency } from "@/lib/canonical-plan-dependency-command";

async function canonical(request: Request, rawId: string, kind: "add" | "remove") {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "legacy" || selected.kind === "none") return null;
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  const read = await readBody(request);
  if (!read.ok) { read.response.headers.set("Cache-Control", "private, no-store"); return read.response; }
  try {
    if ([...new URL(request.url).searchParams.keys()].length) throw new CanonicalPlanDependencyRefusal("invalid_plan_dependency", 400, "طلب الاعتماد لا يقبل مرشحات إضافية.");
    return NextResponse.json(await commandCanonicalPlanDependency(selected.handle, kind, rawId, read.body), { status: kind === "add" ? 201 : 200, headers: NO_STORE });
  } catch (error) {
    if (error instanceof CanonicalPlanDependencyRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
    return canonicalPatientReadFailure(error, "تعذّر تأكيد تغيير الاعتماد. تحقّق من الحالة الحالية قبل أي طلب جديد.");
  }
}

export const dynamic = "force-dynamic";

/** (CASE-MODEL-1) «هذا البند يتطلب ذاك» — للمريض نفسه وبلا دورات. تحذيرٌ لا منع عند التنفيذ. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rawId = (await params).id;
  const admitted = await canonical(request, rawId, "add");
  if (admitted) return admitted;
  const itemId = idOf(rawId);
  if (!itemId) return json("رقم بند غير صالح.", 400);
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const draft = checkDependencyDraft(itemId, read.body);
  if (!draft.ok) return json(draft.message, 400);
  try {
    const patientId = await getPlanItemPatient(itemId);
    if (!patientId) return json("لا يوجد بند بهذا الرقم.", 404);
    const guard = await guardPatient(patientId, true, "edit");
    if (!guard.ok) return guard.response;
    const result = await addPlanItemDependency({
      itemId, ...draft.value, actor: guard.session.username, actorRole: guard.session.role,
    });
    if (!result.ok) {
      const messages = {
        not_found: ["لا يوجد بند بهذا الرقم.", 404],
        other_patient: ["البندان لمريضين مختلفين.", 400],
        cycle: ["هذا الاعتماد يصنع دورة — كلٌّ من البندين سينتظر الآخر.", 409],
        exists: ["هذا الاعتماد موجود من قبل.", 409],
      } as const;
      const [message, status] = messages[result.reason];
      return json(message, status);
    }
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch {
    return json("تعذّر حفظ الاعتماد. أعد المحاولة.", 500);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rawId = (await params).id;
  const admitted = await canonical(request, rawId, "remove");
  if (admitted) return admitted;
  const itemId = idOf(rawId);
  if (!itemId) return json("رقم بند غير صالح.", 400);
  const requiresItemId = idOf(new URL(request.url).searchParams.get("requires") ?? "");
  if (!requiresItemId) return json("حدّد البند المطلوب المراد إزالته.", 400);
  try {
    const patientId = await getPlanItemPatient(itemId);
    if (!patientId) return json("لا يوجد بند بهذا الرقم.", 404);
    const guard = await guardPatient(patientId, true, "edit");
    if (!guard.ok) return guard.response;
    const result = await removePlanItemDependency({
      itemId, requiresItemId, actor: guard.session.username, actorRole: guard.session.role,
    });
    if (!result.ok) return json("لا يوجد هذا الاعتماد.", 404);
    return NextResponse.json({ ok: true });
  } catch {
    return json("تعذّر إزالة الاعتماد. أعد المحاولة.", 500);
  }
}
