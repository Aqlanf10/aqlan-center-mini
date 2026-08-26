import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { patients, users, visits } from "@/db/schema";

export type VisitRow = {
  id: string;
  patientId: string;
  patientName: string;
  fileNumber: string;
  doctorId: string;
  doctorName: string;
  appointmentId: string | null;
  visitDate: Date;
  chiefComplaint: string | null;
  treatmentPerformed: string;
  clinicalNotes: string | null;
  nextVisitPlan: string | null;
  nextAppointmentDate: Date | null;
  status: string;
};

export async function getVisitById(id: string): Promise<VisitRow | null> {
  const rows = await db
    .select({
      id: visits.id,
      patientId: visits.patientId,
      patientName: patients.fullName,
      fileNumber: patients.fileNumber,
      doctorId: visits.doctorId,
      doctorName: users.name,
      appointmentId: visits.appointmentId,
      visitDate: visits.visitDate,
      chiefComplaint: visits.chiefComplaint,
      treatmentPerformed: visits.treatmentPerformed,
      clinicalNotes: visits.clinicalNotes,
      nextVisitPlan: visits.nextVisitPlan,
      nextAppointmentDate: visits.nextAppointmentDate,
      status: visits.status,
    })
    .from(visits)
    .innerJoin(patients, eq(visits.patientId, patients.id))
    .innerJoin(users, eq(visits.doctorId, users.id))
    .where(eq(visits.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Find the open (DRAFT) visit linked to an appointment, if any. */
export async function getDraftVisitByAppointment(
  appointmentId: string
): Promise<VisitRow | null> {
  const rows = await db
    .select({
      id: visits.id,
      patientId: visits.patientId,
      patientName: patients.fullName,
      fileNumber: patients.fileNumber,
      doctorId: visits.doctorId,
      doctorName: users.name,
      appointmentId: visits.appointmentId,
      visitDate: visits.visitDate,
      chiefComplaint: visits.chiefComplaint,
      treatmentPerformed: visits.treatmentPerformed,
      clinicalNotes: visits.clinicalNotes,
      nextVisitPlan: visits.nextVisitPlan,
      nextAppointmentDate: visits.nextAppointmentDate,
      status: visits.status,
    })
    .from(visits)
    .innerJoin(patients, eq(visits.patientId, patients.id))
    .innerJoin(users, eq(visits.doctorId, users.id))
    .where(and(eq(visits.appointmentId, appointmentId), eq(visits.status, "DRAFT")))
    .limit(1);
  return rows[0] ?? null;
}

export async function getPatientVisits(
  patientId: string,
  limit = 30
): Promise<VisitRow[]> {
  return db
    .select({
      id: visits.id,
      patientId: visits.patientId,
      patientName: patients.fullName,
      fileNumber: patients.fileNumber,
      doctorId: visits.doctorId,
      doctorName: users.name,
      appointmentId: visits.appointmentId,
      visitDate: visits.visitDate,
      chiefComplaint: visits.chiefComplaint,
      treatmentPerformed: visits.treatmentPerformed,
      clinicalNotes: visits.clinicalNotes,
      nextVisitPlan: visits.nextVisitPlan,
      nextAppointmentDate: visits.nextAppointmentDate,
      status: visits.status,
    })
    .from(visits)
    .innerJoin(patients, eq(visits.patientId, patients.id))
    .innerJoin(users, eq(visits.doctorId, users.id))
    .where(eq(visits.patientId, patientId))
    .orderBy(desc(visits.visitDate))
    .limit(limit);
}
