/**
 * Follow-up / recall engine — PURE derivation logic.
 *
 * Every "due", "overdue", "missed" and "no next appointment" decision in
 * the app flows through these functions so the rules live in exactly one
 * place and are unit-testable without a database.
 *
 * Reference rules (clinic decision, mirrors the operations spec):
 *  A. Patient has a future ACTIVE appointment -> that appointment is the
 *     reference (ON_TIME / DUE_SOON / DUE_TODAY relative to it).
 *  B. No future appointment but a completed visit exists ->
 *     reference = lastCompletedVisit + patient.recallIntervalDays.
 *  C. Patient has an unresolved NO_SHOW -> MISSED queue.
 *  D. Patient was visited but has no upcoming appointment ->
 *     NO_NEXT_APPOINTMENT queue (safety net — even when the recall date
 *     is still far away, the patient must not be forgotten).
 *
 * All dates/times are UTC instants; "today" is the clinic-day (Asia/Aden)
 * supplied by the caller as an ISO date string.
 */

import { addDaysToIsoDate, getTodayIsoDate } from "@/lib/datetime";

/** Central, tunable "due soon" window (days). Never scatter magic numbers. */
export const DUE_SOON_WINDOW_DAYS = 3;

/** Appointment statuses considered ACTIVE (occupy a slot / plan ahead). */
export const ACTIVE_APPOINTMENT_STATUSES = [
  "SCHEDULED",
  "CONFIRMED",
  "ARRIVED",
  "IN_TREATMENT",
] as const;

/** Primary follow-up status shown to staff. */
export type FollowUpStatus =
  | "ON_TIME"
  | "DUE_SOON"
  | "DUE_TODAY"
  | "OVERDUE"
  | "NO_NEXT_APPOINTMENT"
  | "MISSED"
  | "INACTIVE";

/** Timing of the next expected contact/visit, independent of status. */
export type FollowUpTiming = "ON_TIME" | "DUE_SOON" | "DUE_TODAY" | "OVERDUE";

export type FollowUpQueue =
  | "due-today"
  | "due-soon"
  | "overdue"
  | "no-next-appointment"
  | "missed"
  | "contacted";

export const FOLLOW_UP_QUEUES: readonly FollowUpQueue[] = [
  "due-today",
  "due-soon",
  "overdue",
  "no-next-appointment",
  "missed",
  "contacted",
];

export function isFollowUpQueue(value: unknown): value is FollowUpQueue {
  return (
    typeof value === "string" &&
    (FOLLOW_UP_QUEUES as readonly string[]).includes(value)
  );
}

export type FollowUpFacts = {
  /** patient.active flag. */
  active: boolean;
  /** treatment_status — completed treatments leave the recall cycle. */
  treatmentStatus: string;
  /** Clinic "today" as YYYY-MM-DD (Asia/Aden). */
  todayIso: string;
  /** Earliest upcoming ACTIVE appointment (if any). */
  nextAppointmentDate?: Date | null;
  /** Latest COMPLETED visit (if any). */
  lastCompletedVisitDate?: Date | null;
  /** Per-patient recall interval in days (from the patient row). */
  recallIntervalDays: number;
  /** Latest NO_SHOW appointment (pass only when unresolved). */
  lastNoShowDate?: Date | null;
};

export type FollowUpAssessment = {
  status: FollowUpStatus;
  timing: FollowUpTiming;
  /** ISO date the recall is due (case B), for display. */
  recallDueIsoDate: string | null;
  /** Days between last completed visit and the due date (case B). */
  daysSinceLastVisit: number | null;
  /** Effective reference instant used for timing. */
  referenceDate: Date | null;
};

