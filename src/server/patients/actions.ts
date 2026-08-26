"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { patients } from "@/db/schema";
import { requireUser } from "@/lib/auth/guards";
import { normalizePhone } from "@/lib/whatsapp";
import {
  patientFormSchema,
  validateWith,
} from "@/lib/validation";
import { AUDIT_ACTIONS, recordAudit } from "@/server/audit";
import { nextFileNumber } from "@/server/patients/file-number";
import { failure, success, type ActionResult } from "@/server/types";

/** Normalize mobile numbers to international (+967…) for storage. */
function normalizeMobile(value: string): string {
  const normalized = normalizePhone(value);
  if (!normalized.ok) {
    return value.trim(); // let DB validation surface the raw problem
  }
  return normalized.e164;
}

function revalidatePatientPages(patientId?: string) {
  revalidatePath("/patients");
  revalidatePath("/dashboard");
  revalidatePath("/follow-up");
  if (patientId) {
    revalidatePath(`/patients/${patientId}`);
  }
}

export type PatientFormValues = Record<string, string>;

export async function createPatientAction(
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireUser("/patients");

  const validation = validateWith(patientFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }
  const data = validation.data;

  let fileNumber: string;
  try {
    fileNumber = await nextFileNumber();
  } catch {
    return failure("common.serverError");
  }

  try {
    const [created] = await db
      .insert(patients)
      .values({
        fileNumber,
        fullName: data.fullName,
        gender: data.gender,
        dateOfBirth: data.dateOfBirth ?? null,
        mobile: normalizeMobile(data.mobile),
        alternateMobile: data.alternateMobile
          ? normalizeMobile(data.alternateMobile)
          : null,
        address: data.address ?? null,
        treatingDoctorId: data.treatingDoctorId ?? null,
        treatmentType: data.treatmentType ?? null,
        treatmentStatus: data.treatmentStatus,
        recallIntervalDays: data.recallIntervalDays,
        active: true,
        notes: data.notes ?? null,
      })
      .returning({ id: patients.id });

    if (!created) {
      return failure("common.serverError");
    }

    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.PATIENT_CREATED,
      entityType: "patient",
      entityId: created.id,
      metadata: { fileNumber, fullName: data.fullName },
    });

    revalidatePatientPages(created.id);
    return success("patients.toasts.created", created.id);
  } catch (error) {
    if (error instanceof Error && /patients_file_number_unique/.test(error.message)) {
      // Sequence guarantees uniqueness; this is purely defensive.
      return failure("common.serverError");
    }
    return failure("common.serverError");
  }
}

export async function updatePatientAction(
  patientId: string,
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireUser("/patients");

  const validation = validateWith(patientFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }
  const data = validation.data;

  const [existing] = await db
    .select({ id: patients.id })
    .from(patients)
    .where(eq(patients.id, patientId))
    .limit(1);
  if (!existing) {
    return failure("common.serverError");
  }

  try {
    await db
      .update(patients)
      .set({
        fullName: data.fullName,
        gender: data.gender,
        dateOfBirth: data.dateOfBirth ?? null,
        mobile: normalizeMobile(data.mobile),
        alternateMobile: data.alternateMobile
          ? normalizeMobile(data.alternateMobile)
          : null,
        address: data.address ?? null,
        treatingDoctorId: data.treatingDoctorId ?? null,
        treatmentType: data.treatmentType ?? null,
        treatmentStatus: data.treatmentStatus,
        recallIntervalDays: data.recallIntervalDays,
        notes: data.notes ?? null,
        updatedAt: new Date(),
      })
      .where(eq(patients.id, patientId));

    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.PATIENT_UPDATED,
      entityType: "patient",
      entityId: patientId,
      metadata: { fullName: data.fullName },
    });

    revalidatePatientPages(patientId);
    return success("patients.toasts.updated", patientId);
  } catch {
    return failure("common.serverError");
  }
}

export async function setPatientActiveAction(
  patientId: string,
  active: boolean
): Promise<ActionResult> {
  const user = await requireUser("/patients");

  const [existing] = await db
    .select({ id: patients.id, fullName: patients.fullName })
    .from(patients)
    .where(eq(patients.id, patientId))
    .limit(1);
  if (!existing) {
    return failure("common.serverError");
  }

  try {
    await db
      .update(patients)
      .set({ active, updatedAt: new Date() })
      .where(eq(patients.id, patientId));

    await recordAudit({
      userId: user.id,
      action: active
        ? AUDIT_ACTIONS.PATIENT_REACTIVATED
        : AUDIT_ACTIONS.PATIENT_ARCHIVED,
      entityType: "patient",
      entityId: patientId,
      metadata: { fullName: existing.fullName },
    });

    revalidatePatientPages(patientId);
    return success(
      active ? "patients.toasts.reactivated" : "patients.toasts.archived",
      patientId
    );
  } catch {
    return failure("common.serverError");
  }
}
