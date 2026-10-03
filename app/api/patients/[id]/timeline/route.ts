import { NextResponse } from "next/server";
import { patientTimeline } from "@/lib/db";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { canViewPlanItems } from "@/lib/case-route";
import { resolveAppointmentReadScope } from "@/lib/appointment-read-access";
import { patientTimelineSources, projectPatientTimeline, type PatientTimelineReadScope } from "@/lib/patient-timeline-read";

export const dynamic = "force-dynamic";

const idFrom = async (context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 ? value : null;
};

/**
 * الخط الزمني الموحَّد (§٢٩-٣٠): كل أحداث المريض من كل مصادرها في خطٍّ واحد.
 *
 * تُحذف مصادر الخطط والمستندات والمال غير المصرّح بها قبل حدود القراءة،
 * وتُقرأ المواعيد ضمن نطاق التقويم نفسه. لا تمنح هذه القراءة الطبيب صلاحية مالية جديدة.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const patientId = await idFrom(context);
  if (!patientId) return NextResponse.json({ message: "رقم ملف غير صالح." }, { status: 400 });

  // عزل الطبيب (§٣٩): مرضاه فقط — والفحص في الخادم بشكل قاطع.
  if (!(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "هذا الملف ليس من مرضاك." }, { status: 403 });
  }

  const limitRaw = Number(new URL(request.url).searchParams.get("limit") ?? 60);
  const limit = Number.isFinite(limitRaw) ? Math.max(10, Math.min(200, limitRaw)) : 60;

  try {
    const [plans, documents, appointments] = await Promise.all([
      canViewPlanItems(session, patientId),
      canAccessPatient(session, patientId, "canViewXrays"),
      resolveAppointmentReadScope(session, [patientId]),
    ]);
    // Deliberately retain the timeline's existing gate, not the broader workflow
    // doctor setting or ledger policy. Denied monetary metadata is omitted too.
    const scope: PatientTimelineReadScope = { plans, documents, appointments, financial: canHandleMoney(session.role) };
    const sources = patientTimelineSources(scope, patientId);
    const events = projectPatientTimeline(await patientTimeline(patientId, limit, scope), patientId, sources);
    return NextResponse.json({ patientId, events, sources, canSeeFinancial: sources.financial });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الخط الزمني." }, { status: 500 });
  }
}
