import { NextResponse } from "next/server";
import { listPatientPrescriptions, prescribedBefore } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * وصفات المريض واقتراحاتها — للطبيب والمدير.
 *
 * تاريخ وصفاته الفاعلة والمبطلة، وأدويةٌ سبق أن وُصفت له تُقترح فيقلّ النقر
 * ولا تُفرض: التكرار الإداري المريح ليس قرارًا سريريًّا.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role) && session.role !== "doctor") {
    return NextResponse.json({ message: "الوصفات للطبيب والمدير." }, { status: 403 });
  }

  const { id: rawId } = await context.params;
  const patientId = Number(rawId);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });
  }
  if (!(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "غير مصرّح لك بالوصول إلى وصفات هذا المريض." }, { status: 403 });
  }

  try {
    const [prescriptions, suggestions] = await Promise.all([
      listPatientPrescriptions(patientId),
      prescribedBefore(patientId),
    ]);
    return NextResponse.json({ prescriptions, suggestions });
  } catch {
    return NextResponse.json({ message: "تعذّرت قراءة الوصفات." }, { status: 500 });
  }
}
