"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth/guards";
import { parseDateTimeLocal } from "@/lib/datetime";
import {
  materialFormSchema,
  purchaseInvoiceCancelFormSchema,
  purchaseInvoiceFormSchema,
  supplierFormSchema,
  validateWith,
} from "@/lib/validation";
import { failure, success, type ActionResult } from "@/server/types";
import type { Actor } from "@/server/finance/vouchers";
import {
  cancelPurchaseInvoice,
  createMaterial,
  createPurchaseInvoice,
  createSupplier,
  setMaterialActive,
  setSupplierActive,
  updateMaterial,
  updateSupplier,
} from "@/server/suppliers/suppliers";

const ADMIN_ONLY = ["ADMIN"] as const;

function toActor(user: { id: string; role: string; name: string }): Actor {
  return { id: user.id, role: user.role as Actor["role"], name: user.name };
}

export async function createSupplierAction(
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/suppliers");
  const validation = validateWith(supplierFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const result = await createSupplier(toActor(user), validation.data);
  if (!result.ok) {
    return failure("suppliers.errors.failed");
  }
  revalidatePath("/suppliers");
  return success("suppliers.toasts.created", result.id);
}

export async function updateSupplierAction(
  supplierId: string,
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/suppliers");
  const validation = validateWith(supplierFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const result = await updateSupplier(toActor(user), supplierId, validation.data);
  if (!result.ok) {
    return failure("suppliers.errors.notFound");
  }
  revalidatePath("/suppliers");
  return success("suppliers.toasts.updated", result.id);
}

export async function setSupplierActiveAction(
  supplierId: string,
  active: boolean
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/suppliers");
  const result = await setSupplierActive(toActor(user), supplierId, active);
  if (!result.ok) {
    return failure("suppliers.errors.notFound");
  }
  revalidatePath("/suppliers");
  return success(
    active ? "suppliers.toasts.reactivated" : "suppliers.toasts.archived",
    result.id
  );
}

export async function createMaterialAction(
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/suppliers");
  const validation = validateWith(materialFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const result = await createMaterial(toActor(user), validation.data);
  if (!result.ok) {
    return failure(
      result.code === "duplicate" ? "suppliers.errors.duplicateCode" : "suppliers.errors.failed"
    );
  }
  revalidatePath("/suppliers");
  return success("suppliers.toasts.materialCreated", result.id);
}

export async function updateMaterialAction(
  materialId: string,
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/suppliers");
  const validation = validateWith(materialFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const result = await updateMaterial(toActor(user), materialId, validation.data);
  if (!result.ok) {
    return failure(
      result.code === "duplicate" ? "suppliers.errors.duplicateCode" : "suppliers.errors.notFound"
    );
  }
  revalidatePath("/suppliers");
  return success("suppliers.toasts.materialUpdated", result.id);
}

export async function setMaterialActiveAction(
  materialId: string,
  active: boolean
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/suppliers");
  const result = await setMaterialActive(toActor(user), materialId, active);
  if (!result.ok) {
    return failure("suppliers.errors.notFound");
  }
  revalidatePath("/suppliers");
  return success(
    active ? "suppliers.toasts.materialReactivated" : "suppliers.toasts.materialArchived",
    result.id
  );
}

export async function createPurchaseInvoiceAction(
  input: Record<string, string> & {
    items?: { materialId: string; quantity: string; unitPrice: string; discount?: string }[];
  }
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/suppliers");
  const items = Array.isArray(input.items) ? input.items : [];

  const validation = validateWith(purchaseInvoiceFormSchema, {
    supplierId: input.supplierId,
    supplierRef: input.supplierRef ?? "",
    currency: input.currency,
    invoiceDate: input.invoiceDate ?? "",
    items,
  });
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const result = await createPurchaseInvoice(toActor(user), {
    supplierId: validation.data.supplierId,
    supplierRef: validation.data.supplierRef ?? null,
    currency: validation.data.currency,
    invoiceDate: validation.data.invoiceDate
      ? parseDateTimeLocal(`${validation.data.invoiceDate}T00:00`)
      : null,
    items: validation.data.items.map((item) => ({
      materialId: item.materialId,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discount: item.discount ?? null,
    })),
  });

  if (!result.ok) {
    return failure("suppliers.errors.invoiceFailed");
  }
  revalidatePath("/suppliers");
  return success("suppliers.toasts.invoiceCreated", result.id);
}

export async function cancelPurchaseInvoiceAction(
  invoiceId: string,
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/suppliers");
  const validation = validateWith(purchaseInvoiceCancelFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const result = await cancelPurchaseInvoice(
    toActor(user),
    invoiceId,
    validation.data.reason
  );
  if (!result.ok) {
    return failure(
      result.code === "hasPayments"
        ? "suppliers.errors.hasPayments"
        : "suppliers.errors.notFound"
    );
  }
  revalidatePath("/suppliers");
  return success("suppliers.toasts.invoiceCancelled", result.id);
}
