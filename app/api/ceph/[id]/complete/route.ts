import { NextResponse } from "next/server";
import { completeCephAnalysis, getCephStudy } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

/**
 * اعتماد التحليل السيفالومتري.
 *
 * هذا هو القرار السريري في الوحدة كلها — ولذلك هو مسارٌ وحده: التوقيع هنا يختم
 * القياسات لقطةً ويقفل التحليل، ولا يمرّ إلا بشروطه (معايرة، معالم كاملة، توقيع
 * صاحب الجلسة). وقاعدة الدستور تحرسه من الجهة الأخرى أيضًا: لا اقتراحٌ حاسوبيّ
 * يُعتمد تلقائيًا — الاعتماد طلبٌ صريح بيد الطبيب لا حدثٌ جانبي.
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
    return NextResponse.json({ message: "غير مصرّح لك باعتماد هذا التحليل." }, { status: 403 });
  }

  try {
    const done = await completeCephAnalysis(id, session.username);
    if (!done.ok) {
      // الشروط ناقصة أمرٌ متوقّع لا عطل — رسالته تُعرض كما هي.
      return NextResponse.json({ message: done.message ?? "لا يمكن الاعتماد." }, { status: 409 });
    }
    return NextResponse.json({
      ok: true,
      measurements: done.measurements,
      summary: done.summary,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر اعتماد التحليل." }, { status: 500 });
  }
}
