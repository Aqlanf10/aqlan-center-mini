import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, financeSummary, findUserByUsername } from "@/lib/db";
import { clinicDateString } from "@/lib/schedule";
import { financeReportAccess, projectFinanceSummary } from "@/lib/finance-report-visibility";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const user = session.role === "doctor"
    ? await findUserByUsername(session.username).catch(() => null)
    : null;
  const access = financeReportAccess(session.role, user?.permissions, session.financeAccess);
  if (!access.revenue) {
    return NextResponse.json(
      { message: "لا تملك صلاحية عرض إيرادات المركز العامة." },
      { status: 403 },
    );
  }

  const params = new URL(request.url).searchParams;
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const from = DATE_PATTERN.test(params.get("from") ?? "") ? params.get("from")! : today;
  const to = DATE_PATTERN.test(params.get("to") ?? "") ? params.get("to")! : today;
  // مدى مقلوب يعطي تقريرًا فارغًا يبدو كيوم بلا دخل — يُصحَّح لا يُقبل.
  const [start, end] = from <= to ? [from, to] : [to, from];

  try {
    return NextResponse.json(projectFinanceSummary(await financeSummary(start, end), access));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل التقرير." }, { status: 500 });
  }
}
