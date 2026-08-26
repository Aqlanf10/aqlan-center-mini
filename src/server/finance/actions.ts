"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { charges, payments } from "@/db/schema";
import { requireRole } from "@/lib/auth/guards";
import {
  chargeFormSchema,
  paymentFormSchema,
  validateWith,
} from "@/lib/validation";
import { AUDIT_ACTIONS, recordAudit } from "@/server/audit";
import { failure, success, type ActionResult } from "@/server/types";

/** Finance mutations are restricted to ADMIN and DOCTOR (server-side). */
const FINANCE_ROLES = ["ADMIN", "DOCTOR"] as const;

export async function createChargeAction(
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(FINANCE_ROLES, "/patients");

  const validation = validateWith(chargeFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }
  const data = validation.data;

  try {
    const [created] = await db
      .insert(charges)
      .values({
        patientId: data.patientId,
        amount: data.amount,
        currency: data.currency,
        description: data.description,
        createdBy: user.id,
      })
      .returning({ id: charges.id });
    if (!created) {
      return failure("finance.toasts.failed");
    }

    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.CHARGE_CREATED,
      entityType: "charge",
      entityId: created.id,
      metadata: { patientId: data.patientId, currency: data.currency },
    });

    revalidatePath(`/patients/${data.patientId}`);
    return success("finance.toasts.chargeCreated", created.id);
  } catch {
    return failure("finance.toasts.failed");
  }
}

export async function createPaymentAction(
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(FINANCE_ROLES, "/patients");

  const validation = validateWith(paymentFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }
  const data = validation.data;

  try {
    const [created] = await db
      .insert(payments)
      .values({
        patientId: data.patientId,
        amount: data.amount,
        currency: data.currency,
        description: data.description ?? null,
        createdBy: user.id,
      })
      .returning({ id: payments.id });
    if (!created) {
      return failure("finance.toasts.failed");
    }

    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.PAYMENT_CREATED,
      entityType: "payment",
      entityId: created.id,
      metadata: { patientId: data.patientId, currency: data.currency },
    });

    revalidatePath(`/patients/${data.patientId}`);
    return success("finance.toasts.paymentCreated", created.id);
  } catch {
    return failure("finance.toasts.failed");
  }
}