function daysBetweenIso(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

/** ISO date (YYYY-MM-DD) of an instant in the clinic timezone. */
function isoDateOf(date: Date, timeZone: string): string {
  return getTodayIsoDate(date, timeZone);
}

/**
 * Timing classification of a reference date against clinic-today.
 * days > 0 -> future, 0 -> today, < 0 -> past.
 */
function timingFromDiff(days: number): FollowUpTiming {
  if (days < 0) return "OVERDUE";
  if (days === 0) return "DUE_TODAY";
  if (days <= DUE_SOON_WINDOW_DAYS) return "DUE_SOON";
  return "ON_TIME";
}

/**
 * Derive the full follow-up assessment for one patient.
 * `timeZone` defaults to the app timezone (Asia/Aden).
 */
export function assessFollowUp(
  facts: FollowUpFacts,
  timeZone = process.env.NEXT_PUBLIC_APP_TIMEZONE || "Asia/Aden"
): FollowUpAssessment {
  const todayIso = facts.todayIso;

  if (!facts.active) {
    return {
      status: "INACTIVE",
      timing: "ON_TIME",
      recallDueIsoDate: null,
      daysSinceLastVisit: null,
      referenceDate: null,
    };
  }

  const hasFutureAppointment = Boolean(facts.nextAppointmentDate);
  const hasCompletedVisit = Boolean(facts.lastCompletedVisitDate);
  const lastVisitIso = facts.lastCompletedVisitDate
    ? isoDateOf(facts.lastCompletedVisitDate, timeZone)
    : null;

  // Patients whose treatment is intentionally COMPLETED leave the recall
  // cycle once nothing is pending: no upcoming appointment and no missed
  // appointment to chase. (An unresolved NO_SHOW still surfaces.)
  if (
    facts.treatmentStatus === "COMPLETED" &&
    !hasFutureAppointment &&
    !facts.lastNoShowDate
  ) {
    return {
      status: "ON_TIME",
      timing: "ON_TIME",
      recallDueIsoDate: null,
      daysSinceLastVisit: lastVisitIso !== null ? daysBetweenIso(lastVisitIso, todayIso) : null,
      referenceDate: null,
    };
  }

  const recallDueIsoDate =
    lastVisitIso !== null
      ? addDaysToIsoDate(lastVisitIso, facts.recallIntervalDays)
      : null;

  const daysSinceLastVisit =
    lastVisitIso !== null ? daysBetweenIso(lastVisitIso, todayIso) : null;

  // Timing reference: case A (appointment) first, then case B (recall).
  let timing: FollowUpTiming = "ON_TIME";
  let referenceDate: Date | null = null;

  if (facts.nextAppointmentDate) {
    referenceDate = facts.nextAppointmentDate;
    const apptIso = isoDateOf(facts.nextAppointmentDate, timeZone);
    timing = timingFromDiff(daysBetweenIso(todayIso, apptIso));
  } else if (recallDueIsoDate) {
    referenceDate = new Date(`${recallDueIsoDate}T00:00:00Z`);
    timing = timingFromDiff(daysBetweenIso(todayIso, recallDueIsoDate));
  }

  // Primary status priority:
  // MISSED (C) > NO_NEXT_APPOINTMENT (D) > timing-derived.
  let status: FollowUpStatus;
  if (facts.lastNoShowDate) {
    status = "MISSED";
  } else if (hasCompletedVisit && !hasFutureAppointment) {
    status = "NO_NEXT_APPOINTMENT";
  } else if (timing === "OVERDUE") {
    status = "OVERDUE";
  } else {
    status = timing;
  }

  return {
    status,
    timing,
    recallDueIsoDate,
    daysSinceLastVisit,
    referenceDate,
  };
}

/** Queue membership rules (the queues a patient belongs to). */
export function queuesFor(assessment: FollowUpAssessment): FollowUpQueue[] {
  const queues: FollowUpQueue[] = [];
  if (assessment.status === "INACTIVE") {
    return queues;
  }
  if (assessment.timing === "DUE_TODAY") queues.push("due-today");
  if (assessment.timing === "DUE_SOON") queues.push("due-soon");
  if (assessment.timing === "OVERDUE") queues.push("overdue");
  if (assessment.status === "NO_NEXT_APPOINTMENT") {
    queues.push("no-next-appointment");
  }
  if (assessment.status === "MISSED") queues.push("missed");
  return queues;
}
