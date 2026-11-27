import { NextResponse } from "next/server";
import type { SessionPayload } from "@/lib/auth";
import { clinicDateString } from "@/lib/schedule";
import { projectPlannedVisitRebooking } from "@/lib/planned-visit-projection";
import { CLINIC_TIME_ZONE, getPool, listPatientPlannedVisits } from "@/lib/db";
import { canAccessPatient, canViewPatientMoney } from "@/lib/patient-access";
import { readReceptionPatientAccount } from "@/lib/reception-patient-account";
import { canHandleMoney } from "@/lib/roles";
import { patientAppointmentId } from "@/lib/patient-appointments-contract";

interface DeskPatient { id: number; fullName: string; patientNumber: string; phone: string | null }

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function activeVisit(id: number, today: string) {
  const { rows } = await getPool().query<{ openVisitId: number | null }>(
        `SELECT (SELECT v.id FROM visits v WHERE v.patient_id = p.id AND v.signed_at IS NULL
          AND v.status NOT IN ('done', 'cancelled') AND (v.arrived_at AT TIME ZONE $2)::date = $3::date
          ORDER BY v.id DESC LIMIT 1) AS "openVisitId" FROM patients p WHERE p.id = $1`, [id, CLINIC_TIME_ZONE, today]);
  return rows[0];
}

export async function receptionRead(request: Request, session: SessionPayload, rawId: string) {
  const params = new URL(request.url).searchParams;
  const mode = params.get("projection");
  const id = patientAppointmentId(rawId);
  if (id === null || params.size !== 1 || (mode !== "reception" && mode !== "reception-money" && mode !== "reception-booking"))
    return json({ message: "طلب غير صالح." }, 400);
  if (session.role !== "reception") return json({ message: "هذه الواجهة للاستقبال." }, 403);
  const missing = () => json({ message: "الملف غير متاح." }, 404);
  try {
    if (!await canAccessPatient(session, id)) return missing();
    const pool = getPool();
    if (mode === "reception") {
      const { rows: [row] } = await pool.query<DeskPatient>(
        'SELECT id, full_name AS "fullName", patient_number AS "patientNumber", phone FROM patients WHERE id = $1', [id]);
      if (!row || row.id !== id) return missing();
      const { fullName, patientNumber, phone } = row;
      return json({ id, fullName, patientNumber, phone });
    }
    if (mode === "reception-booking") {
      const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
      const patient = await activeVisit(id, today);
      if (!patient) return missing();
      const visits = patient.openVisitId !== null ? [] : await listPatientPlannedVisits(id);
      const plannedVisits = visits.map(visit => {
        const { id, sequence, title, doctorName, durationMinutes, status, appointmentId, appointmentStatus,
          canRebook, rebookBlockedReason, rebookGeneration, appointmentDate, appointmentTime } = projectPlannedVisitRebooking(visit, session);
        return { id, sequence, title, doctorName, durationMinutes, status, appointmentId, appointmentStatus,
          canRebook, rebookBlockedReason, rebookGeneration, appointmentDate, appointmentTime, note: null, planTitle: null };
      });
      return json({ id, plannedVisits, openVisitId: patient.openVisitId, today, timeZone: CLINIC_TIME_ZONE });
    }
    if (!await canViewPatientMoney(session, id)) return json({ message: "الرصيد غير متاح." }, 403);
    const patient = await activeVisit(id, clinicDateString(new Date(), CLINIC_TIME_ZONE));
    if (!patient) return missing();
    const account = await readReceptionPatientAccount(id);
    return json({ ...account, openVisitId: patient.openVisitId, canCollect: canHandleMoney(session.role) });
  } catch {
    return json({ message: "تعذّر التحقق من بيانات المريض." }, 500);
  }
}
