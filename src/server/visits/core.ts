import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { appointments, visits } from "@/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/audit";
import { findExactTimeConflict } from "@/server/appointments/queries";
import { generateCommissionsForCompletedVisit } from "@/server/commissions/engine";
import type { Actor, TxClient } from "@/server/finance/vouchers";

/**
 * Visit lifecycle domain core.
 *
 * Every transition below is ONE PostgreSQL transaction that owns:
 *   - the row locks that make concurrent double-submission safe,
 *   - the clinical writes,
 *   - the linked appointment status updates,
 *   - the optional next appointment,
 *   - the audit rows.
 *
 * Audits are written INSIDE the same transaction: a committed movement can
 * never lack its audit entry, and a failed transaction can never leave an
 * audit row behind (no movement-without-audit, no audit-without-movement,
 * no duplicate audit under retry/concurrency).
 */

export type VisitStartResult =
  | { ok: true; visitId: string; created: boolean }
  | { ok: false; code: "notFound" | "invalidState" | "failed" };

export type VisitCreateResult =
  | { ok: true; visitId: string }
  | { ok: false; code: "appointmentHasVisit" | "failed" };

export type VisitSaveResult =
  | {
      ok: true;
      visitId: string;
      /** True when a concurrent request completed the visit first. */
      alreadyCompleted: boolean;
      nextAppointmentCreated: boolean;
      nextAppointmentId: string | null;
    }
  | { ok: false; code: "notFound" | "completedLocked" | "appointmentConflict" | "failed" };

/** Clinical fields shared by the draft-save and completion paths. */
export type VisitSaveData = {
  doctorId: string;
  visitDate: Date;
  chiefComplaint: string | null;
  treatmentPerformed: string;
  clinicalNotes: string | null;
  nextVisitPlan: string | null;
  nextAppointmentDate: Date | null;
};

/** True only for the one-visit-per-appointment database barrier. */
function isVisitAppointmentUniqueConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
  };
  if (candidate.code !== "23505") return false;
  const detail = `${String(candidate.constraint ?? "")} ${String(candidate.message ?? "")}`;
  return detail.includes("visits_appointment_unique");
}

/** True only for the active-appointment-per-doctor-time database barrier. */
function isAppointmentTimeUniqueConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
  };
  if (candidate.code !== "23505") return false;
  const detail = `${String(candidate.constraint ?? "")} ${String(candidate.message ?? "")}`;
  return detail.includes("appointments_doctor_time_active_unique");
}

async function findDraftVisitId(
  executor: typeof db | TxClient,
  appointmentId: string
): Promise<string | null> {
  const [row] = await executor
    .select({ id: visits.id })
    .from(visits)
    .where(and(eq(visits.appointmentId, appointmentId), eq(visits.status, "DRAFT")))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Start a visit from an appointment (ARRIVED/IN_TREATMENT → IN_TREATMENT)
 * and create the DRAFT visit in the SAME transaction.
 *
 * Concurrency: the appointment row is locked FOR UPDATE, so two concurrent
 * starts serialize; the second observes the first's draft visit and returns
 * it instead of creating a second row. The partial unique index
 * visits_appointment_unique remains the final database barrier.
 */
export async function startVisitForAppointment(
  actor: Actor,
  appointmentId: string
): Promise<VisitStartResult> {
  try {
    return await db.transaction(async (tx): Promise<VisitStartResult> => {
      const [appointment] = await tx
        .select({
          id: appointments.id,
          patientId: appointments.patientId,
          doctorId: appointments.doctorId,
          status: appointments.status,
        })
        .from(appointments)
        .where(eq(appointments.id, appointmentId))
        .limit(1)
        .for("update");

      if (!appointment) {
        return { ok: false, code: "notFound" };
      }
      if (appointment.status !== "ARRIVED" && appointment.status !== "IN_TREATMENT") {
        return { ok: false, code: "invalidState" };
      }

      // Already started? Return the existing draft — never a second visit.
      const existingDraftId = await findDraftVisitId(tx, appointmentId);
      if (existingDraftId) {
        return { ok: true, visitId: existingDraftId, created: false };
      }

      const now = new Date();
      const [created] = await tx
        .insert(visits)
        .values({
          patientId: appointment.patientId,
          doctorId: appointment.doctorId,
          appointmentId: appointment.id,
          visitDate: now,
          treatmentPerformed: "",
          status: "DRAFT",
          createdBy: actor.id,
        })
        .returning({ id: visits.id });

      if (!created) {
        return { ok: false, code: "failed" };
      }

      await tx
        .update(appointments)
        .set({ status: "IN_TREATMENT", updatedAt: now })
        .where(eq(appointments.id, appointmentId));

      await recordAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.VISIT_CREATED,
          entityType: "visit",
          entityId: created.id,
          metadata: { appointmentId, patientId: appointment.patientId },
        },
        tx
      );

      return { ok: true, visitId: created.id, created: true };
    });
  } catch (error) {
    // Lost a race against the database barrier: the draft exists — return it.
    if (isVisitAppointmentUniqueConflict(error)) {
      const existingDraftId = await findDraftVisitId(db, appointmentId);
      if (existingDraftId) {
        return { ok: true, visitId: existingDraftId, created: false };
      }
    }
    return { ok: false, code: "failed" };
  }
}

