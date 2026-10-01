import { NextResponse } from "next/server";
import { patientLegacyOnboarding } from "@/lib/legacy-onboarding-db";
import { canAccessPatient } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** (P1-A) قائمة تهيئة مريض التقويم السابق — قراءةٌ فقط، بلا مبالغ. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  const patientId = Number((await context.params).id);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  }
  if (!(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "هذا الملف ليس من مرضاك." }, { status: 403 });
  }
  try {
    return NextResponse.json({ onboarding: await patientLegacyOnboarding(patientId) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل تهيئة الحالة السابقة." }, { status: 500 });
  }
}
