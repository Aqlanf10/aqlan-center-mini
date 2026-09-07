import { NextResponse } from "next/server";
import { getCephAnalysisForCompare } from "@/lib/db";
import { chronologicalOrder } from "@/lib/cephCompare";
import { referenceLines, superimposeOnSN } from "@/lib/cephSuperimpose";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

/**
 * تراكب تحليلين — الأقدم تبقى مكانها والأحدث تُنقل إليها.
 * (من مستودع الوكيل الآخر، معاد كتابته لإحداثياتنا: بكسل + ملم/بكسل.)
 *
 * والترتيب هو ترتيب المقارنة نفسه (`chronologicalOrder`)، فلا يقول الجدول
 * شيئًا ويقول الرسم غيره. ومصدرٌ واحد للترتيب لا اثنان.
 */
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role) && session.role !== "doctor") {
    return NextResponse.json({ message: "التحليل السيفالومتري للطبيب والمدير." }, { status: 403 });
  }

  const url = new URL(request.url);
  const first = Number(url.searchParams.get("first"));
  const second = Number(url.searchParams.get("second"));
  if (!Number.isInteger(first) || first <= 0 || !Number.isInteger(second) || second <= 0) {
    return NextResponse.json({ message: "اختر تحليلين للتراكب." }, { status: 400 });
  }
  if (first === second) {
    return NextResponse.json({ message: "التحليلان واحد — اختر آخر." }, { status: 400 });
  }

  try {
    const [one, two] = await Promise.all([getCephAnalysisForCompare(first), getCephAnalysisForCompare(second)]);
    if (!one || !two) {
      return NextResponse.json({ message: "أحد التحليلين غير موجود." }, { status: 404 });
    }
    if (one.patientId !== two.patientId) {
      return NextResponse.json({ message: "التحليلان لمريضين مختلفين." }, { status: 400 });
    }
    if (!(await canAccessPatient(session, one.patientId, "canViewXrays"))) {
      return NextResponse.json({ message: "غير مصرّح لك بتراكب تحليلات هذا المريض." }, { status: 403 });
    }

    const [before, after] = chronologicalOrder(one, two);

    const placed = superimposeOnSN(
      { points: before.points, mmPerPixel: before.mmPerPixel },
      { points: after.points, mmPerPixel: after.mmPerPixel },
    );
    if (!placed.ok) {
      // ٤٠٩ لا ٤٠٠: الطلب سليم والبيانات هي التي لا تكفي — والرسالة تقول ما يُفعل.
      return NextResponse.json({ message: placed.message }, { status: 409 });
    }

    return NextResponse.json({
      before: {
        id: before.id, phase: before.phase, xrayDate: before.xrayDate,
        documentId: before.documentId,
        documentWidth: before.documentWidth, documentHeight: before.documentHeight,
        lines: referenceLines(before.points),
      },
      after: {
        id: after.id, phase: after.phase, xrayDate: after.xrayDate,
        documentId: after.documentId,
        // معالمُ الأحدث منقولةً إلى فضاء الأقدم — تُرسم على صورتها.
        lines: referenceLines(placed.value.points),
      },
      rotationDegrees: placed.value.rotationDegrees,
      cranialBaseBefore: placed.value.cranialBaseBefore,
      cranialBaseAfter: placed.value.cranialBaseAfter,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر التراكب." }, { status: 500 });
  }
}
