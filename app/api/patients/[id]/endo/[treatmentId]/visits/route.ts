import { visibleEndoTreatment } from "@/lib/endodontics-response";
import { NextResponse } from "next/server";
import { checkEndoVisitDraft } from "@/lib/endodontics";
import { saveEndoVisit, SAVE_ENDO_VISIT_MESSAGE, type SaveEndoVisitRefusal } from "@/lib/endodontics-db";
import { canViewPlanItems, guardPatient, idOf, json, readBody } from "@/lib/case-route";

export const dynamic = "force-dynamic";

const STATUS: Record<SaveEndoVisitRefusal, number> = {
  not_found: 404, visit_not_found: 404, wrong_patient: 400, closed: 409, visit_signed: 409,
  no_treating_doctor: 409, ambiguous_doctor: 409, exists: 409, version_conflict: 409,
};

/**
 * (ENDO-2) حفظ سجل علاج الجذور لزيارةٍ سريرية (إنشاءً أو تعديلًا) — الطبيب والمدير.
 * الجسم: `visitId` + الحقول + `canals`، ومع تعديل سجلٍّ قائم `expectedVersion`. زيارةٌ موقَّعة تُرفض
 * (التصحيح بملحق)؛ والمحاولة المعادة بالمحتوى نفسه تنجح بلا أثرٍ ثانٍ.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string; treatmentId: string }> }) {
  const { id, treatmentId: rawTreatment } = await params;
  const patientId = idOf(id);
  const treatmentId = idOf(rawTreatment);
  if (!patientId || !treatmentId) return json("رقم غير صالح.", 400);
  const guard = await guardPatient(patientId, true);
  if (!guard.ok) return guard.response;
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const visitId = idOf(String(read.body.visitId ?? ""));
  if (!visitId) return json("اختر الزيارة التي يُسجَّل عليها علاج الجذور.", 400);
  let expectedVersion: number | null = null;
  if (read.body.expectedVersion !== undefined && read.body.expectedVersion !== null) {
    const version = Number(read.body.expectedVersion);
    if (!Number.isInteger(version) || version < 1) return json("رقم إصدار السجل غير صالح.", 400);
    expectedVersion = version;
  }
  const draft = checkEndoVisitDraft(read.body);
  if (!draft.ok) return json(draft.message, 400);
  try {
    const result = await saveEndoVisit({
      patientId, treatmentId, visitId, draft: draft.value, expectedVersion,
      actorPartyId: guard.session.partyId ?? null,
      actor: guard.session.username, actorRole: guard.session.role,
    });
    if (!result.ok) return json(SAVE_ENDO_VISIT_MESSAGE[result.reason], STATUS[result.reason]);
    return NextResponse.json(visibleEndoTreatment(result.treatment, await canViewPlanItems(guard.session, patientId)), { status: result.created ? 201 : 200 });
  } catch {
    return json("تعذّر حفظ سجل علاج الجذور. أعد المحاولة.", 500);
  }
}
