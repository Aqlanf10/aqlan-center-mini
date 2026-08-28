import { NextResponse } from "next/server";
import { chairCount } from "@/lib/settings";
import {
  CLINIC_TIME_ZONE,
  getSettings,
  listAppointmentsByDate,
  listLabOrders,
  listVisitsByDate,
} from "@/lib/db";
import { dayReport, tomorrowLoad } from "@/lib/report";
import { labSummary } from "@/lib/lab";
import { addDays, clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  if (!(await requireSession())) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const requested = new URL(request.url).searchParams.get("date") ?? today;
  const date = DATE_PATTERN.test(requested) ? requested : today;
  const next = addDays(date, 1);

  try {
    const chairs = chairCount(await getSettings());
    const [visits, appointments, nextDay, labOrders] = await Promise.all([
      listVisitsByDate(date),
      listAppointmentsByDate(date),
      listAppointmentsByDate(next),
      listLabOrders(),
    ]);

    return NextResponse.json({
      date,
      nextDate: next,
      report: dayReport(visits, appointments, new Date()),
      tomorrow: tomorrowLoad(nextDay, next, chairs),
      lab: labSummary(labOrders, today),
      chairs,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل التقرير." }, { status: 500 });
  }
}
