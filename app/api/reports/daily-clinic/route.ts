import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { getDailyClinicReportToday, loadDailyClinicReport } from "@/lib/daily-clinic-report";
import { isDailyClinicReportDate } from "@/lib/daily-clinic-report-model";

export const dynamic = "force-dynamic";

const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  "Pragma": "no-cache",
  "Vary": "Cookie, Authorization",
};

/** This combines clinical and financial details. Broader financial privileges
 * do not grant access: authorize the current authenticated admin first. */
export async function GET(request: Request) {
  try {
    const session = await requireSession();
    if (!session) {
      return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers });
    }
    if (session.role !== "admin") {
      return NextResponse.json({ message: "كشف إقفال اليوم متاح للمدير فقط." }, { status: 403, headers });
    }
    const dates = new URL(request.url).searchParams.getAll("date");
    const date = dates.length === 0 ? getDailyClinicReportToday() : dates[0];
    if (dates.length > 1 || !isDailyClinicReportDate(date)) {
      return NextResponse.json({ message: "اختر تاريخًا صحيحًا بصيغة YYYY-MM-DD." }, { status: 400, headers });
    }
    return NextResponse.json(await loadDailyClinicReport(date), { headers });
  } catch {
    // Integrity diagnostics can contain patient/financial evidence. Never
    // serialize an exception, SQL or partial financial report to the browser.
    return NextResponse.json({ message: "تعذّر إعداد كشف إقفال اليوم. أعد المحاولة." }, { status: 500, headers });
  }
}
