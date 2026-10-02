import { NextResponse } from "next/server";
import { checkEndoTreatmentDraft } from "@/lib/endodontics";
import { listPatientEndo, openEndoTreatment, OPEN_ENDO_MESSAGE } from "@/lib/endodontics-db";
import { guardPatient, idOf, json, readBody } from "@/lib/case-route";

export const dynamic = "force-dynamic";

/** (ENDO-2) نوبات علاج الجذور للمريض — القراءة لمن يملك الوصول إلى ملفه (العزل المركزي نفسه). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const patientId = idOf((await params).id);
  if (!patientId) return json("رقم مريض غير صالح.", 400);
  const guard = await guardPatient(patientId, false);
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json({ treatments: await listPatientEndo(patientId) });
  } catch {
    return json("تعذّر تحميل علاج الجذور.", 500);
  }
}

/** فتح نوبة علاج جذور لسنٍّ داخل حالةٍ تخصصية — الطبيب والمدير. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const patientId = idOf((await params).id);
  if (!patientId) return json("رقم مريض غير صالح.", 400);
  const guard = await guardPatient(patientId, true);
  if (!guard.ok) return guard.response;
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const draft = checkEndoTreatmentDraft(read.body);
  if (!draft.ok) return json(draft.message, 400);
  try {
    const result = await openEndoTreatment({
      patientId, ...draft.value, actor: guard.session.username, actorRole: guard.session.role,
    });
    if (!result.ok) {
      const status = result.reason === "no_patient" ? 404 : result.reason === "bad_tooth" || result.reason === "bad_case" ? 400 : 409;
      return json(OPEN_ENDO_MESSAGE[result.reason], status);
    }
    return NextResponse.json(result.treatment, { status: 201 });
  } catch {
    return json("تعذّر فتح علاج الجذور. أعد المحاولة.", 500);
  }
}
