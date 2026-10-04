import { NextResponse } from "next/server";
import { chairCount } from "@/lib/settings";
import {
  CLINIC_TIME_ZONE,
  getSettings,
  listAppointmentsByDate,
  labCounts,
  listVisitsByDate,
  todayPlannedVisits,
} from "@/lib/db";
import { dayReport, tomorrowLoad } from "@/lib/report";
import { addDays, clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const requested = new URL(request.url).searchParams.get("date") ?? today;
  const date = DATE_PATTERN.test(requested) ? requested : today;
  const next = addDays(date, 1);

  try {
    const settings = await getSettings();
    const chairs = chairCount(settings);
    const [visits, appointments, nextDay, lab, plannedToday] = await Promise.all([
      listVisitsByDate(date),
      listAppointmentsByDate(date),
      listAppointmentsByDate(next),
      labCounts({ mode: "workflow", today }),
      /*
       * لوحة اليوم (§٢٦): ما المخطَّط لهذا اليوم — زيارات مخطَّطة مجدولة، وبنود
       * «مخطَّط لليوم» من الخطط النشطة. مدخلٌ واحد يفتح منه الطبيب عمل يومه.
       * والطبيب المربوط يرى لوحته هو (§٣٩).
       */
      todayPlannedVisits(
        date,
        session.role === "doctor" && typeof session.partyId === "number" && session.partyId > 0
          ? session.partyId
          : null,
      ),
    ]);

    return NextResponse.json({
      date,
      nextDate: next,
      report: dayReport(visits, appointments, new Date()),
      /* الحمل يُقاس بساعات المركز المُهيَّأة — لا بيومٍ مفترض. */
      tomorrow: tomorrowLoad(
        nextDay, next, chairs,
        settings["clinic.day_start"], settings["clinic.day_end"],
      ),
      lab,
      chairs,
      plannedToday,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل التقرير." }, { status: 500 });
  }
}
