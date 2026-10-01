import { NextResponse } from "next/server";
import { arrivalPanel, cashierArrivalProjection } from "@/lib/arrival-panel-db";
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
  /* الكاشير بلا «كشف حساب المريض» لا يرى أرصدته من هنا أيضًا — الحدّ نفسه في الباب وفي المسار. */
  const cashier = session.role === "cashier";
  if (cashier && session.financeAccess && !session.financeAccess.viewPatientLedger) {
    return NextResponse.json({ message: "لا تملك صلاحية عرض أرصدة المرضى." }, { status: 403 });
  }
  try {
    const includeMoney = desk || await canViewPatientMoney(session, patientId);
    const panel = await arrivalPanel(patientId, { includeMoney });
    if (!panel) return NextResponse.json({ message: "المريض غير موجود." }, { status: 404 });
    /* الرؤية ليست تحصيلًا: الطبيب لا يقبض، والكاشير الممنوع من التحصيل لا تظهر له أزراره. */
    const canCollect = desk && includeMoney && (!cashier || session.financeAccess?.collectPayments !== false);
    const body = { ...(cashier ? cashierArrivalProjection(panel) : panel), canCollect };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل لوحة الوصول." }, { status: 500 });
  }
}
