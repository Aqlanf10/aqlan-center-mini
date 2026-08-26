import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  appointments,
  patients,
  users,
  visits,
  type Patient,
} from "@/db/schema";
import { getAppDayRangeUtc } from "@/lib/datetime";

export const PATIENT_PAGE_SIZE = 20;

export type PatientListFilters = {
  q?: string;
  /** treatment status filter (exact enum value). */
  status?: string;
  /** all | active | archived. */
  filter?: "all" | "active" | "archived";
  page?: number;
};

export type PatientListItem = {
  id: string;
  fileNumber: string;
  fullName: string;
  mobile: string;
  gender: Patient["gender"];
  treatmentStatus: Patient["treatmentStatus"];
  active: boolean;
  doctorName: string | null;
  lastVisitDate: Date | null;
};

export type PatientListResult = {
  rows: PatientListItem[];
  total: number;
  page: number;
  pageCount: number;
};

/**
 * Server-side patient search: fullName / fileNumber / mobile with ILIKE,
 * plus status and active filters and pagination. Never loads the whole
 * table into the browser.
 */
export async function listPatients(
  filters: PatientListFilters
): Promise<PatientListResult> {
  const page = Math.max(1, filters.page ?? 1);

  const conditions = [];
  const q = filters.q?.trim();
  if (q) {
    const pattern = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    conditions.push(
      or(
        ilike(patients.fullName, pattern),
        ilike(patients.fileNumber, pattern),
        ilike(patients.mobile, pattern)
      )
    );
  }
  if (
    filters.status &&
    ["NEW", "ACTIVE", "RETENTION", "COMPLETED", "PAUSED"].includes(
      filters.status
    )
  ) {
    conditions.push(
      eq(patients.treatmentStatus, filters.status as Patient["treatmentStatus"])
    );
  }
  if (filters.filter === "active") {
    conditions.push(eq(patients.active, true));
  } else if (filters.filter === "archived") {
    conditions.push(eq(patients.active, false));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const lastVisitSub = db
    .select({
      patientId: visits.patientId,
      lastVisit: sql<Date>`max(${visits.visitDate})`.as("last_visit"),
    })
    .from(visits)
    .where(eq(visits.status, "COMPLETED"))
    .groupBy(visits.patientId)
    .as("last_visit_sub");

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: patients.id,
        fileNumber: patients.fileNumber,
        fullName: patients.fullName,
        mobile: patients.mobile,
        gender: patients.gender,
        treatmentStatus: patients.treatmentStatus,
        active: patients.active,
        doctorName: users.name,
        lastVisitDate: lastVisitSub.lastVisit,
      })
      .from(patients)
      .leftJoin(users, eq(patients.treatingDoctorId, users.id))
      .leftJoin(lastVisitSub, eq(lastVisitSub.patientId, patients.id))
      .where(where)
      .orderBy(desc(patients.active), desc(patients.createdAt))
      .limit(PATIENT_PAGE_SIZE)
      .offset((page - 1) * PATIENT_PAGE_SIZE),
    db.select({ value: count() }).from(patients).where(where),
  ]);

  const total = Number(totals[0]?.value ?? 0);
  return {
    rows,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PATIENT_PAGE_SIZE)),
  };
}

export type PatientWithDoctor = {
  patient: Patient;
  doctorName: string | null;
};

export async function getPatientById(
  id: string
): Promise<PatientWithDoctor | null> {
  const rows = await db
    .select({ patient: patients, doctorName: users.name })
    .from(patients)
    .leftJoin(users, eq(patients.treatingDoctorId, users.id))
    .where(eq(patients.id, id))
    .limit(1);
  const row = rows[0];
  return row ? { patient: row.patient, doctorName: row.doctorName } : null;
}

export type PatientOption = {
  id: string;
  fileNumber: string;
  fullName: string;
  mobile: string;
  treatmentStatus: Patient["treatmentStatus"];
};

/** Lightweight patient search used by the appointment form combobox. */
export async function searchPatientOptions(q: string): Promise<PatientOption[]> {
  const term = q.trim();
  if (!term) {
    return [];
  }
  const pattern = `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  return db
    .select({
      id: patients.id,
      fileNumber: patients.fileNumber,
      fullName: patients.fullName,
      mobile: patients.mobile,
      treatmentStatus: patients.treatmentStatus,
    })
    .from(patients)
    .where(
      and(
        eq(patients.active, true),
        or(
          ilike(patients.fullName, pattern),
          ilike(patients.fileNumber, pattern),
          ilike(patients.mobile, pattern)
        )
      )
    )
    .orderBy(asc(patients.fullName))
    .limit(10);
}

export type PatientProfileSummary = {
  lastCompletedVisitDate: Date | null;
  nextAppointmentDate: Date | null;
  nextAppointmentId: string | null;
  completedVisitsCount: number;
  appointmentsCount: number;
};

/** Operational aggregates for the patient profile header. */
export async function getPatientSummary(
  patientId: string
): Promise<PatientProfileSummary> {
  const { startUtc } = getAppDayRangeUtc();

  const [lastVisit, nextAppointment, visitCount, appointmentCount] =
    await Promise.all([
      db
        .select({ value: sql<Date | null>`max(${visits.visitDate})` })
        .from(visits)
        .where(
          and(
            eq(visits.patientId, patientId),
            eq(visits.status, "COMPLETED")
          )
        ),
      db
        .select({
          id: appointments.id,
          date: sql<Date>`min(${appointments.appointmentDate})`,
        })
        .from(appointments)
        .where(
          and(
            eq(appointments.patientId, patientId),
            inArray(appointments.status, [
              "SCHEDULED",
              "CONFIRMED",
              "ARRIVED",
              "IN_TREATMENT",
            ]),
            sql`${appointments.appointmentDate} >= ${startUtc.toISOString()}`
          )
        ),
      db
        .select({ value: count() })
        .from(visits)
        .where(
          and(eq(visits.patientId, patientId), eq(visits.status, "COMPLETED"))
        ),
      db
        .select({ value: count() })
        .from(appointments)
        .where(eq(appointments.patientId, patientId)),
    ]);

  return {
    lastCompletedVisitDate: lastVisit[0]?.value ?? null,
    nextAppointmentDate: nextAppointment[0]?.date ?? null,
    nextAppointmentId: nextAppointment[0]?.id ?? null,
    completedVisitsCount: Number(visitCount[0]?.value ?? 0),
    appointmentsCount: Number(appointmentCount[0]?.value ?? 0),
  };
}
