import { NextResponse } from "next/server";
import { duplicateCephAnalysis, getCephStudy } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

/**
 * «تصحيح هذه الدراسة»: مسودة تصحيح عن تحليل معتمد.
 *
 * طريقُ التعديل الوحيد بعد الاعتماد: المعتمد يبقى كما خُتم، والنسخة مسودةٌ جديدة
 * على الشععة نفسها بمعالمها ومعايرتها وهوية الدراسة (الحالة والمرحلة والتاريخ والجهاز والمرجع) ورابط أصلها
 * `corrects_analysis_id` — يعدّل الطبيب ما غيّره ثم يعتمد من جديد. وبهذا يبقى في السجل تاريخٌ كامل: ما قيل أولًا،
 * وما قيل بعده، ومن قال. هذا غير «إضافة دراسة متابعة» (دراسة جديدة بمرحلتها وتاريخها الفعليين).
 * تكرار الطلب لأصلٍ له مسودة تصحيح مفتوحة يعيدها نفسها (200) ولا ينشئ ثانية.
 */

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const { id: raw } = await context.params;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم التحليل غير صالح." }, { status: 400 });
  }

  const study = await getCephStudy(id);
  if (!study) {
    return NextResponse.json({ message: "التحليل غير موجود." }, { status: 404 });
  }
  if (!(await canAccessPatient(session, study.analysis.patientId, "canUploadXrays"))) {
    return NextResponse.json({ message: "غير مصرّح لك بفتح نسخة عن هذا التحليل." }, { status: 403 });
  }

  try {
    const created = await duplicateCephAnalysis(id, session.username);
    if (!created.ok) return NextResponse.json({ message: created.message }, { status: 409 });
    return NextResponse.json({ id: created.id, replayed: created.replayed }, { status: created.replayed ? 200 : 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر فتح نسخة التصحيح." }, { status: 500 });
  }
}
