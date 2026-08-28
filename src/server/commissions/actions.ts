"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth/guards";
import {
  commissionAmountFormSchema,
  commissionPlanFormSchema,
  commissionReversalFormSchema,
  validateWith,
} from "@/lib/validation";
import { failure, success, type ActionResult } from "@/server/types";
import type { Actor } from "@/server/finance/vouchers";
import {
  approveCommission,
  deletePlan,
  listCommissions,
  listPlans,
  payCommission,
  reverseCommission,
  savePlan,
  setCommissionAmount,
} from "@/server/commissions/engine";

const ADMIN_ONLY = ["ADMIN"] as const;

function toActor(user: { id: string; role: string; name: string }): Actor {
  return { id: user.id, role: user.role as Actor["role"], name: user.name };
}

function revalidateCommissionPages() {
  revalidatePath("/finance/commissions");
  revalidatePath("/my-work");
  revalidatePath("/finance");
}

export async function saveCommissionPlanAction(
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/finance/commissions");
  const validation = validateWith(commissionPlanFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const result = await savePlan(toActor(user), {
    doctorId: validation.data.doctorId,
    serviceId: validation.data.serviceId || null,
    basis: validation.data.basis,
    type: validation.data.type,
    value: validation.data.value,
  });
  if (!result.ok) {
    return failure("commissions.errors.failed");
  }
  revalidateCommissionPages();
  return success("commissions.toasts.planSaved", result.id);
}

export async function deleteCommissionPlanAction(
  planId: string
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/finance/commissions");
  const result = await deletePlan(toActor(user), planId);
  if (!result.ok) {
    return failure("commissions.errors.notFound");
  }
  revalidateCommissionPages();
  return success("commissions.toasts.planDeleted", planId);
}

export async function setCommissionAmountAction(
  commissionId: string,
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/finance/commissions");
  const validation = validateWith(commissionAmountFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const result = await setCommissionAmount(
    toActor(user),
    commissionId,
    validation.data.amount
  );
  if (!result.ok) {
    return failure(`commissions.errors.${result.code}`);
  }
  revalidateCommissionPages();
  return success("commissions.toasts.amountSet", result.id);
}

export async function approveCommissionAction(
  commissionId: string
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/finance/commissions");
  const result = await approveCommission(toActor(user), commissionId);
  if (!result.ok) {
    return failure(`commissions.errors.${result.code}`);
  }
  revalidateCommissionPages();
  return success("commissions.toasts.approved", result.id);
}

export async function payCommissionAction(
  commissionId: string,
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/finance/commissions");
  const cashAccountId = input.cashAccountId?.trim();
  const paymentMethod = input.paymentMethod?.trim() as
    | "CASH"
    | "TRANSFER"
    | "CARD"
    | "OTHER"
    | undefined;

  if (!cashAccountId || !paymentMethod) {
    return failure("common.serverError", {
      cashAccountId: cashAccountId ? undefined : "required",
      paymentMethod: paymentMethod ? undefined : "required",
    } as Record<string, string>);
  }

  const result = await payCommission(toActor(user), commissionId, {
    cashAccountId,
    paymentMethod,
    description: input.description?.trim() || null,
    reference: input.reference?.trim() || null,
    idempotencyKey: input.idempotencyKey?.trim() || null,
  });
  if (!result.ok) {
    return failure(`commissions.errors.${result.code}`);
  }
  revalidateCommissionPages();
  revalidatePath("/finance/vouchers");
  return success("commissions.toasts.paid", result.id);
}

export async function reverseCommissionAction(
  commissionId: string,
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/finance/commissions");
  const validation = validateWith(commissionReversalFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const result = await reverseCommission(
    toActor(user),
    commissionId,
    validation.data.reason
  );
  if (!result.ok) {
    return failure(`commissions.errors.${result.code}`);
  }
  revalidateCommissionPages();
  return success("commissions.toasts.reversed", result.id);
}

/* ------------------------------------------------------------------ */
/* Doctor self-service queries (no actions — read-only pages)          */
/* ------------------------------------------------------------------ */

export async function listMyCommissionsAction() {
  const user = await requireRole(["DOCTOR", "ADMIN"] as const, "/my-work");
  return listCommissions({ doctorId: user.id, limit: 100 });
}

export async function listMyPlansAction() {
  await requireRole(ADMIN_ONLY, "/finance/commissions");
  return listPlans();
}
