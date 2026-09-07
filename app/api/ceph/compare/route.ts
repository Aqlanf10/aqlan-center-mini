import { NextResponse } from "next/server";
import { getCephAnalysisForCompare } from "@/lib/db";
import { compareAnalyses, comparisonSummary, chronologicalOrder } from "@/lib/cephCompare";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

/**
 * مقارنة تحليلين سيفالومتريين. (من مستودع الوكيل الآخر، مكيّفة لأنواعنا.)
 *
 * والترتيب يُفرض هنا لا يُترك للمستدعي: الأقدم «قبل» والأحدث «بعد» — وقلبُهما
 * يقلب كل إشارة وكل حكم، فيُقرأ تراجعٌ على أنه تحسّن. والشاشة تعرض تاريخ كلٍّ
 * منهما بعد ذلك صراحةً.
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
    return NextResponse.json({ message: "اختر تحليلين للمقارنة." }, { status: 400 });
  }
  if (first === second) {
    return NextResponse.json({ message: "التحليلان واحد — اختر آخر." }, { status: 400 });
  }

  try {
    const [one, two] = await Promise.all([getCephAnalysisForCompare(first), getCephAnalysisForCompare(second)]);
    if (!one || !two) {
      return NextResponse.json({ message: "أحد التحليلين غير موجود." }, { status: 404 });
    }
    // مريضان مختلفان: مقارنةٌ بلا معنى، وخطأٌ لا يُكتشف إلا بعد أن يُبنى عليه.
    if (one.patientId !== two.patientId) {
      return NextResponse.json({ message: "التحليلان لمريضين مختلفين." }, { status: 400 });
    }
    // عزل بيانات الأطباء: المقارنة سريرية على ملفٍ يملكه الطبيب أو يُسمح له به.
    if (!(await canAccessPatient(session, one.patientId, "canViewXrays"))) {
      return NextResponse.json({ message: "غير مصرّح لك بمقارنة تحليلات هذا المريض." }, { status: 403 });
    }

    const [before, after] = chronologicalOrder(one, two);
    const comparison = compareAnalyses(before.measurements, after.measurements);
    return NextResponse.json({
      before,
      after,
      comparison,
      summary: comparisonSummary(comparison),
    });
  } catch {
    return NextResponse.json({ message: "تعذّرت المقارنة." }, { status: 500 });
  }
}
