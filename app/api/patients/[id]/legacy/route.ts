import { NextResponse } from "next/server";
import { patientLegacyHistory } from "@/lib/db";
import { canAccessPatient, canViewPatientMoney } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (P1-5ج) سجل النظام القديم لمريض — معالجاته ودفعاته كما كانت، للقراءة.
 * حارس الملف مع صلاحية قراءة ماله: الأرشيف يحتوي مبالغ حتى لو كان مسدّدًا بالكامل.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  const id = Number((await context.params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  if (!(await canAccessPatient(session, id))) return NextResponse.json({ message: "الملف غير موجود." }, { status: 404 });
  if (!(await canViewPatientMoney(session, id))) {
    return NextResponse.json({ message: "غير مصرّح لك بالاطلاع على السجل المالي السابق لهذا المريض." }, { status: 403 });
  }
  try {
    return NextResponse.json(await patientLegacyHistory(id));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل سجل النظام القديم." }, { status: 500 });
  }
}
