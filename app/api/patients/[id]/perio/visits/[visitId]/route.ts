import { NextResponse } from "next/server";
import { guardPatient, idOf, json, readBody } from "@/lib/case-route";
import { checkPerioDraft, checkPerioRevision } from "@/lib/periodontics";
import { savePerioExam, PERIO_MESSAGE } from "@/lib/periodontics-db";
export const dynamic = "force-dynamic";
export async function PUT(request: Request, { params }: { params: Promise<{ id: string; visitId: string }> }) {
  const raw = await params;
  const patientId = idOf(raw.id); const visitId = idOf(raw.visitId);
  if (!patientId || !visitId) return json("رقم المريض أو الزيارة غير صالح.", 400);
  const guard = await guardPatient(patientId, true);
  if (!guard.ok) return guard.response;
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const draft = checkPerioDraft(read.body); const revision = checkPerioRevision(read.body.expectedRevision);
  if (!draft.ok) return json(draft.message, 400);
  if (!revision.ok) return json(revision.message, 400);
  try {
    const result = await savePerioExam({ patientId, visitId, draft: draft.value, expectedRevision: revision.value,
      actor: guard.session.username, actorRole: guard.session.role });
    if (!result.ok) return NextResponse.json({ message: PERIO_MESSAGE[result.reason], code: result.reason },
      { status: result.reason === "not_found" ? 404 : ["bad_draft", "bad_case", "bad_doctor"].includes(result.reason) ? 400 : 409 });
    return NextResponse.json({ exam: result.exam, unchanged: result.unchanged }, { status: result.created ? 201 : 200 });
  } catch { return json("تعذّر التأكد من حفظ فحص اللثة. أعد تحميل السجل قبل إعادة المحاولة.", 500); }
}
