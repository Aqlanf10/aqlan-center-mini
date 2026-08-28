"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth/guards";
import {
  serviceCategoryFormSchema,
  serviceFormSchema,
  validateWith,
  workItemFormSchema,
} from "@/lib/validation";
import { failure, success, type ActionResult } from "@/server/types";
import type { Actor } from "@/server/finance/vouchers";
import {
  createService,
  createServiceCategory,
  setServiceActive,
  setServiceCategoryActive,
  updateService,
  updateServiceCategory,
} from "@/server/services/catalog";
import {
  addWorkItem,
  cancelWorkItem,
  updateWorkItem,
} from "@/server/services/work-items";

const ADMIN_ONLY = ["ADMIN"] as const;
/** Doctors and admins record clinical work items. */
const CLINICAL_ROLES = ["ADMIN", "DOCTOR"] as const;

function toActor(user: { id: string; role: string; name: string }): Actor {
  return { id: user.id, role: user.role as Actor["role"], name: user.name };
}

function revalidateCatalog() {
  revalidatePath("/settings/services");
}

/* ------------------------------------------------------------------ */
/* Service categories                                                  */
/* ------------------------------------------------------------------ */

export async function createServiceCategoryAction(
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/settings/services");
  const validation = validateWith(serviceCategoryFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const result = await createServiceCategory(toActor(user), {
    nameAr: validation.data.nameAr,
    nameEn: validation.data.nameEn,
    sortOrder: validation.data.sortOrder
      ? Number.parseInt(validation.data.sortOrder, 10)
      : undefined,
  });
  if (!result.ok) {
    return failure("services.errors.failed");
  }
  revalidateCatalog();
  return success("services.toasts.categoryCreated", result.id);
}

export async function updateServiceCategoryAction(
  categoryId: string,
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/settings/services");
  const validation = validateWith(serviceCategoryFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const result = await updateServiceCategory(toActor(user), categoryId, {
    nameAr: validation.data.nameAr,
    nameEn: validation.data.nameEn,
    sortOrder: validation.data.sortOrder
      ? Number.parseInt(validation.data.sortOrder, 10)
      : undefined,
  });
  if (!result.ok) {
    return failure("services.errors.notFound");
  }
  revalidateCatalog();
  return success("services.toasts.categoryUpdated", result.id);
}

export async function setServiceCategoryActiveAction(
  categoryId: string,
  active: boolean
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/settings/services");
  const result = await setServiceCategoryActive(toActor(user), categoryId, active);
  if (!result.ok) {
    return failure(
      result.code === "inUse" ? "services.errors.categoryInUse" : "services.errors.notFound"
    );
  }
  revalidateCatalog();
  return success(
    active ? "services.toasts.categoryReactivated" : "services.toasts.categoryArchived",
    result.id
  );
}

/* ------------------------------------------------------------------ */
/* Services                                                            */
/* ------------------------------------------------------------------ */

function parseServiceForm(input: Record<string, string>) {
  return {
    code: input.code?.trim() ?? "",
    nameAr: input.nameAr?.trim() ?? "",
    nameEn: input.nameEn?.trim() ?? "",
    categoryId: input.categoryId || null,
    defaultPrice: input.defaultPrice || null,
    currency: (input.currency || "YER") as "YER" | "SAR" | "USD",
    commissionEligible: input.commissionEligible === "yes",
    defaultCommissionType:
      (input.defaultCommissionType as "PERCENT" | "FIXED" | undefined) || null,
    defaultCommissionValue: input.defaultCommissionValue || null,
  };
}

export async function createServiceAction(
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/settings/services");
  const validation = validateWith(serviceFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const result = await createService(toActor(user), parseServiceForm(input));
  if (!result.ok) {
    return failure("services.errors.duplicateCode");
  }
  revalidateCatalog();
  return success("services.toasts.created", result.id);
}

export async function updateServiceAction(
  serviceId: string,
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/settings/services");
  const validation = validateWith(serviceFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const result = await updateService(toActor(user), serviceId, parseServiceForm(input));
  if (!result.ok) {
    return failure("services.errors.duplicateCode");
  }
  revalidateCatalog();
  return success("services.toasts.updated", result.id);
}

export async function setServiceActiveAction(
  serviceId: string,
  active: boolean
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/settings/services");
  const result = await setServiceActive(toActor(user), serviceId, active);
  if (!result.ok) {
    return failure("services.errors.notFound");
  }
  revalidateCatalog();
  return success(
    active ? "services.toasts.reactivated" : "services.toasts.archived",
    result.id
  );
}

/* ------------------------------------------------------------------ */
/* Work items                                                          */
/* ------------------------------------------------------------------ */

export async function addWorkItemAction(
  visitId: string,
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(CLINICAL_ROLES, "/today");
  const validation = validateWith(workItemFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  // Doctors may only record their own work items.
  if (user.role === "DOCTOR" && validation.data.doctorId !== user.id) {
    return failure("errors.forbidden");
  }

  const result = await addWorkItem(toActor(user), visitId, {
    serviceId: validation.data.serviceId,
    doctorId: validation.data.doctorId,
    quantity: validation.data.quantity,
    unitPrice: validation.data.unitPrice,
    discount: validation.data.discount ?? null,
    currency: validation.data.currency,
    notes: validation.data.notes ?? null,
  });

  if (!result.ok) {
    return failure(`workItems.errors.${result.code}`);
  }
  revalidatePath(`/visits/${visitId}`);
  revalidatePath("/today");
  return success("workItems.toasts.added", result.id);
}

export async function updateWorkItemAction(
  workItemId: string,
  visitId: string,
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(CLINICAL_ROLES, "/today");
  const validation = validateWith(workItemFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  if (user.role === "DOCTOR" && validation.data.doctorId !== user.id) {
    return failure("errors.forbidden");
  }

  const result = await updateWorkItem(toActor(user), workItemId, {
    serviceId: validation.data.serviceId,
    doctorId: validation.data.doctorId,
    quantity: validation.data.quantity,
    unitPrice: validation.data.unitPrice,
    discount: validation.data.discount ?? null,
    currency: validation.data.currency,
    notes: validation.data.notes ?? null,
  });

  if (!result.ok) {
    return failure(`workItems.errors.${result.code}`);
  }
  revalidatePath(`/visits/${visitId}`);
  revalidatePath("/today");
  return success("workItems.toasts.updated", result.id);
}

export async function cancelWorkItemAction(
  workItemId: string,
  visitId: string
): Promise<ActionResult> {
  const user = await requireRole(CLINICAL_ROLES, "/today");
  const result = await cancelWorkItem(toActor(user), workItemId);
  if (!result.ok) {
    return failure(`workItems.errors.${result.code}`);
  }
  revalidatePath(`/visits/${visitId}`);
  revalidatePath("/today");
  return success("workItems.toasts.cancelled", result.id);
}
