import { NextResponse } from "next/server";
import { ClinicalPlanConflict, previewVisitBilling, visitPatientOf } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (P6) معاينة استحقاق الزيارة — قراءةٌ فقط، بقرار التوقيع نفسه على الإجراءات المحفوظة.
 * لا يقبل مدخلًا يغيّر المبلغ: الصفر يأتي من قواعد الفوترة وحدها.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
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
