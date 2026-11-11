import { NextResponse } from "next/server";
import { chairCount } from "@/lib/settings";
import {
  CLINIC_TIME_ZONE,
  doctorOwnedPatientIds,
  getSettings,
  listAppointmentsByDate,
  labCounts,
  listVisitsByDate,
  todayPlannedVisits,
} from "@/lib/db";
import { resolveRestrictedDoctorScope } from "@/lib/patient-access";
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
    const scope = await resolveRestrictedDoctorScope(session);
    const scopeFilter = scope.restricted
      ? { doctorPartyId: scope.doctorPartyId, blockAllPatients: scope.blockAllPatients }
      : undefined;
    const settings = await getSettings();
    const chairs = chairCount(settings);
    const [visits, rawAppointments, rawNextDay, lab, plannedToday] = await Promise.all([
      listVisitsByDate(date, scopeFilter),
      listAppointmentsByDate(date),
      listAppointmentsByDate(next),
      labCounts({ mode: "workflow", today }, scopeFilter),
      /*
       * لوحة اليوم (§٢٦): ما المخطَّط لهذا اليوم — زيارات مخطَّطة مجدولة، وبنود
       * «مخطَّط لليوم» من الخطط النشطة. مدخلٌ واحد يفتح منه الطبيب عمل يومه.
       * والطبيب المربوط يرى لوحته هو (§٣٩).
       */
      scope.blockAllPatients
        ? Promise.resolve([])
        : todayPlannedVisits(
            date,
            scope.restricted
              ? scope.doctorPartyId
              : (session.role === "doctor" && typeof session.partyId === "number" && session.partyId > 0
                ? session.partyId
                : null),
          ),
    ]);
    let appointments = rawAppointments;
    let nextDay = rawNextDay;
    if (scope.restricted) {
      if (scope.blockAllPatients || !scope.doctorPartyId) {
        appointments = [];
        nextDay = [];
      } else {
        const candidateIds = Array.from(new Set([...rawAppointments, ...rawNextDay].map((a) => a.patientId)));
        const owned = await doctorOwnedPatientIds(scope.doctorPartyId, candidateIds);
        appointments = rawAppointments.filter((a) => a.doctorId === scope.doctorPartyId || owned.has(a.patientId));
        nextDay = rawNextDay.filter((a) => a.doctorId === scope.doctorPartyId || owned.has(a.patientId));
      }
    }

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
