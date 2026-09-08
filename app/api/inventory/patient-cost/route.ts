import { NextResponse } from "next/server";
import { findUserByUsername, issuedCostForPatient } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { canDoctorViewCostPrices } from "@/lib/doctor-permissions";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * تكلفة المواد المشتقّة لما صُرف على مريض — لربحية الحالة.
 *
 * تحلّ محلّ الإدخال اليدوي الذي كان يقوم به المستخدم من ذاكرته: الرقم الآن من
 * حركات المخزون نفسها بالمتوسّط المرجّح لحظة كل صرف. وتبقى إمكانية التعديل
 * اليدوي في الشاشة — رقمٌ يُقرأ ويُصحّح لا رقمٌ يُخمَّن من الصفر.
 *
 * والمال المخفي يبقى مخفيًا (P0.13): التكلفة بالوحدة والربحية من «المالية
 * المخفية» — تُحجب قيمتها عن الطبيب ما لم يصرّح له المدير (سياسة أسعار
 * التكلفة نفسها التي يحكمها مسار المعمل). الكميات والتواريخ تبقى: مسار
 * العمل سريري.
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

  /* حجب قيمة التكلفة عن الطبيب بلا منحٍ صريحة — الكمية تبقى، القيمة لا. */
  let maskCost = false;
  if (session.role === "doctor") {
    const user = await findUserByUsername(session.username).catch(() => null);
    if (!canDoctorViewCostPrices(user?.permissions, session.role)) maskCost = true;
  }

  try {
    const result = await issuedCostForPatient(patientId);
    if (maskCost) {
      return NextResponse.json({
        issuedCount: result.issuedCount,
        firstIssuedAt: result.firstIssuedAt,
        materialCostMinor: null,
        costHidden: true,
      });
    }
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ message: "تعذّر حساب تكلفة المواد." }, { status: 500 });
  }
}
