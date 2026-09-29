import { NextResponse } from "next/server";
import { createClinicalCase, listCasePlanItems, listPatientCases, listPatientProblems } from "@/lib/db";
import { checkCaseDraft } from "@/lib/cases";
import { canViewPlanItems, guardPatient, idOf, json, readBody } from "@/lib/case-route";

export const dynamic = "force-dynamic";

/** (CASE-MODEL-1) الحالات التخصصية للمريض وقائمة مشاكله وبنود خطته مرتّبةً باعتمادياتها — قراءة واحدة. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const patientId = idOf((await params).id);
  if (!patientId) return json("رقم مريض غير صالح.", 400);
  const guard = await guardPatient(patientId, false);
  if (!guard.ok) return guard.response;
  try {
    const planVisible = await canViewPlanItems(guard.session, patientId);
    const [cases, problems, plan] = await Promise.all([
      listPatientCases(patientId), listPatientProblems(patientId),
      planVisible ? listCasePlanItems(patientId) : Promise.resolve({ items: [], dependencies: [] }),
    ]);
    return NextResponse.json({ cases, problems, items: plan.items, dependencies: plan.dependencies, planVisible });
  } catch {
    return json("تعذّر تحميل الحالات التخصصية.", 500);
  }
}

/** فتح حالة تخصصية (أو ربط حالة تقويمٍ قائمة بالميزات العامة عبر orthoCaseId). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const patientId = idOf((await params).id);
  if (!patientId) return json("رقم مريض غير صالح.", 400);
  const guard = await guardPatient(patientId, true);
  if (!guard.ok) return guard.response;
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const draft = checkCaseDraft(read.body);
  if (!draft.ok) return json(draft.message, 400);
  try {
    const result = await createClinicalCase({
      ...draft.value, patientId, actor: guard.session.username, actorRole: guard.session.role,
    });
    if (!result.ok) {
      const messages = {
        no_patient: ["لا يوجد مريض بهذا الرقم.", 404],
        bad_responsible: ["الطبيب المسؤول يجب أن يكون طبيبًا مسجّلًا.", 400],
        bad_ortho: ["حالة التقويم لا تخص هذا المريض.", 400],
        already_bridged: ["حالة التقويم هذه مربوطة من قبل.", 409],
      } as const;
      const [message, status] = messages[result.reason];
      return json(message, status);
    }
    return NextResponse.json(result.case, { status: 201 });
  } catch {
    return json("تعذّر حفظ الحالة. أعد المحاولة.", 500);
  }
}
