import { NextResponse } from "next/server";
import { arrivalPanel } from "@/lib/arrival-panel-db";
import { canAccessPatient, canViewPatientMoney } from "@/lib/patient-access";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (P0-D) لوحة الوصول المالية — قراءةٌ فقط. للاستقبال والمدير والكاشير (من يقبض)، وللطبيب على مرضاه
 * فقط وبلا مال إلا بصلاحية «مدفوعات مرضاي». الدفع لا يُحجب به دخولٌ ولا نداء.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  const patientId = Number((await context.params).id);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  }
  const desk = canHandleMoney(session.role);
  if (!desk && !(session.role === "doctor" && await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "لوحة الوصول للاستقبال والصندوق — وللطبيب على مرضاه." }, { status: 403 });
  }
  try {
    const includeMoney = desk || await canViewPatientMoney(session, patientId);
    const panel = await arrivalPanel(patientId, { includeMoney });
    if (!panel) return NextResponse.json({ message: "المريض غير موجود." }, { status: 404 });
    return NextResponse.json(panel, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل لوحة الوصول." }, { status: 500 });
  }
}
