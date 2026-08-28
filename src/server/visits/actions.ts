"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { visitCorrections, visits } from "@/db/schema";
import { requireUser } from "@/lib/auth/guards";
import { formatDateTimeLocalInput, parseDateTimeLocal } from "@/lib/datetime";
import { validateWith, visitCorrectionFormSchema, visitFormSchema } from "@/lib/validation";
import { AUDIT_ACTIONS, recordAudit } from "@/server/audit";
import { failure, success, type ActionResult } from "@/server/types";
import {
  completeVisit,
  createStandaloneVisit,
  saveVisitDraft,
  startVisitForAppointment,
} from "@/server/visits/core";

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
 * Start a visit from an ARRIVED appointment. Doctors and admins only
 * (server-side enforced). The transactional core guarantees one draft visit
 * per appointment even under concurrent starts; the action maps domain
 * results to user-facing messages.
 */
export async function startVisitAction(
  appointmentId: string
): Promise<ActionResult> {
  const user = await requireUser("/today");

  if (user.role === "RECEPTION") {
    return failure("errors.forbidden");
  }

  const result = await startVisitForAppointment(
    { id: user.id, role: user.role, name: user.name },
    appointmentId
  );

  if (!result.ok) {
    return failure("visits.toasts.failed");
  }

  revalidateVisitPages();
  return success("visits.toasts.created", result.visitId);
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

  const result = await createStandaloneVisit(
    { id: user.id, role: user.role, name: user.name },
    {
      patientId: data.patientId,
      doctorId: data.doctorId,
      appointmentId: data.appointmentId ?? null,
      visitDate: when,
      chiefComplaint: data.chiefComplaint ?? null,
      treatmentPerformed: data.treatmentPerformed,
      clinicalNotes: data.clinicalNotes ?? null,
      nextVisitPlan: data.nextVisitPlan ?? null,
    }
  );

  if (!result.ok) {
    if (result.code === "appointmentHasVisit") {
      return failure("visits.toasts.appointmentAlreadyHasVisit");
    }
    return failure("visits.toasts.failed");
  }

  revalidateVisitPages(data.patientId);
  return success("visits.toasts.created", result.visitId);
}

/**
 * Save a visit (draft or completed). Domain results are mapped to messages:
 *  - alreadyCompleted: a concurrent request completed the visit first —
 *    the caller gets the normal completed toast (idempotent outcome).
 *  - completedLocked: completed visits are immutable; corrections are
 *    appended via appendVisitCorrectionAction instead.
 *  - appointmentConflict: the next appointment collides with an existing
 *    one; NOTHING from this completion was written.
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
  }

  const saveData = {
    doctorId: data.doctorId,
    visitDate: when,
    chiefComplaint: data.chiefComplaint ?? null,
    treatmentPerformed: data.treatmentPerformed,
    clinicalNotes: data.clinicalNotes ?? null,
    nextVisitPlan: data.nextVisitPlan ?? null,
    nextAppointmentDate: nextAppointmentInstant,
  };

  const result = complete
    ? await completeVisit(
        { id: user.id, role: user.role, name: user.name },
        visitId,
        saveData
      )
    : await saveVisitDraft(visitId, saveData);

  if (!result.ok) {
    if (result.code === "completedLocked") {
      return failure("visits.toasts.completedLocked");
    }
    if (result.code === "appointmentConflict") {
      return failure("appointments.conflictError", {
        nextAppointmentDate: "appointments.conflictError",
      });
    }
    return failure("visits.toasts.failed");
  }

  revalidateVisitPages(data.patientId);
  if (complete) {
    return success(
      result.nextAppointmentCreated
        ? "visits.toasts.completedWithNext"
        : "visits.toasts.completed",
      visitId
    );
  }
  return success("visits.toasts.created", visitId);
}

/**
 * Append an audited correction to a COMPLETED visit (ADMIN only).
 *
 * Completed visits are immutable — this never edits the original clinical
 * fields. The correction lands in `visit_corrections` (append-only) plus the
 * audit log (same transaction), and is displayed on the visit page under
 * the original data.
 */
export async function appendVisitCorrectionAction(
  visitId: string,
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireUser("/visits");

  if (user.role !== "ADMIN") {
    return failure("errors.forbidden");
  }

  const validation = validateWith(visitCorrectionFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }
  const data = validation.data;

  const [existing] = await db
    .select({ id: visits.id, patientId: visits.patientId, status: visits.status })
    .from(visits)
    .where(eq(visits.id, visitId))
    .limit(1);
  if (!existing) {
    return failure("visits.toasts.failed");
  }
  // Corrections only make sense for completed visits — drafts are still editable.
  if (existing.status !== "COMPLETED") {
    return failure("visits.toasts.correctionRequiresCompleted");
  }

  try {
    const correctionId = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(visitCorrections)
        .values({
          visitId,
          note: data.note,
          reason: data.reason,
          createdBy: user.id,
        })
        .returning({ id: visitCorrections.id });
      if (!created) {
        return null;
      }

      await recordAudit(
        {
          userId: user.id,
          action: AUDIT_ACTIONS.VISIT_CORRECTION_APPENDED,
          entityType: "visit",
          entityId: visitId,
          metadata: { correctionId: created.id, patientId: existing.patientId },
        },
        tx
      );
      return created.id;
    });

    if (!correctionId) {
      return failure("visits.toasts.failed");
    }

    revalidatePath(`/visits/${visitId}`);
    revalidatePath(`/patients/${existing.patientId}`);
    return success("visits.toasts.correctionAdded", correctionId);
  } catch {
    return failure("visits.toasts.failed");
  }
}