/** Create a standalone DRAFT visit (patient profile → New visit). */
export async function createStandaloneVisit(
  actor: Actor,
  input: {
    patientId: string;
    doctorId: string;
    appointmentId: string | null;
    visitDate: Date;
    chiefComplaint: string | null;
    treatmentPerformed: string;
    clinicalNotes: string | null;
    nextVisitPlan: string | null;
  }
): Promise<VisitCreateResult> {
  try {
    return await db.transaction(async (tx): Promise<VisitCreateResult> => {
      const [created] = await tx
        .insert(visits)
        .values({
          patientId: input.patientId,
          doctorId: input.doctorId,
          appointmentId: input.appointmentId,
          visitDate: input.visitDate,
          chiefComplaint: input.chiefComplaint,
          treatmentPerformed: input.treatmentPerformed,
          clinicalNotes: input.clinicalNotes,
          nextVisitPlan: input.nextVisitPlan,
          status: "DRAFT",
          createdBy: actor.id,
        })
        .returning({ id: visits.id });

      if (!created) {
        return { ok: false, code: "failed" };
      }

      if (input.appointmentId) {
        await tx
          .update(appointments)
          .set({ status: "IN_TREATMENT", updatedAt: new Date() })
          .where(eq(appointments.id, input.appointmentId));
      }

      await recordAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.VISIT_CREATED,
          entityType: "visit",
          entityId: created.id,
          metadata: { patientId: input.patientId },
        },
        tx
      );

      return { ok: true, visitId: created.id };
    });
  } catch (error) {
    if (isVisitAppointmentUniqueConflict(error)) {
      return { ok: false, code: "appointmentHasVisit" };
    }
    return { ok: false, code: "failed" };
  }
}

/** Save a DRAFT visit (no completion side effects). */
export async function saveVisitDraft(
  visitId: string,
  data: VisitSaveData
): Promise<VisitSaveResult> {
  try {
    return await db.transaction(async (tx): Promise<VisitSaveResult> => {
      const [row] = await tx
        .update(visits)
        .set({
          doctorId: data.doctorId,
          visitDate: data.visitDate,
          chiefComplaint: data.chiefComplaint,
          treatmentPerformed: data.treatmentPerformed,
          clinicalNotes: data.clinicalNotes,
          nextVisitPlan: data.nextVisitPlan,
          nextAppointmentDate: data.nextAppointmentDate,
          status: "DRAFT",
          updatedAt: new Date(),
        })
        .where(and(eq(visits.id, visitId), eq(visits.status, "DRAFT")))
        .returning({ id: visits.id });

      if (!row) {
        // Either the visit does not exist or it is already completed.
        const [existing] = await tx
          .select({ id: visits.id, status: visits.status })
          .from(visits)
          .where(eq(visits.id, visitId))
          .limit(1);
        if (!existing) {
          return { ok: false, code: "notFound" };
        }
        return { ok: false, code: "completedLocked" };
      }

      return {
        ok: true,
        visitId,
        alreadyCompleted: false,
        nextAppointmentCreated: false,
        nextAppointmentId: null,
      };
    });
  } catch {
    return { ok: false, code: "failed" };
  }
}

