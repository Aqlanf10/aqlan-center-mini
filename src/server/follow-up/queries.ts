import { asc, count, desc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { patientContacts, patients, users } from "@/db/schema";
import type { ContactResult, ContactType } from "@/db/schema/enums";
import { coerceDate, getAppDayRangeUtc, getTodayIsoDate } from "@/lib/datetime";
import {
  assessFollowUp,
  queuesFor,
  type FollowUpAssessment,
  type FollowUpQueue,
} from "@/server/follow-up/logic";

export type FollowUpCandidate = {
  patientId: string;
  fullName: string;
  fileNumber: string;
  mobile: string;
  treatmentStatus: string;
  recallIntervalDays: number;
  doctorName: string | null;
  nextAppointmentDate: Date | null;
  lastCompletedVisitDate: Date | null;
  lastNoShowDate: Date | null;
};

export type FollowUpEntry = FollowUpCandidate & {
  assessment: FollowUpAssessment;
};

/**
 * Load all facts the pure follow-up engine needs, in one query per patient
 * aggregate (subselects), then derive statuses in the typed logic module.
 * Derived values are never stored, so they can never go stale.
 */
export async function getFollowUpCandidates(): Promise<FollowUpCandidate[]> {
  const { startUtc } = getAppDayRangeUtc();

  const rows = await db
    .select({
      patientId: patients.id,
      fullName: patients.fullName,
      fileNumber: patients.fileNumber,
      mobile: patients.mobile,
      treatmentStatus: patients.treatmentStatus,
      recallIntervalDays: patients.recallIntervalDays,
      doctorName: users.name,
      nextAppointmentDate: sql<Date | null>`(
        SELECT MIN(a.appointment_date) FROM appointments a
        WHERE a.patient_id = patients.id
          AND a.status IN ('SCHEDULED', 'CONFIRMED', 'ARRIVED', 'IN_TREATMENT')
          AND a.appointment_date >= ${startUtc.toISOString()}
      )`,
      lastCompletedVisitDate: sql<Date | null>`(
        SELECT MAX(v.visit_date) FROM visits v
        WHERE v.patient_id = patients.id AND v.status = 'COMPLETED'
      )`,
      lastNoShowDate: sql<Date | null>`(
        SELECT MAX(a.appointment_date) FROM appointments a
        WHERE a.patient_id = patients.id AND a.status = 'NO_SHOW'
      )`,
    })
    .from(patients)
    .leftJoin(users, eq(patients.treatingDoctorId, users.id))
    .where(eq(patients.active, true))
    .orderBy(asc(patients.fullName));

  // Raw sql subselect values arrive as strings (postgres.js) — coerce to
  // real Dates before the pure engine touches them.
  return rows.map((row) => ({
    ...row,
    nextAppointmentDate: coerceDate(row.nextAppointmentDate),
    lastCompletedVisitDate: coerceDate(row.lastCompletedVisitDate),
    lastNoShowDate: coerceDate(row.lastNoShowDate),
  }));
}

/** Derive entries + resolve NO_SHOW resolution (future appointment booked?). */
export function deriveFollowUpEntries(
  candidates: readonly FollowUpCandidate[],
  todayIso = getTodayIsoDate()
): FollowUpEntry[] {
  return candidates.map((candidate) => {
    const hasFutureAppointment = Boolean(candidate.nextAppointmentDate);
    // A NO_SHOW is "resolved" once a new future appointment exists after it.
    const unresolvedNoShow =
      candidate.lastNoShowDate !== null && !hasFutureAppointment;

    const assessment = assessFollowUp({
      active: true,
      treatmentStatus: candidate.treatmentStatus,
      todayIso,
      nextAppointmentDate: candidate.nextAppointmentDate,
      lastCompletedVisitDate: candidate.lastCompletedVisitDate,
      recallIntervalDays: candidate.recallIntervalDays,
      lastNoShowDate: unresolvedNoShow ? candidate.lastNoShowDate : null,
    });

    return { ...candidate, assessment };
  });
}

export function filterByQueue(
  entries: readonly FollowUpEntry[],
  queue: FollowUpQueue
): FollowUpEntry[] {
  if (queue === "contacted") {
    // The contacted list is a separate history query, not derived here.
    return [];
  }
  return entries.filter((entry) =>
    queuesFor(entry.assessment).includes(queue)
  );
}

/** Counts per queue for the dashboard cards. */
export async function getFollowUpCounts(): Promise<{
  overdue: number;
  noNextAppointment: number;
  missed: number;
  dueToday: number;
  dueSoon: number;
}> {
  const candidates = await getFollowUpCandidates();
  const entries = deriveFollowUpEntries(candidates);
  return {
    overdue: filterByQueue(entries, "overdue").length,
    noNextAppointment: filterByQueue(entries, "no-next-appointment").length,
    missed: filterByQueue(entries, "missed").length,
    dueToday: filterByQueue(entries, "due-today").length,
    dueSoon: filterByQueue(entries, "due-soon").length,
  };
}

export type ContactHistoryEntry = {
  id: string;
  patientId: string;
  patientName: string;
  fileNumber: string;
  contactType: ContactType;
  result: ContactResult;
  note: string | null;
  contactedAt: Date;
  byName: string;
};

/** Recent contact attempts across all patients (Contacted tab). */
export async function getRecentContacts(limit = 50): Promise<ContactHistoryEntry[]> {
  return db
    .select({
      id: patientContacts.id,
      patientId: patients.id,
      patientName: patients.fullName,
      fileNumber: patients.fileNumber,
      contactType: patientContacts.contactType,
      result: patientContacts.result,
      note: patientContacts.note,
      contactedAt: patientContacts.contactedAt,
      byName: users.name,
    })
    .from(patientContacts)
    .innerJoin(patients, eq(patientContacts.patientId, patients.id))
    .innerJoin(users, eq(patientContacts.userId, users.id))
    .orderBy(desc(patientContacts.contactedAt))
    .limit(limit);
}

/** Count of active patients (dashboard). */
export async function getActivePatientCount(): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(patients)
    .where(eq(patients.active, true));
  return Number(rows[0]?.value ?? 0);
}
