"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { appointments } from "@/db/schema";
import { requireUser } from "@/lib/auth/guards";
import {
  getAppDayRangeUtc,
  parseDateTimeLocal,
} from "@/lib/datetime";
import {
  appointmentFormSchema,
  validateWith,
} from "@/lib/validation";
import { AUDIT_ACTIONS, recordAudit } from "@/server/audit";
import { findExactTimeConflict } from "@/server/appointments/queries";
import { failure, success, type ActionResult } from "@/server/types";
import type { AppointmentStatus } from "@/db/schema/enums";

function revalidateAppointmentPages(patientId?: string) {
  revalidatePath("/appointments");
  revalidatePath("/today");
  revalidatePath("/dashboard");
  revalidatePath("/follow-up");
  if (patientId) {
    revalidatePath(`/patients/${patientId}`);
  }
}

/** Insert an appointment (used by create + reschedule flows). */
async function insertAppointment(input: {
  patientId: string;
  doctorId: string;
  appointmentDate: Date;
  reason?: string | null;
  notes?: string | null;
  createdBy: string;
}): Promise<string> {
  const [created] = await db
    .insert(appointments)
    .values({
      patientId: input.patientId,
      doctorId: input.doctorId,
      appointmentDate: input.appointmentDate,
      reason: input.reason ?? null,
      notes: input.notes ?? null,
      status: "SCHEDULED",
      createdBy: input.createdBy,
    })
    .returning({ id: appointments.id });
  if (!created) {
    throw new Error("appointment insert returned no row");
  }
  return created.id;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    /appointments_doctor_time_active_unique/i.test(error.message)
  );
}

export async function createAppointmentAction(
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireUser("/appointments");

  const validation = validateWith(appointmentFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }
  const data = validation.data;

  const when = parseDateTimeLocal(data.appointmentDate);
  if (!when) {
    return failure("common.serverError", { appointmentDate: "datetimeInvalid" });
  }
  // Appointments cannot be booked in the past (clinic day already started).
  const { startUtc } = getAppDayRangeUtc();
  if (when.getTime() < startUtc.getTime()) {
    return failure("common.serverError", { appointmentDate: "validation.datetimePast" });
  }

  // Friendly conflict pre-check; the partial unique index is the race guard.
  const conflict = await findExactTimeConflict(data.doctorId, when);
  if (conflict) {
    return failure("appointments.conflictError");
  }

  try {
    const id = await insertAppointment({
      patientId: data.patientId,
      doctorId: data.doctorId,
      appointmentDate: when,
      reason: data.reason ?? null,
      notes: data.notes ?? null,
      createdBy: user.id,
    });

    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.APPOINTMENT_CREATED,
      entityType: "appointment",
      entityId: id,
      metadata: { patientId: data.patientId, doctorId: data.doctorId },
    });

    revalidateAppointmentPages(data.patientId);
    return success("appointments.toasts.created", id);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return failure("appointments.conflictError");
    }
    return failure("appointments.toasts.failed");
  }
}

export async function rescheduleAppointmentAction(
  appointmentId: string,
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireUser("/appointments");

  const validation = validateWith(appointmentFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }
  const data = validation.data;

  const [existing] = await db
    .select({
      id: appointments.id,
      patientId: appointments.patientId,
      status: appointments.status,
    })
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1);
  if (!existing) {
    return failure("appointments.toasts.failed");
  }
  if (existing.status === "COMPLETED" || existing.status === "CANCELLED") {
    return failure("appointments.toasts.failed");
  }

  const when = parseDateTimeLocal(data.appointmentDate);
  if (!when) {
    return failure("common.serverError", { appointmentDate: "datetimeInvalid" });
  }
  const { startUtc } = getAppDayRangeUtc();
  if (when.getTime() < startUtc.getTime()) {
    return failure("common.serverError", { appointmentDate: "validation.datetimePast" });
  }

  const conflict = await findExactTimeConflict(
    data.doctorId,
    when,
    appointmentId
  );
  if (conflict) {
    return failure("appointments.conflictError");
  }

  try {
    await db
      .update(appointments)
      .set({
        doctorId: data.doctorId,
        appointmentDate: when,
        reason: data.reason ?? null,
        notes: data.notes ?? null,
        // Rescheduling a NO_SHOW/NO-show-like state reactivates the plan.
        status: "SCHEDULED",
        updatedAt: new Date(),
      })
      .where(eq(appointments.id, appointmentId));

    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.APPOINTMENT_RESCHEDULED,
      entityType: "appointment",
      entityId: appointmentId,
      metadata: { patientId: existing.patientId },
    });

    revalidateAppointmentPages(existing.patientId);
    return success("appointments.toasts.rescheduled", appointmentId);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return failure("appointments.conflictError");
    }
    return failure("appointments.toasts.failed");
  }
}

/**
 * Server-side state machine. Terminal states (COMPLETED / CANCELLED /
 * NO_SHOW) intentionally allow NO further transitions — a NO_SHOW is
 * resolved by rescheduling into a NEW appointment, history stays auditable.
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

export async function setAppointmentStatusAction(
  appointmentId: string,
  next: AppointmentStatus
): Promise<ActionResult> {
  const user = await requireUser("/today");

  const [existing] = await db
    .select({
      id: appointments.id,
      patientId: appointments.patientId,
      status: appointments.status,
    })
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1);
  if (!existing) {
    return failure("appointments.toasts.failed");
  }

  const allowed = ALLOWED_TRANSITIONS[existing.status] ?? [];
  if (!allowed.includes(next)) {
    return failure("appointments.toasts.failed");
  }

  // Only doctors/admins mark treatments; reception runs arrivals/no-shows.
  if (
    (next === "IN_TREATMENT" || next === "COMPLETED") &&
    user.role === "RECEPTION"
  ) {
    return failure("errors.forbidden");
  }

  try {
    await db
      .update(appointments)
      .set({ status: next, updatedAt: new Date() })
      .where(eq(appointments.id, appointmentId));

    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.APPOINTMENT_STATUS_CHANGED,
      entityType: "appointment",
      entityId: appointmentId,
      metadata: { from: existing.status, to: next },
    });

    revalidateAppointmentPages(existing.patientId);
    const messageKey =
      next === "CANCELLED"
        ? "appointments.toasts.cancelled"
        : next === "NO_SHOW"
          ? "appointments.toasts.markedNoShow"
          : "appointments.toasts.statusChanged";
    return success(messageKey, appointmentId);
  } catch {
    return failure("appointments.toasts.failed");
  }
}
