import { NextResponse } from "next/server";
import { getPortalAppointmentsBundle } from "@/lib/portal-data";
import { requirePortalSession } from "@/lib/portal-server";
import { readPortalSettings } from "@/lib/portal-settings";

export const dynamic = "force-dynamic";

/** مواعيد المريض القادمة وسجل مواعيده السابقة — بتوقيت العيادة، ومعرّفها من الجلسة لا الطلب. */
export async function GET() {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى البوابة." }, { status: 401 });
  }
  try {
    const settings = await readPortalSettings();
    if (!settings.showAppointments) {
      return NextResponse.json(
        { message: "عرض المواعيد غير متاح حاليًا في إعدادات بوابة المريض." },
        { status: 403 },
      );
    }

    const bundle = await getPortalAppointmentsBundle(session.patientId, settings);
    return NextResponse.json({
      today: bundle.today,
      appointments: bundle.appointments,
      pastAppointments: bundle.pastAppointments,
      allowConfirm: bundle.allowConfirm,
      showBookingLink: bundle.showBookingLink,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المواعيد." }, { status: 500 });
  }
}
