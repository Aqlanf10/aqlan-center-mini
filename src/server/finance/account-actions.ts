"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth/guards";
import {
  cashAccountFormSchema,
  expenseCategoryFormSchema,
  validateWith,
} from "@/lib/validation";
import { failure, success, type ActionResult } from "@/server/types";
import type { Actor } from "@/server/finance/vouchers";
import {
  createCashAccount,
  createExpenseCategory,
  setCashAccountActive,
  setExpenseCategoryActive,
  updateCashAccount,
  updateExpenseCategory,
} from "@/server/finance/accounts";

const ADMIN_ONLY = ["ADMIN"] as const;

function toActor(user: { id: string; role: string; name: string }): Actor {
  return { id: user.id, role: user.role as Actor["role"], name: user.name };
}

export async function createCashAccountAction(
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/finance/cash-accounts");
  const validation = validateWith(cashAccountFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const result = await createCashAccount(toActor(user), validation.data);
  if (!result.ok) {
    return failure("finance.accounts.errors.failed");
  }
  revalidatePath("/finance/cash-accounts");
  revalidatePath("/finance");
  return success("finance.accounts.toasts.created", result.id);
}

export async function updateCashAccountAction(
  accountId: string,
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/finance/cash-accounts");
  const validation = validateWith(cashAccountFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const result = await updateCashAccount(
    toActor(user),
    accountId,
    validation.data
  );
  if (!result.ok) {
    return failure("finance.accounts.errors.notFound");
  }
  revalidatePath("/finance/cash-accounts");
  return success("finance.accounts.toasts.updated", result.id);
}

export async function setCashAccountActiveAction(
  accountId: string,
  active: boolean
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/finance/cash-accounts");
  const result = await setCashAccountActive(toActor(user), accountId, active);
  if (!result.ok) {
    return failure("finance.accounts.errors.notFound");
  }
  revalidatePath("/finance/cash-accounts");
  return success(
    active
      ? "finance.accounts.toasts.reactivated"
      : "finance.accounts.toasts.archived",
    result.id
  );
}

export async function createExpenseCategoryAction(
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/finance/expense-categories");
  const validation = validateWith(expenseCategoryFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const result = await createExpenseCategory(toActor(user), validation.data);
  if (!result.ok) {
    return failure("finance.accounts.errors.failed");
  }
  revalidatePath("/finance/expense-categories");
  return success("finance.accounts.toasts.categoryCreated", result.id);
}

export async function updateExpenseCategoryAction(
  categoryId: string,
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/finance/expense-categories");
  const validation = validateWith(expenseCategoryFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const result = await updateExpenseCategory(
    toActor(user),
    categoryId,
    validation.data
  );
  if (!result.ok) {
    return failure("finance.accounts.errors.notFound");
  }
  revalidatePath("/finance/expense-categories");
  return success("finance.accounts.toasts.categoryUpdated", result.id);
}

export async function setExpenseCategoryActiveAction(
  categoryId: string,
  active: boolean
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/finance/expense-categories");
  const result = await setExpenseCategoryActive(
    toActor(user),
    categoryId,
    active
  );
  if (!result.ok) {
    return failure("finance.accounts.errors.notFound");
  }
  revalidatePath("/finance/expense-categories");
  return success(
    active
      ? "finance.accounts.toasts.categoryReactivated"
      : "finance.accounts.toasts.categoryArchived",
    result.id
  );
}
