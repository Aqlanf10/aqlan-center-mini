import { NextResponse } from "next/server";
import { guardPatient, idOf, json, readBody } from "@/lib/case-route";
import { checkPerioAddendum } from "@/lib/periodontics";
import { addPerioAddendum, PERIO_MESSAGE } from "@/lib/periodontics-db";
export const dynamic = "force-dynamic";
export async function POST(request: Request, { params }: { params: Promise<{ id: string; examId: string }> }) {
  const raw = await params; const patientId = idOf(raw.id); const examId = idOf(raw.examId);
  if (!patientId || !examId) return json("رقم المريض أو الفحص غير صالح.", 400);
  const guard = await guardPatient(patientId, true);
  if (!guard.ok) return guard.response;
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const checked = checkPerioAddendum(read.body);
  if (!checked.ok) return json(checked.message, 400);
  try {
    const result = await addPerioAddendum({ patientId, examId, ...checked.value, actor: guard.session.username, actorRole: guard.session.role });
    if (!result.ok) return NextResponse.json({ message: PERIO_MESSAGE[result.reason], code: result.reason },
      { status: result.reason === "not_found" ? 404 : result.reason === "bad_addendum" ? 400 : 409 });
    return NextResponse.json({ exam: result.exam, unchanged: result.unchanged }, { status: result.created ? 201 : 200 });
  } catch { return json("تعذّر التأكد من حفظ الملحق. أعد تحميل السجل واحتفظ بمفتاح المحاولة نفسه.", 500); }
}
