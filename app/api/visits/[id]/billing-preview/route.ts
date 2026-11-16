import { NextResponse } from "next/server";
import { ClinicalPlanConflict, previewVisitBilling, visitPatientOf } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { readCanonicalVisitBillingPreview } from "@/lib/canonical-visit-money";

export const dynamic = "force-dynamic";

/**
 * (P6) معاينة استحقاق الزيارة — قراءةٌ فقط، بقرار التوقيع نفسه على الإجراءات المحفوظة.
 * لا يقبل مدخلًا يغيّر المبلغ: الصفر يأتي من قواعد الفوترة وحدها.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  // M2 slice 89 (owner decisions G4-1, G4-4, G4-6): the groups by grant, one snapshot.
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try { return NextResponse.json(await readCanonicalVisitBillingPreview(selected.handle, (await context.params).id), { headers: NO_STORE }); }
    catch (error) { return canonicalPatientReadFailure(error, "تعذّر حساب معاينة الاستحقاق."); }
  }
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  const visitId = Number((await context.params).id);
  if (!Number.isInteger(visitId) || visitId <= 0) {
    return NextResponse.json({ message: "رقم الزيارة غير صالح." }, { status: 400 });
  }
  try {
    const visit = await visitPatientOf(visitId);
    if (!visit) return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404 });
    if (visit.patientId !== null && !(await canAccessPatient(session, visit.patientId))) {
      return NextResponse.json({ message: "هذه زيارة مريضٍ ليس من مرضاك." }, { status: 403 });
    }
    const preview = await previewVisitBilling(visitId);
    if (!preview) return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404 });
    return NextResponse.json(preview, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ClinicalPlanConflict) {
      return NextResponse.json({ message: "بند الخطة المرتبط تغيّر — أعد تحميل الزيارة." }, { status: 409 });
    }
    return NextResponse.json({ message: "تعذّر حساب معاينة الاستحقاق." }, { status: 500 });
  }
}
