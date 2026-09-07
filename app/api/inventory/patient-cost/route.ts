import { NextResponse } from "next/server";
import { issuedCostForPatient } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * تكلفة المواد المشتقّة لما صُرف على مريض — لربحية الحالة.
 *
 * تحلّ محلّ الإدخال اليدوي الذي كان يقوم به المستخدم من ذاكرته: الرقم الآن من
 * حركات المخزون نفسها بالمتوسّط المرجّح لحظة كل صرف. وتبقى إمكانية التعديل
 * اليدوي في الشاشة — رقمٌ يُقرأ ويُصحّح لا رقمٌ يُخمَّن من الصفر.
 */
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const patientId = Number(new URL(request.url).searchParams.get("patientId"));
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });
  }
  if (!(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "غير مصرّح لك بالوصول لهذا الملف." }, { status: 403 });
  }
  try {
    return NextResponse.json(await issuedCostForPatient(patientId));
  } catch {
    return NextResponse.json({ message: "تعذّر حساب تكلفة المواد." }, { status: 500 });
  }
}
