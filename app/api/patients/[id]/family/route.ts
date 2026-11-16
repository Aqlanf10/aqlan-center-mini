import { NextResponse } from "next/server";
import { familyIdOfPatient } from "@/lib/db";
import { idOf, json } from "@/lib/case-route";
import { buildFamilyView, canEditFamilies } from "@/lib/family-view";
import { canAccessPatient } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";
import { CanonicalFamilyRefusal, canonicalFamilyRoute, readCanonicalPatientFamily } from "@/lib/canonical-families";

export const dynamic = "force-dynamic";

/**
 * (PAT-4) عائلة المريض للوحة «العائلة» في ملفه — بوصول صاحب الجلسة إلى ملف المريض نفسه، والأفراد
 * والأرصدة بحسب `buildFamilyView`. `family: null` = بلا عائلة.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  /* M2 slice 72: the patient inside the scope (404 like missing); family members inside
     it; money only with finance.patient-ledger.view. */
  const { id } = await params;
  const canonical = await canonicalFamilyRoute(null, handle => {
    const patientId = idOf(id);
    if (!patientId) return Promise.reject(new CanonicalFamilyRefusal("invalid_family", 400, "رقم المريض غير صالح."));
    return readCanonicalPatientFamily(handle, patientId);
  }, "تعذّر تحميل عائلة المريض.");
  if (canonical) return canonical;
  const session = await requireSession();
  if (!session) return json("انتهت الجلسة. سجّل الدخول من جديد.", 401);
  const patientId = idOf(id);
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
