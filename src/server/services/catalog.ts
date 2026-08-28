import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { serviceCategories, services } from "@/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/audit";
import type { Actor } from "@/server/finance/vouchers";

export type CatalogResult =
  | { ok: true; id: string }
  | { ok: false; code: "notFound" | "duplicate" | "inUse" };

/* ------------------------------------------------------------------ */
/* Service categories                                                  */
/* ------------------------------------------------------------------ */

export function listServiceCategories(includeArchived = false) {
  return db
    .select()
    .from(serviceCategories)
    .where(includeArchived ? undefined : eq(serviceCategories.active, true))
    .orderBy(asc(serviceCategories.sortOrder), asc(serviceCategories.nameAr));
}

export async function createServiceCategory(
  actor: Actor,
  input: { nameAr: string; nameEn: string; sortOrder?: number }
): Promise<CatalogResult> {
  try {
    const id = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(serviceCategories)
        .values({
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          sortOrder: input.sortOrder ?? 100,
          active: true,
        })
        .returning({ id: serviceCategories.id });
      if (!created) return null;
      await recordAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.SERVICE_CATEGORY_CREATED,
          entityType: "service_category",
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

export async function updateServiceCategory(
  actor: Actor,
  categoryId: string,
  input: { nameAr: string; nameEn: string; sortOrder?: number }
): Promise<CatalogResult> {
  const [existing] = await db
    .select({ id: serviceCategories.id })
    .from(serviceCategories)
    .where(eq(serviceCategories.id, categoryId))
    .limit(1);
  if (!existing) {
    return { ok: false, code: "notFound" };
  }

  await db
    .update(serviceCategories)
    .set({
      nameAr: input.nameAr,
      nameEn: input.nameEn,
      sortOrder: input.sortOrder ?? 100,
      updatedAt: new Date(),
    })
    .where(eq(serviceCategories.id, categoryId));

  await recordAudit({
    userId: actor.id,
    action: AUDIT_ACTIONS.SERVICE_CATEGORY_UPDATED,
    entityType: "service_category",
    entityId: categoryId,
  });

  return { ok: true, id: categoryId };
}

/** Archive instead of delete; refuse while any service still uses it. */
export async function setServiceCategoryActive(
  actor: Actor,
  categoryId: string,
  active: boolean
): Promise<CatalogResult> {
  if (!active) {
    const countRows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(services)
      .where(eq(services.categoryId, categoryId));
    if ((countRows[0]?.n ?? 0) > 0) {
      return { ok: false, code: "inUse" };
    }
  }

  await db
    .update(serviceCategories)
    .set({ active, updatedAt: new Date() })
    .where(eq(serviceCategories.id, categoryId));

  await recordAudit({
    userId: actor.id,
    action: active
      ? AUDIT_ACTIONS.SERVICE_CATEGORY_REACTIVATED
      : AUDIT_ACTIONS.SERVICE_CATEGORY_ARCHIVED,
    entityType: "service_category",
    entityId: categoryId,
  });

  return { ok: true, id: categoryId };
}

/* ------------------------------------------------------------------ */
/* Services                                                            */
/* ------------------------------------------------------------------ */

export type ServiceRow = {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  categoryId: string | null;
  categoryNameAr: string | null;
  categoryNameEn: string | null;
  defaultPrice: string | null;
  currency: "YER" | "SAR" | "USD";
  commissionEligible: boolean;
  defaultCommissionType: "PERCENT" | "FIXED" | null;
  defaultCommissionValue: string | null;
  active: boolean;
};

export async function listServices(options?: {
  includeArchived?: boolean;
  categoryId?: string;
}): Promise<ServiceRow[]> {
  const conditions = [];
  if (!options?.includeArchived) {
    conditions.push(eq(services.active, true));
  }
  if (options?.categoryId) {
    conditions.push(eq(services.categoryId, options.categoryId));
  }

  const rows = await db
    .select({
      id: services.id,
      code: services.code,
      nameAr: services.nameAr,
      nameEn: services.nameEn,
      categoryId: services.categoryId,
      categoryNameAr: serviceCategories.nameAr,
      categoryNameEn: serviceCategories.nameEn,
      defaultPrice: services.defaultPrice,
      currency: services.currency,
      commissionEligible: services.commissionEligible,
      defaultCommissionType: services.defaultCommissionType,
      defaultCommissionValue: services.defaultCommissionValue,
      active: services.active,
    })
    .from(services)
    .leftJoin(serviceCategories, eq(services.categoryId, serviceCategories.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(services.code));

  return rows as ServiceRow[];
}

export type ServiceInput = {
  code: string;
  nameAr: string;
  nameEn: string;
  categoryId?: string | null;
  defaultPrice?: string | null;
  currency: "YER" | "SAR" | "USD";
  commissionEligible: boolean;
  defaultCommissionType?: "PERCENT" | "FIXED" | null;
  defaultCommissionValue?: string | null;
};

export async function createService(
  actor: Actor,
  input: ServiceInput
): Promise<CatalogResult> {
  try {
    const id = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(services)
        .values({
          code: input.code,
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          categoryId: input.categoryId ?? null,
          defaultPrice: input.defaultPrice ?? null,
          currency: input.currency,
          commissionEligible: input.commissionEligible,
          defaultCommissionType: input.defaultCommissionType ?? null,
          defaultCommissionValue: input.defaultCommissionValue ?? null,
          active: true,
        })
        .returning({ id: services.id });
      if (!created) return null;
      await recordAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.SERVICE_CREATED,
          entityType: "service",
          entityId: created.id,
          metadata: { code: input.code, currency: input.currency },
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

export async function updateService(
  actor: Actor,
  serviceId: string,
  input: ServiceInput
): Promise<CatalogResult> {
  const [existing] = await db
    .select({ id: services.id, code: services.code })
    .from(services)
    .where(eq(services.id, serviceId))
    .limit(1);
  if (!existing) {
    return { ok: false, code: "notFound" };
  }

  try {
    await db
      .update(services)
      .set({
        code: input.code,
        nameAr: input.nameAr,
        nameEn: input.nameEn,
        categoryId: input.categoryId ?? null,
        defaultPrice: input.defaultPrice ?? null,
        currency: input.currency,
        commissionEligible: input.commissionEligible,
        defaultCommissionType: input.defaultCommissionType ?? null,
        defaultCommissionValue: input.defaultCommissionValue ?? null,
        updatedAt: new Date(),
      })
      .where(eq(services.id, serviceId));

    await recordAudit({
      userId: actor.id,
      action: AUDIT_ACTIONS.SERVICE_UPDATED,
      entityType: "service",
      entityId: serviceId,
      metadata: { code: input.code },
    });

    return { ok: true, id: serviceId };
  } catch {
    return { ok: false, code: "duplicate" };
  }
}

/**
 * Archive/restore a service. Archiving never touches history — existing
 * work items keep their service reference; new work items only offer
 * active services.
 */
export async function setServiceActive(
  actor: Actor,
  serviceId: string,
  active: boolean
): Promise<CatalogResult> {
  const [existing] = await db
    .select({ id: services.id })
    .from(services)
    .where(eq(services.id, serviceId))
    .limit(1);
  if (!existing) {
    return { ok: false, code: "notFound" };
  }

  await db
    .update(services)
    .set({ active, updatedAt: new Date() })
    .where(eq(services.id, serviceId));

  await recordAudit({
    userId: actor.id,
    action: active
      ? AUDIT_ACTIONS.SERVICE_REACTIVATED
      : AUDIT_ACTIONS.SERVICE_ARCHIVED,
    entityType: "service",
    entityId: serviceId,
  });

  return { ok: true, id: serviceId };
}
