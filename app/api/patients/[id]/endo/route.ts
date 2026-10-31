import { visibleEndoTreatment } from "@/lib/endodontics-response";
import { NextResponse } from "next/server";
import { checkEndoTreatmentDraft } from "@/lib/endodontics";
import { listPatientEndo, openEndoTreatment, OPEN_ENDO_MESSAGE } from "@/lib/endodontics-db";
import { canViewPlanItems, guardPatient, idOf, json, readBody } from "@/lib/case-route";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE } from "@/lib/canonical-patient-http";
import {
  canonicalEndoVisitFailure,
  createCanonicalEndoTreatment,
  readCanonicalPatientEndo,
} from "@/lib/canonical-endo-visits";

export const dynamic = "force-dynamic";

/** (ENDO-2) نوبات علاج الجذور للمريض — القراءة لمن يملك الوصول إلى ملفه (العزل المركزي نفسه). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rawId = (await params).id;
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  }
  if (selected.kind === "canonical") {
    try {
      return NextResponse.json(await readCanonicalPatientEndo(selected.handle, Number(rawId)), { headers: NO_STORE });
    } catch (error) {
      return canonicalEndoVisitFailure(error, "تعذّر تحميل علاج الجذور.");
    }
  }
  const patientId = idOf(rawId);
  if (!patientId) return json("رقم مريض غير صالح.", 400);
  const guard = await guardPatient(patientId, false);
  if (!guard.ok) return guard.response;
  try {
    const planVisible = await canViewPlanItems(guard.session, patientId);
    return NextResponse.json({ treatments: (await listPatientEndo(patientId)).map((view) => visibleEndoTreatment(view, planVisible)) });
  } catch {
    return json("تعذّر تحميل علاج الجذور.", 500);
  }
}

/** فتح نوبة علاج جذور لسنٍّ داخل حالةٍ تخصصية — الطبيب والمدير. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rawId = (await params).id;
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  }
  if (selected.kind === "canonical") {
    const read = await readBody(request);
    if (!read.ok) return read.response;
    try {
      return NextResponse.json(
        await createCanonicalEndoTreatment(selected.handle, Number(rawId), read.body),
        { status: 201, headers: NO_STORE },
      );
    } catch (error) {
      return canonicalEndoVisitFailure(error, "تعذّر فتح علاج الجذور. أعد المحاولة.");
    }
  }
  const patientId = idOf(rawId);
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
    return NextResponse.json(visibleEndoTreatment(result.treatment, await canViewPlanItems(guard.session, patientId)), { status: 201 });
  } catch {
    return json("تعذّر فتح علاج الجذور. أعد المحاولة.", 500);
  }
}
