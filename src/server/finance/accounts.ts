import { and, asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { cashAccounts, expenseCategories } from "@/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/audit";
import type { Actor } from "@/server/finance/vouchers";

export type AccountResult =
  | { ok: true; id: string }
  | { ok: false; code: "notFound" | "duplicate" | "hasVouchers" };

/* ------------------------------------------------------------------ */
/* Cash accounts                                                       */
/* ------------------------------------------------------------------ */

export async function listCashAccounts(includeArchived = false) {
  return db
    .select()
    .from(cashAccounts)
    .where(includeArchived ? undefined : eq(cashAccounts.active, true))
    .orderBy(asc(cashAccounts.currency), asc(cashAccounts.name));
}

export async function createCashAccount(
  actor: Actor,
  input: { name: string; currency: "YER" | "SAR" | "USD"; type: "CASH" | "BANK" }
): Promise<AccountResult> {
  try {
    const id = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(cashAccounts)
        .values({ ...input, active: true })
        .returning({ id: cashAccounts.id });
      if (!created) return null;

      await recordAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.CASH_ACCOUNT_CREATED,
          entityType: "cash_account",
          entityId: created.id,
          metadata: { currency: input.currency, type: input.type },
        },
        tx
      );
      return created.id;
    });
    return id ? { ok: true, id } : { ok: false, code: "duplicate" };
  } catch {
    return { ok: false, code: "duplicate" };
  }
}

export async function updateCashAccount(
  actor: Actor,
  accountId: string,
  input: { name: string; type: "CASH" | "BANK" }
): Promise<AccountResult> {
  const [existing] = await db
    .select({ id: cashAccounts.id })
    .from(cashAccounts)
    .where(eq(cashAccounts.id, accountId))
    .limit(1);
  if (!existing) {
    return { ok: false, code: "notFound" };
  }

  await db
    .update(cashAccounts)
    .set({ name: input.name, type: input.type, updatedAt: new Date() })
    .where(eq(cashAccounts.id, accountId));

  await recordAudit({
    userId: actor.id,
    action: AUDIT_ACTIONS.CASH_ACCOUNT_UPDATED,
    entityType: "cash_account",
    entityId: accountId,
    metadata: { name: input.name, type: input.type },
  });

  return { ok: true, id: accountId };
}

/**
 * Archive/restore a cash account. Archiving is refused while ACTIVE
 * vouchers still reference the account (history must stay reachable, but a
 * live account with movements simply stays active).
 */
export async function setCashAccountActive(
  actor: Actor,
  accountId: string,
  active: boolean
): Promise<AccountResult> {
  const [existing] = await db
    .select({ id: cashAccounts.id })
    .from(cashAccounts)
    .where(eq(cashAccounts.id, accountId))
    .limit(1);
  if (!existing) {
    return { ok: false, code: "notFound" };
  }

  await db
    .update(cashAccounts)
    .set({ active, updatedAt: new Date() })
    .where(eq(cashAccounts.id, accountId));

  await recordAudit({
    userId: actor.id,
    action: active
      ? AUDIT_ACTIONS.CASH_ACCOUNT_REACTIVATED
      : AUDIT_ACTIONS.CASH_ACCOUNT_ARCHIVED,
    entityType: "cash_account",
    entityId: accountId,
  });

  return { ok: true, id: accountId };
}

/* ------------------------------------------------------------------ */
/* Expense categories                                                  */
/* ------------------------------------------------------------------ */

export async function listExpenseCategories(includeArchived = false) {
  return db
    .select()
    .from(expenseCategories)
    .where(
      includeArchived ? undefined : eq(expenseCategories.active, true)
    )
    .orderBy(asc(expenseCategories.nameAr));
}

export async function createExpenseCategory(
  actor: Actor,
  input: { nameAr: string; nameEn: string }
): Promise<AccountResult> {
  try {
    const id = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(expenseCategories)
        .values({ ...input, active: true })
        .returning({ id: expenseCategories.id });
      if (!created) return null;
      await recordAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.EXPENSE_CATEGORY_CREATED,
          entityType: "expense_category",
          entityId: created.id,
        },
        tx
      );
      return created.id;
    });
    return id ? { ok: true, id } : { ok: false, code: "duplicate" };
  } catch {
    return { ok: false, code: "duplicate" };
  }
}

export async function updateExpenseCategory(
  actor: Actor,
  categoryId: string,
  input: { nameAr: string; nameEn: string }
): Promise<AccountResult> {
  const [existing] = await db
    .select({ id: expenseCategories.id })
    .from(expenseCategories)
    .where(eq(expenseCategories.id, categoryId))
    .limit(1);
  if (!existing) {
    return { ok: false, code: "notFound" };
  }

  await db
    .update(expenseCategories)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(expenseCategories.id, categoryId));

  await recordAudit({
    userId: actor.id,
    action: AUDIT_ACTIONS.EXPENSE_CATEGORY_UPDATED,
    entityType: "expense_category",
    entityId: categoryId,
  });

  return { ok: true, id: categoryId };
}

export async function setExpenseCategoryActive(
  actor: Actor,
  categoryId: string,
  active: boolean
): Promise<AccountResult> {
  const [existing] = await db
    .select({ id: expenseCategories.id })
    .from(expenseCategories)
    .where(and(eq(expenseCategories.id, categoryId)))
    .limit(1);
  if (!existing) {
    return { ok: false, code: "notFound" };
  }

  await db
    .update(expenseCategories)
    .set({ active, updatedAt: new Date() })
    .where(eq(expenseCategories.id, categoryId));

  await recordAudit({
    userId: actor.id,
    action: active
      ? AUDIT_ACTIONS.EXPENSE_CATEGORY_REACTIVATED
      : AUDIT_ACTIONS.EXPENSE_CATEGORY_ARCHIVED,
    entityType: "expense_category",
    entityId: categoryId,
  });

  return { ok: true, id: categoryId };
}
