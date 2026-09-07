import { NextResponse } from "next/server";
import { savePrescription } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { checkPrescriptionDraft } from "@/lib/prescription";

export const dynamic = "force-dynamic";

/**
 * إصدار وصفة كوثيقة محفوظة. (من مستودع الوكيل الآخر.)
 *
 * الوصفة وثيقةٌ لا شاشة: يحملها المريض إلى صيدليٍّ يصرف بها دواءً، ويرجع إليها
 * الطبيب بعد شهرٍ ليعرف بماذا عالج. فما يُطبع منها يجب أن يكون محفوظًا كما طُبع،
 * منسوبًا إلى من أصدره، وبتاريخه.
 */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  /* الوصفات للطبيب والمدير: من لا يصف لا يصدر وثيقة صرف دواء باسم المركز. */
  if (!isAdmin(session.role) && session.role !== "doctor") {
    return NextResponse.json({ message: "الوصفات للطبيب والمدير." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const patientId = Number(body.patientId);
  const rawVisit = Number(body.visitId);
  const visitId = Number.isInteger(rawVisit) && rawVisit > 0 ? rawVisit : null;
  const draft = checkPrescriptionDraft({
    patientId,
    visitId,
    diagnosis: body.diagnosis,
    notes: body.notes,
    instructionsLang: body.instructionsLang,
    items: body.items,
  });
  if (!draft.ok) {
    return NextResponse.json({ message: draft.message }, { status: 400 });
  }

  if (!(await canAccessPatient(session, draft.value.patientId))) {
    return NextResponse.json({ message: "غير مصرّح لك بإصدار وصفة لهذا المريض." }, { status: 403 });
  }

  try {
    const record = await savePrescription(draft.value, session.username);
    return NextResponse.json({ id: record.id, createdAt: record.createdAt }, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الوصفة." }, { status: 500 });
  }
}
