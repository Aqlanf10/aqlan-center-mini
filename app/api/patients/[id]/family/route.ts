import { NextResponse } from "next/server";
import { familyIdOfPatient } from "@/lib/db";
import { idOf, json } from "@/lib/case-route";
import { buildFamilyView, canEditFamilies } from "@/lib/family-view";
import { canAccessPatient } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (PAT-4) عائلة المريض للوحة «العائلة» في ملفه — بوصول صاحب الجلسة إلى ملف المريض نفسه، والأفراد
 * والأرصدة بحسب `buildFamilyView`. `family: null` = بلا عائلة.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return json("انتهت الجلسة. سجّل الدخول من جديد.", 401);
  const patientId = idOf((await params).id);
  if (!patientId) return json("رقم المريض غير صالح.", 400);
  if (!(await canAccessPatient(session, patientId).catch(() => false))) {
    return json("غير مصرّح لك بملف هذا المريض.", 403);
  }
  try {
    const familyId = await familyIdOfPatient(patientId);
    if (familyId === undefined) return json("لا يوجد مريض بهذا الرقم.", 404);
    const canEdit = canEditFamilies(session.role);
    if (familyId === null) return NextResponse.json({ family: null, canEdit });
    const result = await buildFamilyView(session, familyId);
    if (!result.ok) return NextResponse.json({ family: null, canEdit });
    return NextResponse.json({ family: result.view, canEdit });
  } catch {
    return json("تعذّر تحميل عائلة المريض.", 500);
  }
}
