import { NextResponse } from "next/server";
import type { SessionPayload } from "./auth";
import { canAccessPatient } from "@/lib/patient-access";
import { CLINIC_TIME_ZONE } from "@/lib/db";
import { clinicDateString } from "@/lib/schedule";
import { readPatientAppointments } from "@/lib/patient-appointments-reader";
import { canRemindPatientRole, patientAppointmentId, readPatientAppointmentsPage, readPatientAppointmentsQuery } from "@/lib/patient-appointments-contract";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

/** Called only after the existing patient GET has authenticated and authorized its patient. */
export async function patientAppointmentsResponse(request: Request, session: SessionPayload, rawId: string) {
  const patientId = patientAppointmentId(rawId);
  if (patientId === null) return json({ message: "رقم المريض غير صالح." }, 400);
  const params = new URL(request.url).searchParams;
  if (params.getAll("projection").length !== 1 || params.get("projection") !== "appointments") return json({ message: "عرض المواعيد غير صالح." }, 400);
  params.delete("projection");
  const query = readPatientAppointmentsQuery(params, patientId);
  if (!query) return json({ message: "طلب قائمة المواعيد غير صالح." }, 400);
  try {
    // Same patient-file guard; an assistant can read today's patients, never mutate here.
    if (!(await canAccessPatient(session, patientId))) return json({ message: "الملف غير موجود أو لا تملك صلاحية عرضه." }, 404);
    const now = new Date();
    const result = await readPatientAppointments(patientId, query, clinicDateString(now, CLINIC_TIME_ZONE));
    if (!result) return json({ message: "الملف غير موجود أو لا تملك صلاحية عرضه." }, 404);
    const payload = { patientId, view: query.view, requestCursor: query.requestCursor, ...result,
      timeZone: CLINIC_TIME_ZONE, generatedAt: now.toISOString(), canRemind: canRemindPatientRole(session.role) };
    if (!readPatientAppointmentsPage(payload, patientId, query.view, query.requestCursor)) throw new Error("Invalid appointment data");
    return json(payload);
  } catch {
    return json({ message: "تعذّر التحقق من مواعيد المريض. أعد المحاولة." }, 500);
  }
}
