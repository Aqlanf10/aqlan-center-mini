"use server";

import { and, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { appointments, visits } from "@/db/schema";
import { requireUser } from "@/lib/auth/guards";
import { formatDateTimeLocalInput, parseDateTimeLocal } from "@/lib/datetime";
import { validateWith, visitFormSchema } from "@/lib/validation";
import { AUDIT_ACTIONS, recordAudit } from "@/server/audit";
import { findExactTimeConflict } from "@/server/appointments/queries";
import { failure, success, type ActionResult } from "@/server/types";

function revalidateVisitPages(patientId?: string) {
  revalidatePath("/today");
  revalidatePath("/dashboard");
  revalidatePath("/follow-up");
  revalidatePath("/patients");
  if (patientId) {
    revalidatePath(`/patients/${patientId}`);
  }
}

/**
 * Start a visit from an ARRIVED appointment:
 * atomically (single batch) create the DRAFT visit and move the
 * appointment to IN_TREATMENT. Returns the visit id for navigation.
 * Doctors and admins only (server-side enforced).
 */
export async function startVisitAction(
  appointmentId: string
): Promise<ActionResult> {
  const user = await requireUser("/today");

  if (user.role === "RECEPTION") {
    return failure("errors.forbidden");
  }

  const [appointment] = await db
    .select({
      id: appointments.id,
      patientId: appointments.patientId,
      doctorId: appointments.doctorId,
      status: appointments.status,
    })
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1);

  if (!appointment) {
    return failure("visits.toasts.failed");
  }
  if (appointment.status !== "ARRIVED" && appointment.status !== "IN_TREATMENT") {
    return failure("visits.toasts.failed");
  }

  // Already started? Reopen the existing draft instead of duplicating.
  const [existingDraft] = await db
    .select({ id: visits.id })
    .from(visits)
    .where(
      and(eq(visits.appointmentId, appointmentId), eq(visits.status, "DRAFT"))
    )
    .limit(1);
  if (existingDraft) {
    return success("visits.toasts.created", existingDraft.id);
  }

  const now = new Date();

  try {
    const [created] = await db
      .insert(visits)
      .values({
        patientId: appointment.patientId,
        doctorId: appointment.doctorId,
        appointmentId: appointment.id,
        visitDate: now,
        treatmentPerformed: "",
        status: "DRAFT",
        createdBy: user.id,
      })
      .returning({ id: visits.id });

    if (!created) {
      return failure("visits.toasts.failed");
    }

    // Move appointment to IN_TREATMENT in the same flow (batch = atomic).
    await db.batch([
      db
        .update(appointments)
        .set({ status: "IN_TREATMENT", updatedAt: now })
        .where(eq(appointments.id, appointmentId)),
    ]);

    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.VISIT_CREATED,
      entityType: "visit",
      entityId: created.id,
      metadata: { appointmentId, patientId: appointment.patientId },
    });

    revalidateVisitPages(appointment.patientId);
    return success("visits.toasts.created", created.id);
  } catch {
    return failure("visits.toasts.failed");
  }
}

/** Create a standalone visit draft (patient profile -> New visit). */
export async function createDraftVisitAction(
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireUser("/patients");

  if (user.role === "RECEPTION") {
    return failure("errors.forbidden");
  }

  // Empty visit date means "now" — resolved on the SERVER in the clinic
  // timezone so a browser in another timezone can never skew the instant.
  const normalizedInput = {
    ...input,
    visitDate: input.visitDate?.trim()
      ? input.visitDate
      : formatDateTimeLocalInput(new Date()),
  };

  const validation = validateWith(visitFormSchema, normalizedInput);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }
  const data = validation.data;

  const when = parseDateTimeLocal(data.visitDate);
  if (!when) {
    return failure("common.serverError", { visitDate: "validation.datetimeInvalid" });
  }

  try {
    const [created] = await db
      .insert(visits)
      .values({
        patientId: data.patientId,
        doctorId: data.doctorId,
        appointmentId: data.appointmentId ?? null,
        visitDate: when,
        chiefComplaint: data.chiefComplaint ?? null,
        treatmentPerformed: data.treatmentPerformed,
        clinicalNotes: data.clinicalNotes ?? null,
        nextVisitPlan: data.nextVisitPlan ?? null,
        status: "DRAFT",
        createdBy: user.id,
      })
      .returning({ id: visits.id });

    if (!created) {
      return failure("visits.toasts.failed");
    }

    if (data.appointmentId) {
      await db
        .update(appointments)
        .set({ status: "IN_TREATMENT", updatedAt: new Date() })
        .where(eq(appointments.id, data.appointmentId));
    }

    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.VISIT_CREATED,
      entityType: "visit",
      entityId: created.id,
      metadata: { patientId: data.patientId },
    });

    revalidateVisitPages(data.patientId);
    return success("visits.toasts.created", created.id);
  } catch {
    return failure("visits.toasts.failed");
  }
}

/**
 * Save a visit (draft or completed). Completing runs as ONE atomic batch:
 *  1. update the visit row (status COMPLETED, clinical fields),
 *  2. link the appointment to COMPLETED when appropriate,
 *  3. optionally create the next appointment.
 * A missing next appointment never blocks completion — the patient simply
 * lands in the Follow-up "No next appointment" queue.
 */
