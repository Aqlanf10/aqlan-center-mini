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
import { ALLOWED_TRANSITIONS } from "@/server/appointments/transitions";
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
    // Insert + audit in ONE transaction: a committed appointment always has
    // its audit row (movement-without-audit is impossible).
    const id = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(appointments)
        .values({
          patientId: data.patientId,
          doctorId: data.doctorId,
          appointmentDate: when,
          reason: data.reason ?? null,
          notes: data.notes ?? null,
          createdBy: user.id,
        })
        .returning({ id: appointments.id });
      if (!created) {
        return null;
      }

      await recordAudit(
        {
          userId: user.id,
          action: AUDIT_ACTIONS.APPOINTMENT_CREATED,
          entityType: "appointment",
          entityId: created.id,
          metadata: { patientId: data.patientId, doctorId: data.doctorId },
        },
        tx
      );
      return created.id;
    });

    if (!id) {
      return failure("appointments.toasts.failed");
    }

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
  if (
    existing.status === "COMPLETED" ||
    existing.status === "CANCELLED" ||
    existing.status === "ARRIVED" ||
    existing.status === "IN_TREATMENT"
  ) {
    // Terminal or in-flight states: an in-chair patient must not be "moved";
    // completed/cancelled history must never be rewritten.
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
    if (existing.status === "NO_SHOW") {
      // Spec: a missed appointment is history — rescheduling creates a NEW
      // appointment and the old row stays NO_SHOW (auditable forever).
      const createdId = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(appointments)
          .values({
            patientId: existing.patientId,
            doctorId: data.doctorId,
            appointmentDate: when,
            reason: data.reason ?? null,
            notes: data.notes ?? null,
            status: "SCHEDULED",
            createdBy: user.id,
          })
          .returning({ id: appointments.id });
        if (!created) {
          return null;
        }
        await recordAudit(
          {
            userId: user.id,
            action: AUDIT_ACTIONS.APPOINTMENT_RESCHEDULED,
            entityType: "appointment",
            entityId: created.id,
            metadata: {
              patientId: existing.patientId,
              oldAppointmentId: appointmentId,
              oldAppointmentRemainsNoShow: true,
            },
          },
          tx
        );
        return created.id;
      });
      if (!createdId) {
        return failure("appointments.toasts.failed");
      }
      revalidateAppointmentPages(existing.patientId);
      return success("appointments.toasts.rescheduled", createdId);
    }

    // Active states (SCHEDULED/CONFIRMED): the same logical plan moves in
    // place — nothing historical is destroyed. Update + audit in ONE tx.
    await db.transaction(async (tx) => {
      await tx
        .update(appointments)
        .set({
          doctorId: data.doctorId,
          appointmentDate: when,
          reason: data.reason ?? null,
          notes: data.notes ?? null,
          status: "SCHEDULED",
          updatedAt: new Date(),
        })
        .where(eq(appointments.id, appointmentId));

      await recordAudit(
        {
          userId: user.id,
          action: AUDIT_ACTIONS.APPOINTMENT_RESCHEDULED,
          entityType: "appointment",
          entityId: appointmentId,
          metadata: { patientId: existing.patientId },
        },
        tx
      );
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
