import { NextResponse } from "next/server";
import { patientLegacyHistory } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (P1-5ج) سجل النظام القديم لمريض — معالجاته ودفعاته كما كانت، للقراءة.
 * حارس الملف نفسه: من لا يصل ملف المريض لا يصل سجله.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  const id = Number((await context.params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  if (!(await canAccessPatient(session, id))) return NextResponse.json({ message: "الملف غير موجود." }, { status: 404 });
  try {
    return NextResponse.json(await patientLegacyHistory(id));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل سجل النظام القديم." }, { status: 500 });
  }
}
