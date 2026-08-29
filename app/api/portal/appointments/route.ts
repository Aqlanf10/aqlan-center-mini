import { NextResponse } from "next/server";
import { portalUpcomingAppointments } from "@/lib/db";
import { requirePortalSession } from "@/lib/portal-server";
import { clinicDateString } from "@/lib/schedule";
import { CLINIC_TIME_ZONE } from "@/lib/db";

export const dynamic = "force-dynamic";

/** مواعيد المريض القادمة — بتوقيت العيادة، ومعرّفها من الجلسة لا الطلب. */
export async function GET() {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى البوابة." }, { status: 401 });
  }
  try {
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const appointments = await portalUpcomingAppointments(session.patientId, today);
    return NextResponse.json({ today, appointments });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المواعيد." }, { status: 500 });
  }
}
