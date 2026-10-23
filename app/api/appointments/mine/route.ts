import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { CLINIC_TIME_ZONE } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { addDays, clinicDateString } from "@/lib/schedule";
import { readDoctorDailySchedule, resolveScheduleDate, type DoctorDailySchedule } from "@/lib/doctor-daily-schedule";

export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "private, no-store" },
});

/** Personal account only. No client-selected doctor, even with broader appointments permission. */
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, 401);
  if (session.role !== "doctor" && session.role !== "admin") return json({ message: "هذا الجدول لحساب الطبيب فقط." }, 403);
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => key !== "date") || params.getAll("date").length > 1) {
    return json({ message: "لا يمكن اختيار طبيب آخر من الجدول الشخصي." }, 400);
  }
  // requireSession refreshes partyId from the active user record, not the request/token claim.
  const doctorId = session.partyId;
  if (!Number.isSafeInteger(doctorId) || !doctorId || doctorId <= 0) return json({ message: "الحساب غير مرتبط بطبيب نشط." }, 403);
  const now = new Date();
  const requestDate = params.get("date") ?? "today";
  const date = resolveScheduleDate(requestDate, now, CLINIC_TIME_ZONE);
  if (!date) return json({ message: "تاريخ غير صالح." }, 400);
  try {
    const rows = await readDoctorDailySchedule(doctorId, date);
    if (!rows) return json({ message: "الحساب غير مرتبط بطبيب نشط." }, 403);
    const access = new Map<number, boolean>();
    for (const patientId of new Set(rows.map((row) => row.patientId))) {
      const allowed = await canAccessPatient(session, patientId);
      if (!allowed) return json({ message: "تعذّر التحقق من صلاحية عرض المرضى. حدّث الجلسة." }, 403);
      access.set(patientId, allowed);
    }
    const today = clinicDateString(now, CLINIC_TIME_ZONE);
    const cancelled = rows.filter((row) => row.status === "cancelled").length;
    const payload: DoctorDailySchedule = {
      requestDate, date, today, tomorrow: addDays(today, 1), timeZone: CLINIC_TIME_ZONE,
      generatedAt: new Date().toISOString(),
      appointments: rows.map((row) => ({ ...row, patientHref: access.get(row.patientId)
        ? `/patients/${row.patientId}${date === today && row.status === "arrived" ? "?tab=today" : ""}` : null })),
      counts: { total: rows.length, cancelled, scheduled: rows.length - cancelled },
    };
    return json(payload);
  } catch {
    return json({ message: "تعذّر تحميل جدول المواعيد. حاول التحديث." }, 500);
  }
}