/**
 * Complete a visit — the append-only clinical + financial moment.
 *
 * ONE transaction, guarded by a row lock on the visit:
 *   1. SELECT … FOR UPDATE the visit row (concurrent completions serialize;
 *      the loser observes COMPLETED and exits with alreadyCompleted=true),
 *   2. update the visit (status COMPLETED, clinical fields),
 *   3. mark the linked appointment COMPLETED when present,
 *   4. generate WORK_VALUE commissions for the visit's work items
 *      (idempotent per work item, same transaction),
 *   5. create the optional next appointment (the active-appointment unique
 *      index is the race barrier; a conflict rolls the WHOLE completion back),
 *   6. audit rows for the completion and the next appointment — inside.
 *
 * Test seam: hooks.beforeNextAppointmentInsert runs right before the next
 * appointment insert and is never provided by production callers; it lets
 * integration tests prove full rollback after partial writes.
 */
export async function completeVisit(
  actor: Actor,
  visitId: string,
  data: VisitSaveData,
  hooks?: {
    beforeNextAppointmentInsert?: (tx: TxClient) => Promise<void>;
  }
): Promise<VisitSaveResult> {
  try {
    return await db.transaction(async (tx): Promise<VisitSaveResult> => {
      // Lock first, check state second — the double-completion barrier.
      const [existing] = await tx
        .select({
          id: visits.id,
          patientId: visits.patientId,
          appointmentId: visits.appointmentId,
          status: visits.status,
        })
        .from(visits)
        .where(eq(visits.id, visitId))
        .limit(1)
        .for("update");

      if (!existing) {
        return { ok: false, code: "notFound" };
      }
      if (existing.status === "COMPLETED") {
        return {
          ok: true,
          visitId,
          alreadyCompleted: true,
          nextAppointmentCreated: false,
          nextAppointmentId: null,
        };
      }

      // Re-check the exact-time conflict INSIDE the transaction so the
      // window between check and insert is as small as the driver allows;
      // the unique index closes the rest of the race.
      if (data.nextAppointmentDate) {
        const conflict = await findExactTimeConflict(
          data.doctorId,
          data.nextAppointmentDate,
          undefined,
          tx
        );
        if (conflict) {
          return { ok: false, code: "appointmentConflict" };
        }
      }

      const now = new Date();

      await tx
        .update(visits)
        .set({
          doctorId: data.doctorId,
          visitDate: data.visitDate,
          chiefComplaint: data.chiefComplaint,
          treatmentPerformed: data.treatmentPerformed,
          clinicalNotes: data.clinicalNotes,
          nextVisitPlan: data.nextVisitPlan,
          nextAppointmentDate: data.nextAppointmentDate,
          status: "COMPLETED",
          updatedAt: now,
        })
        .where(eq(visits.id, visitId));

      if (existing.appointmentId) {
        await tx
          .update(appointments)
          .set({ status: "COMPLETED", updatedAt: now })
          .where(eq(appointments.id, existing.appointmentId));
      }

      await generateCommissionsForCompletedVisit(tx, visitId, actor.id);

      let nextAppointmentId: string | null = null;
      if (data.nextAppointmentDate) {
        if (hooks?.beforeNextAppointmentInsert) {
          await hooks.beforeNextAppointmentInsert(tx);
        }

        const [createdNext] = await tx
          .insert(appointments)
          .values({
            patientId: existing.patientId,
            doctorId: data.doctorId,
            appointmentDate: data.nextAppointmentDate,
            reason: data.nextVisitPlan ?? null,
            status: "SCHEDULED",
            createdBy: actor.id,
          })
          .returning({ id: appointments.id });
        nextAppointmentId = createdNext?.id ?? null;
      }

      await recordAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.VISIT_COMPLETED,
          entityType: "visit",
          entityId: visitId,
          metadata: {
            patientId: existing.patientId,
            nextAppointmentCreated: nextAppointmentId !== null,
          },
        },
        tx
      );

      if (nextAppointmentId) {
        await recordAudit(
          {
            userId: actor.id,
            action: AUDIT_ACTIONS.APPOINTMENT_CREATED,
            entityType: "appointment",
            entityId: nextAppointmentId,
            metadata: {
              patientId: existing.patientId,
              source: "visit-completion",
            },
          },
          tx
        );
      }

      return {
        ok: true,
        visitId,
        alreadyCompleted: false,
        nextAppointmentCreated: nextAppointmentId !== null,
        nextAppointmentId,
      };
    });
  } catch (error) {
    if (isAppointmentTimeUniqueConflict(error)) {
      return { ok: false, code: "appointmentConflict" };
    }
    return { ok: false, code: "failed" };
  }
}

/** Test-support export: check whether a visit row is completed. */
export async function isVisitCompleted(visitId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: visits.status })
    .from(visits)
    .where(eq(visits.id, visitId))
    .limit(1);
  return row?.status === "COMPLETED";
}
