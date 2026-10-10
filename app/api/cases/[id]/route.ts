import { CLINICAL_CASE_LINKAGE_MESSAGE } from "@/lib/clinical-case-linkage";
import { NextResponse } from "next/server";
import { changeClinicalCaseStatus, getClinicalCase } from "@/lib/db";
import { checkCaseStatusChange } from "@/lib/cases";
import { guardPatient, idOf, json, readBody } from "@/lib/case-route";

export const dynamic = "force-dynamic";

/** (CASE-MODEL-1) تغيير حالة الحالة التخصصية: المسار المسموح وحده، والمنتهية لا تُعاد فتحها (409). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = idOf((await params).id);
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
      id, expectedPatientId: existing.patientId, ...change.value, actor: guard.session.username, actorRole: guard.session.role,
    });
    if (!result.ok) {
      if (result.reason === "not_found") return json("لا توجد حالة بهذا الرقم.", 404);
      if (result.reason === "owner_changed") return json(CLINICAL_CASE_LINKAGE_MESSAGE.owner_changed, 409);
      if (result.reason === "ortho_managed") return json("حالة التقويم تُدار وتُغلق من «التقويم وسيفالو».", 409);
      return json("لا يمكن نقل الحالة إلى هذه الحالة — المنتهية لا تُعاد فتحها؛ افتح حالةً جديدة.", 409);
    }
    return NextResponse.json(result.case);
  } catch {
    return json("تعذّر تحديث الحالة. أعد المحاولة.", 500);
  }
}
