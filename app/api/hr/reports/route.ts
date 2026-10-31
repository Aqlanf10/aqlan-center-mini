import { NextResponse } from "next/server";
import { NO_STORE } from "@/lib/canonical-patient-http";
import { hrReportsGetCanonicalResponse } from "@/lib/canonical-hr";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { canManageStaff } from "@/lib/hr";
import { getHrReportSummary } from "@/lib/hr-payroll";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
const forbidden = () =>
  NextResponse.json({ message: "تقارير الموارد البشرية للمدير وحده." }, { status: 403 });

export async function GET() {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return denied();
  if (selected.kind === "canonical") return hrReportsGetCanonicalResponse(selected.handle);

  const session = await requireSession();
  if (!session) return denied();
  if (!canManageStaff(session.role)) return forbidden();

  try {
    const report = await getHrReportSummary();
    return NextResponse.json(report);
  } catch (error) {
    console.error("Failed to generate HR reports:", error);
    return NextResponse.json({ message: "تعذّر استخراج تقارير الموارد البشرية." }, { status: 500 });
  }
}
