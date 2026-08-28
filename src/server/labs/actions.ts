"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth/guards";
import { parseDateTimeLocal } from "@/lib/datetime";
import {
  labCaseFormSchema,
  labFormSchema,
  labInvoiceFormSchema,
  validateWith,
} from "@/lib/validation";
import { failure, success, type ActionResult } from "@/server/types";
import type { Actor } from "@/server/finance/vouchers";
import {
  createLab,
  createLabCase,
  invoiceLabCase,
  setLabActive,
  updateLab,
  updateLabCase,
} from "@/server/labs/labs";

const ADMIN_ONLY = ["ADMIN"] as const;

function toActor(user: { id: string; role: string; name: string }): Actor {
  return { id: user.id, role: user.role as Actor["role"], name: user.name };
}

export async function createLabAction(
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/labs");
  const validation = validateWith(labFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const result = await createLab(toActor(user), validation.data);
  if (!result.ok) {
    return failure("labs.errors.failed");
  }
  revalidatePath("/labs");
  return success("labs.toasts.created", result.id);
}

export async function updateLabAction(
  labId: string,
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/labs");
  const validation = validateWith(labFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const result = await updateLab(toActor(user), labId, validation.data);
  if (!result.ok) {
    return failure("labs.errors.notFound");
  }
  revalidatePath("/labs");
  return success("labs.toasts.updated", result.id);
}

export async function setLabActiveAction(
  labId: string,
  active: boolean
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/labs");
  const result = await setLabActive(toActor(user), labId, active);
  if (!result.ok) {
    return failure("labs.errors.notFound");
  }
  revalidatePath("/labs");
  return success(
    active ? "labs.toasts.reactivated" : "labs.toasts.archived",
    result.id
  );
}

export async function createLabCaseAction(
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/labs");
  const validation = validateWith(labCaseFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }
  const data = validation.data;

  const result = await createLabCase(toActor(user), {
    labId: data.labId,
    patientId: data.patientId,
    visitId: data.visitId || null,
    doctorId: data.doctorId,
    serviceId: data.serviceId || null,
    workType: data.workType,
    cost: data.cost,
    currency: data.currency,
    status: data.status,
    sentAt: data.sentAt ? parseDateTimeLocal(`${data.sentAt}T00:00`) : new Date(),
    expectedDeliveryAt: data.expectedDeliveryAt
      ? parseDateTimeLocal(`${data.expectedDeliveryAt}T00:00`)
      : null,
    notes: data.notes ?? null,
  });

  if (!result.ok) {
    return failure("labs.errors.caseFailed");
  }
  revalidatePath("/labs");
  return success("labs.toasts.caseCreated", result.id);
}

export async function updateLabCaseAction(
  caseId: string,
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/labs");
  const validation = validateWith(labCaseFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }
  const data = validation.data;

  const result = await updateLabCase(toActor(user), caseId, {
    labId: data.labId,
    visitId: data.visitId || null,
    doctorId: data.doctorId,
    serviceId: data.serviceId || null,
    workType: data.workType,
    cost: data.cost,
    currency: data.currency,
    status: data.status,
    sentAt: data.sentAt ? parseDateTimeLocal(`${data.sentAt}T00:00`) : null,
    expectedDeliveryAt: data.expectedDeliveryAt
      ? parseDateTimeLocal(`${data.expectedDeliveryAt}T00:00`)
      : null,
    notes: data.notes ?? null,
  });

  if (!result.ok) {
    return failure("labs.errors.notFound");
  }
  revalidatePath("/labs");
  return success("labs.toasts.caseUpdated", result.id);
}

export async function invoiceLabCaseAction(
  caseId: string,
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/labs");
  const validation = validateWith(labInvoiceFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const result = await invoiceLabCase(toActor(user), caseId, {
    invoiceNumber: validation.data.invoiceNumber ?? null,
    invoiceAmount: validation.data.invoiceAmount ?? null,
  });
  if (!result.ok) {
    return failure(
      result.code === "duplicate" ? "labs.errors.alreadyInvoiced" : "labs.errors.notFound"
    );
  }
  revalidatePath("/labs");
  return success("labs.toasts.invoiced", result.id);
}
