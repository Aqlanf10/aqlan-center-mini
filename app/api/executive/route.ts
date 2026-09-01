import { NextResponse } from "next/server";
import { executiveKpis, CLINIC_TIME_ZONE, findUserByUsername } from "@/lib/db";
import { executiveCsv } from "@/lib/executive";
import { exportFileName } from "@/lib/csv";
import { isAdmin } from "@/lib/roles";
import { canDoctorViewClinicProfits } from "@/lib/doctor-permissions";
import { requireSession } from "@/lib/session";
import { clinicDateString } from "@/lib/schedule";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/**
 * غرفة القيادة — للمدير وحده (أو الطبيب المصرّح له بمؤشرات الأرباح).
 *
 * هذه الشاشة تكشف ربح العيادة ودخلها وذممها، وهي محجوبة افتراضيًا عن الأطباء
 * ضمن ميزة «المالية المخفية» (صلاحيات الوكيل المساعد) — تُفتح بتصريح المدير
 * الصريح، وللاستقبال تبقى مقفلة كما كانت.
 */
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (session.role === "doctor") {
    const user = await findUserByUsername(session.username).catch(() => null);
    if (!canDoctorViewClinicProfits(user?.permissions, session.role)) {
      return NextResponse.json(
        { message: "مؤشرات الأرباح العامة وصافي الدخل مخفية بحسب سياسة المالية المخفية." },
        { status: 403 },
      );
    }
  } else if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "غرفة القيادة للمدير وحده." }, { status: 403 });
  }

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const params = new URL(request.url).searchParams;
  const requestedFrom = params.get("from") ?? "";
  const requestedTo = params.get("to") ?? "";
  const from = DATE_PATTERN.test(requestedFrom) ? requestedFrom : `${today.slice(0, 7)}-01`;
  const to = DATE_PATTERN.test(requestedTo) ? requestedTo : today;

  try {
    const kpis = await executiveKpis(from, to);
    // مركز التقارير الموحّد: التصدير لا يستعلم عن شيء — يُسطّر الكائن نفسه الذي
    // تقرأه الشاشة، فتضارب شاشةٍ مع تقريرٍ مستحيل بالبناء.
    if (params.get("format") === "csv") {
      return new NextResponse("\uFEFF" + executiveCsv(kpis), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${exportFileName("executive", from, to)}"`,
        },
      });
    }
    return NextResponse.json(kpis);
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل مؤشرات القيادة." }, { status: 500 });
  }
}
