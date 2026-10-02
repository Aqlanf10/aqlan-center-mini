import { NextResponse } from "next/server";
import { setEndoCrown, ENDO_CROWN_MESSAGE } from "@/lib/endodontics-db";
import { guardPatient, idOf, json, readBody } from "@/lib/case-route";

export const dynamic = "force-dynamic";

const optionalId = (raw: unknown): { ok: true; value: number | null } | { ok: false } => {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  const id = typeof raw === "string" ? Number(raw) : raw;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? { ok: true, value: id } : { ok: false };
};

/**
 * (ENDO-2) قرار التاج بعد علاج الجذور. الربط ببند التاج في خطة المريض، وإن أُعطي بند علاج الجذور
 * سُجِّل «التاج بعد اكتماله» في اعتماديات الخطة نفسها. الطبيب والمدير؛ والخطة تحترم صلاحية تعديلها.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; treatmentId: string }> }) {
  const { id, treatmentId: rawTreatment } = await params;
  const patientId = idOf(id);
  const treatmentId = idOf(rawTreatment);
  if (!patientId || !treatmentId) return json("رقم غير صالح.", 400);
  // الدور أولًا (قبل قراءة الجسم): الدور المرفوض لا يرى رسائل التحقق.
  const guard = await guardPatient(patientId, true);
  if (!guard.ok) return guard.response;
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const crownItem = optionalId(read.body.crownPlanItemId);
  const rctItem = optionalId(read.body.rctPlanItemId);
  if (typeof read.body.crownRequired !== "boolean") return json("حدّد هل التاج لازم أم لا.", 400);
  if (!crownItem.ok || !rctItem.ok) return json("بند الخطة غير صالح.", 400);
  // ربط بندٍ من الخطة يمسّ الخطة: يحترم صلاحية تعديل الخطط (لا بابًا خلفيًّا حول صلاحيةٍ مُطفأة).
  if (crownItem.value !== null || rctItem.value !== null) {
    const planGuard = await guardPatient(patientId, true, "edit");
    if (!planGuard.ok) return planGuard.response;
  }
  try {
    const result = await setEndoCrown({
      patientId, treatmentId, crownRequired: read.body.crownRequired,
      crownPlanItemId: crownItem.value, rctPlanItemId: rctItem.value,
      actor: guard.session.username, actorRole: guard.session.role,
    });
    if (!result.ok) return json(ENDO_CROWN_MESSAGE[result.reason], result.reason === "not_found" ? 404 : result.reason === "bad_item" ? 400 : 409);
    return NextResponse.json(result.treatment);
  } catch {
    return json("تعذّر حفظ قرار التاج. أعد المحاولة.", 500);
  }
}
