import type { AppointmentStatus } from "@/db/schema/enums";

/**
 * Server-side appointment state machine (pure data — unit-tested).
 *
 * Terminal states (COMPLETED / CANCELLED / NO_SHOW) intentionally allow NO
 * further transitions — a NO_SHOW is resolved by rescheduling into a NEW
 * appointment, history stays auditable.
 *
 * Lives outside the "use server" file because server-action modules may
 * only export async functions.
 */
export const ALLOWED_TRANSITIONS: Record<string, AppointmentStatus[]> = {
  SCHEDULED: ["CONFIRMED", "ARRIVED", "CANCELLED", "NO_SHOW"],
  CONFIRMED: ["ARRIVED", "CANCELLED", "NO_SHOW"],
  ARRIVED: ["IN_TREATMENT", "CANCELLED", "NO_SHOW"],
  IN_TREATMENT: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};
