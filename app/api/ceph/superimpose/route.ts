import { NextResponse } from "next/server";
import { getCephAnalysisForCompare } from "@/lib/db";
import { resolveCephComparisonOrder, cephComparisonUrlParams, CEPH_ORDER_REQUIRED_NOTICE } from "@/lib/cephCompare";
import { referenceLines, superimposeOnSN } from "@/lib/cephSuperimpose";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

/** Compare only after acquisition chronology or a deliberate reference resolves direction. */
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role) && session.role !== "doctor") {
    return NextResponse.json({ message: "التحليل السيفالومتري للطبيب والمدير." }, { status: 403 });
  }

  const url = new URL(request.url);
  const query = cephComparisonUrlParams(url.searchParams);
  if (!query) return NextResponse.json({ message: "اختر تحليلين مختلفين ومرجعًا صالحًا للمقارنة." }, { status: 400 });
  const { first, second, referenceId } = query;

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

    if (one.comparisonUnavailableReason || two.comparisonUnavailableReason) {
      return NextResponse.json({ message: one.comparisonUnavailableReason ?? two.comparisonUnavailableReason }, { status: 409 });
    }
    const order = resolveCephComparisonOrder(one, two, referenceId);
    if (order.state === "invalid") return NextResponse.json({ message: "اختيار المرجع لا يتوافق مع تاريخي التصوير. أعد فتح المقارنة دون اختيار مرجع." }, { status: 400 });
    if (order.state === "unresolved") return NextResponse.json({ code: "CEPH_ORDER_REQUIRED", message: CEPH_ORDER_REQUIRED_NOTICE, reason: order.reason,
      choices: [one, two].map(study => ({ id: study.id, xrayDate: study.xrayDate })) }, { status: 409 });
    const { before, after, ordering } = order;

    const placed = superimposeOnSN(
      { points: before.points, mmPerPixel: before.mmPerPixel },
      { points: after.points, mmPerPixel: after.mmPerPixel },
    );
    if (!placed.ok) {
      // ٤٠٩ لا ٤٠٠: الطلب سليم والبيانات هي التي لا تكفي — والرسالة تقول ما يُفعل.
      return NextResponse.json({ message: placed.message }, { status: 409 });
    }

    return NextResponse.json({
      ordering,
      before: {
        id: before.id, phase: before.phase, xrayDate: before.xrayDate,
        documentId: before.documentId,
        projectionSha256: before.projectionSha256,
        status: before.status, provenanceState: before.provenanceState, imageSha256: before.imageSha256,
        documentWidth: before.documentWidth, documentHeight: before.documentHeight,
        lines: referenceLines(before.points),
      },
      after: {
        id: after.id, phase: after.phase, xrayDate: after.xrayDate,
        documentId: after.documentId,
        projectionSha256: after.projectionSha256,
        status: after.status, provenanceState: after.provenanceState, imageSha256: after.imageSha256,
        // Comparison landmarks transformed into the resolved reference image space.
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
