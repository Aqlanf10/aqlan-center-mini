import { NextResponse } from "next/server";
import { MAX_DURATION, MIN_DURATION } from "@/lib/appointment-services";
import { doctorAvailabilitySlots } from "@/lib/appointment-availability";
import { loadCapacityContext, loadProviderBlockWindows, resolveService } from "@/lib/capacity-context";
import { CLINIC_TIME_ZONE, findUserByUsername, getParty, listAppointmentsByDate } from "@/lib/db";
import { clinicDateString, toMinutes } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const validDate = (date: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return date >= "0001-01-01" && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
};

/** لا أسماء مرضى هنا: الأوقات وحالتها فقط، من قواعد الحجز الفعلية. */
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (session.role !== "admin" && session.role !== "reception" && session.role !== "doctor") {
    return NextResponse.json({ message: "عرض مواعيد الأطباء ليس من صلاحيتك." }, { status: 403 });
  }
  const params = new URL(request.url).searchParams;
  const date = params.get("date") ?? "";
  const doctorId = Number(params.get("doctorId"));
  const durationMinutes = Number(params.get("durationMinutes") ?? 30);
  const serviceId = params.has("serviceId") ? Number(params.get("serviceId")) : null;
  const appointmentType = params.get("appointmentType");
  if (!validDate(date) || !Number.isInteger(doctorId) || doctorId <= 0
    || !Number.isInteger(durationMinutes) || durationMinutes < MIN_DURATION || durationMinutes > MAX_DURATION
    || (serviceId !== null && (!Number.isInteger(serviceId) || serviceId <= 0))) {
    return NextResponse.json({ message: "حدّد طبيبًا وتاريخًا ومدة صحيحة." }, { status: 400 });
  }
  try {
    if (session.role === "doctor") {
      const user = await findUserByUsername(session.username);
      if (user?.partyId !== doctorId) {
        return NextResponse.json({ message: "يمكنك عرض أوقاتك فقط." }, { status: 403 });
      }
    }
    const doctor = await getParty(doctorId);
    if (!doctor || doctor.kind !== "doctor" || !doctor.isActive) {
      return NextResponse.json({ message: "الطبيب غير متاح للحجز." }, { status: 404 });
    }
    const [context, service, appointments, blocks] = await Promise.all([
      loadCapacityContext(), resolveService({ serviceId, appointmentType }),
      listAppointmentsByDate(date), loadProviderBlockWindows(doctorId, date),
    ]);
    const now = new Date();
    const clinicTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: CLINIC_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(now);
    return NextResponse.json({
      doctorId, date, durationMinutes,
      slots: doctorAvailabilitySlots({
        date, doctorId, durationMinutes, service, context, appointments, blocks,
        today: clinicDateString(now, CLINIC_TIME_ZONE), nowMinutes: toMinutes(clinicTime) ?? 0,
      }),
    });
  } catch {
    return NextResponse.json({ message: "تعذّر التحقق من أوقات الطبيب." }, { status: 500 });
  }
}