export async function saveVisitAction(
  visitId: string,
  input: Record<string, string>,
  complete: boolean
): Promise<ActionResult> {
  const user = await requireUser("/today");

  if (user.role === "RECEPTION") {
    return failure("errors.forbidden");
  }

  const validation = validateWith(visitFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }
  const data = validation.data;

  // Completing requires the treatment actually performed to be recorded.
  if (complete && !data.treatmentPerformed) {
    return failure("common.serverError", {
      treatmentPerformed: "validation.treatmentPerformedRequired",
    });
  }

  const [existing] = await db
    .select({
      id: visits.id,
      patientId: visits.patientId,
      status: visits.status,
      appointmentId: visits.appointmentId,
    })
    .from(visits)
    .where(eq(visits.id, visitId))
    .limit(1);
  if (!existing) {
    return failure("visits.toasts.failed");
  }

  const when = parseDateTimeLocal(data.visitDate);
  if (!when) {
    return failure("common.serverError", { visitDate: "validation.datetimeInvalid" });
  }

  let nextAppointmentInstant: Date | null = null;
  if (complete && data.nextAppointmentDate) {
    nextAppointmentInstant = parseDateTimeLocal(data.nextAppointmentDate);
    if (!nextAppointmentInstant) {
      return failure("common.serverError", {
        nextAppointmentDate: "validation.datetimeInvalid",
      });
    }
    const conflict = await findExactTimeConflict(
      data.doctorId,
      nextAppointmentInstant
    );
    if (conflict) {
      return failure("appointments.conflictError", {
        nextAppointmentDate: "appointments.conflictError",
      });
    }
  }

  const now = new Date();

  try {
    if (!complete) {
      await db
        .update(visits)
        .set({
          doctorId: data.doctorId,
          visitDate: when,
          chiefComplaint: data.chiefComplaint ?? null,
          treatmentPerformed: data.treatmentPerformed,
          clinicalNotes: data.clinicalNotes ?? null,
          nextVisitPlan: data.nextVisitPlan ?? null,
          nextAppointmentDate: nextAppointmentInstant,
          status: "DRAFT",
          updatedAt: now,
        })
        .where(eq(visits.id, visitId));

      revalidateVisitPages(existing.patientId);
      return success("visits.toasts.created", visitId);
    }

    // Atomic completion (single Neon batch = single transaction):
    // visit update + linked appointment COMPLETED + optional next
    // appointment all succeed or all roll back together.
    const statements: BatchItem<"pg">[] = [
      db
        .update(visits)
        .set({
          doctorId: data.doctorId,
          visitDate: when,
          chiefComplaint: data.chiefComplaint ?? null,
          treatmentPerformed: data.treatmentPerformed,
          clinicalNotes: data.clinicalNotes ?? null,
          nextVisitPlan: data.nextVisitPlan ?? null,
          nextAppointmentDate: nextAppointmentInstant,
          status: "COMPLETED",
          updatedAt: now,
        })
        .where(eq(visits.id, visitId)),
    ];

    if (existing.appointmentId) {
      statements.push(
        db
          .update(appointments)
          .set({ status: "COMPLETED", updatedAt: now })
          .where(eq(appointments.id, existing.appointmentId))
      );
    }

    if (nextAppointmentInstant) {
      statements.push(
        db
          .insert(appointments)
          .values({
            patientId: existing.patientId,
            doctorId: data.doctorId,
            appointmentDate: nextAppointmentInstant,
            reason: data.nextVisitPlan ?? null,
            status: "SCHEDULED",
            createdBy: user.id,
          })
          .returning({ id: appointments.id })
      );
    }

    const [first, ...rest] = statements;
    if (!first) {
      return failure("visits.toasts.failed");
    }
    const results = await db.batch([first, ...rest]);
    const insertResult = nextAppointmentInstant
      ? (results[results.length - 1] as { id: string }[] | undefined)
      : undefined;
    const createdAppointmentId = insertResult?.[0]?.id;

    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.VISIT_COMPLETED,
      entityType: "visit",
      entityId: visitId,
      metadata: {
        patientId: existing.patientId,
        nextAppointmentCreated: Boolean(nextAppointmentInstant),
      },
    });
    if (nextAppointmentInstant && createdAppointmentId) {
      await recordAudit({
        userId: user.id,
        action: AUDIT_ACTIONS.APPOINTMENT_CREATED,
        entityType: "appointment",
        entityId: createdAppointmentId,
        metadata: {
          patientId: existing.patientId,
          source: "visit-completion",
        },
      });
    }

    revalidateVisitPages(existing.patientId);
    return success(
      nextAppointmentInstant
        ? "visits.toasts.completedWithNext"
        : "visits.toasts.completed",
      visitId
    );
  } catch (error) {
    if (
      error instanceof Error &&
      /appointments_doctor_time_active_unique/i.test(error.message)
    ) {
      return failure("appointments.conflictError", {
        nextAppointmentDate: "appointments.conflictError",
      });
    }
    return failure("visits.toasts.failed");
  }
}
