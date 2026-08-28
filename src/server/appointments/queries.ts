import { and, asc, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { appointments, patients, users } from "@/db/schema";
import { getAppDayRangeUtc, zonedTimeToUtc } from "@/lib/datetime";
import { ACTIVE_APPOINTMENT_STATUSES } from "@/server/follow-up/logic";

export const APPOINTMENT_PAGE_SIZE = 20;

export type AppointmentRow = {
  id: string;
  appointmentDate: Date;
  status: string;
  reason: string | null;
  notes: string | null;
  patientId: string;
  patientName: string;
  fileNumber: string;
  patientMobile: string;
  doctorId: string;
  doctorName: string;
};

export type AppointmentListFilters = {
  /** ISO date (clinic) or undefined for any date. */
  date?: string;
  status?: string;
  doctorId?: string;
  page?: number;
};

export async function listAppointments(
  filters: AppointmentListFilters
): Promise<{ rows: AppointmentRow[]; total: number; page: number; pageCount: number }> {
  const page = Math.max(1, filters.page ?? 1);
  const conditions = [];

  if (filters.date && /^\d{4}-\d{2}-\d{2}$/.test(filters.date)) {
    const [y, m, d] = filters.date.split("-").map(Number);
    const start = zonedTimeToUtc({ year: y!, month: m!, day: d! });
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    conditions.push(
      and(
        gte(appointments.appointmentDate, start),
        lt(appointments.appointmentDate, end)
      )
    );
  }
  if (filters.status && ["SCHEDULED", "CONFIRMED", "ARRIVED", "IN_TREATMENT", "COMPLETED", "CANCELLED", "NO_SHOW"].includes(filters.status)) {
    conditions.push(
      eq(
        appointments.status,
        filters.status as (typeof appointments.status.enumValues)[number]
      )
    );
  }
  if (filters.doctorId) {
    conditions.push(eq(appointments.doctorId, filters.doctorId));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: appointments.id,
        appointmentDate: appointments.appointmentDate,
        status: appointments.status,
        reason: appointments.reason,
        notes: appointments.notes,
        patientId: patients.id,
        patientName: patients.fullName,
        fileNumber: patients.fileNumber,
        patientMobile: patients.mobile,
        doctorId: users.id,
        doctorName: users.name,
      })
      .from(appointments)
      .innerJoin(patients, eq(appointments.patientId, patients.id))
      .innerJoin(users, eq(appointments.doctorId, users.id))
      .where(where)
      .orderBy(desc(appointments.appointmentDate))
      .limit(APPOINTMENT_PAGE_SIZE)
      .offset((page - 1) * APPOINTMENT_PAGE_SIZE),
    db
      .select({ value: count() })
      .from(appointments)
      .where(where),
  ]);

  const total = Number(totals[0]?.value ?? 0);
  return {
    rows,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / APPOINTMENT_PAGE_SIZE)),
  };
}

/** Today's appointments (clinic timezone) ordered by time. */
export async function getTodayAppointments(): Promise<AppointmentRow[]> {
  const { startUtc, endUtc } = getAppDayRangeUtc();
  return db
    .select({
      id: appointments.id,
      appointmentDate: appointments.appointmentDate,
      status: appointments.status,
      reason: appointments.reason,
      notes: appointments.notes,
      patientId: patients.id,
      patientName: patients.fullName,
      fileNumber: patients.fileNumber,
      patientMobile: patients.mobile,
      doctorId: users.id,
      doctorName: users.name,
    })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .innerJoin(users, eq(appointments.doctorId, users.id))
    .where(
      and(
        gte(appointments.appointmentDate, startUtc),
        lt(appointments.appointmentDate, endUtc)
      )
    )
    .orderBy(asc(appointments.appointmentDate));
}

/** Patient's appointments (newest first, capped for the profile tab). */
export async function getPatientAppointments(
  patientId: string,
  limit = 30
): Promise<AppointmentRow[]> {
  return db
    .select({
      id: appointments.id,
      appointmentDate: appointments.appointmentDate,
      status: appointments.status,
      reason: appointments.reason,
      notes: appointments.notes,
      patientId: patients.id,
      patientName: patients.fullName,
      fileNumber: patients.fileNumber,
      patientMobile: patients.mobile,
      doctorId: users.id,
      doctorName: users.name,
    })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .innerJoin(users, eq(appointments.doctorId, users.id))
    .where(eq(appointments.patientId, patientId))
    .orderBy(desc(appointments.appointmentDate))
    .limit(limit);
}

/**
 * Exact-time conflict check: same doctor, same instant, still-active
 * appointment. Optionally excludes one appointment (when rescheduling).
 *
 * Pass an open transaction as `executor` to run the check inside the same
 * atomic operation that will insert the appointment (visit completion).
 */
export async function findExactTimeConflict(
  doctorId: string,
  appointmentDate: Date,
  excludeAppointmentId?: string,
  executor: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0] = db
): Promise<{ patientName: string } | null> {
  const conditions = [
    eq(appointments.doctorId, doctorId),
    eq(appointments.appointmentDate, appointmentDate),
    inArray(appointments.status, [...ACTIVE_APPOINTMENT_STATUSES]),
  ];
  if (excludeAppointmentId) {
    conditions.push(sql`${appointments.id} <> ${excludeAppointmentId}`);
  }
  const rows = await executor
    .select({ patientName: patients.fullName })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .where(and(...conditions))
    .limit(1);
  return rows[0] ?? null;
}

/** Active doctors for select inputs. */
export async function listDoctors(): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.role, "DOCTOR"), eq(users.active, true)))
    .orderBy(asc(users.name));
}
