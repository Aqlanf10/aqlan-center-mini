import { NextResponse } from "next/server";
import { visitMaterialMovements, visitPatientOf } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (P4) المواد المصروفة على الزيارة — قراءةٌ فقط من inventory_movements.
 * التلقائية (ربط الخدمة بالمادة عند التوقيع) واليدوية (يسجلها الطبيب عبر حركة الصرف القائمة
 * `POST /api/inventory/[id]/movements` بـ visitId) — لا جدول موادٍ ثانٍ.
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
    if (!visit) {
      return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404 });
    }
    /* كقراءة الزيارة نفسها: زيارة مريضٍ ليس من مرضى الطبيب لا تُفتح، والزيارة الحرّة مفتوحة. */
    if (visit.patientId !== null && !(await canAccessPatient(session, visit.patientId))) {
      return NextResponse.json({ message: "غير مصرّح لك بالاطلاع على مواد هذه الزيارة." }, { status: 403 });
    }
    return NextResponse.json({ patientId: visit.patientId, lines: await visitMaterialMovements(visitId) });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل مواد الزيارة." }, { status: 500 });
  }
}
