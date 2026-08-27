import { and, asc, desc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  materials,
  purchaseInvoiceItems,
  purchaseInvoices,
  suppliers,
  vouchers,
} from "@/db/schema";
import type { Currency } from "@/db/schema/enums";
import { getZonedParts } from "@/lib/datetime";
import { toMinorUnits, fromMinorUnits } from "@/lib/money";
import { AUDIT_ACTIONS, recordAudit } from "@/server/audit";
import type { Actor, TxClient } from "@/server/finance/vouchers";

export type SupplierResult =
  | { ok: true; id: string }
  | { ok: false; code: "notFound" | "duplicate" | "inUse" | "failed" | "hasPayments" };

/* ------------------------------------------------------------------ */
/* Suppliers                                                           */
/* ------------------------------------------------------------------ */

export function listSuppliers(includeArchived = false) {
  return db
    .select()
    .from(suppliers)
    .where(includeArchived ? undefined : eq(suppliers.active, true))
    .orderBy(asc(suppliers.name));
}

export async function createSupplier(
  actor: Actor,
  input: { name: string; phone?: string | null; address?: string | null; notes?: string | null }
): Promise<SupplierResult> {
  try {
    const id = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(suppliers)
        .values({ ...input, active: true })
        .returning({ id: suppliers.id });
      if (!created) return null;
      await recordAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.SUPPLIER_CREATED,
          entityType: "supplier",
          entityId: created.id,
        },
        tx
      );
      return created.id;
    });
    return id ? { ok: true, id } : { ok: false, code: "failed" };
  } catch {
    return { ok: false, code: "failed" };
  }
}

export async function updateSupplier(
  actor: Actor,
  supplierId: string,
  input: { name: string; phone?: string | null; address?: string | null; notes?: string | null }
): Promise<SupplierResult> {
  const [existing] = await db
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(eq(suppliers.id, supplierId))
    .limit(1);
  if (!existing) {
    return { ok: false, code: "notFound" };
  }

  await db
    .update(suppliers)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(suppliers.id, supplierId));
  await recordAudit({
    userId: actor.id,
    action: AUDIT_ACTIONS.SUPPLIER_UPDATED,
    entityType: "supplier",
    entityId: supplierId,
  });

  return { ok: true, id: supplierId };
}

export async function setSupplierActive(
  actor: Actor,
  supplierId: string,
  active: boolean
): Promise<SupplierResult> {
  const [existing] = await db
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(eq(suppliers.id, supplierId))
    .limit(1);
  if (!existing) {
    return { ok: false, code: "notFound" };
  }

  await db
    .update(suppliers)
    .set({ active, updatedAt: new Date() })
    .where(eq(suppliers.id, supplierId));
  await recordAudit({
    userId: actor.id,
    action: active
      ? AUDIT_ACTIONS.SUPPLIER_REACTIVATED
      : AUDIT_ACTIONS.SUPPLIER_ARCHIVED,
    entityType: "supplier",
    entityId: supplierId,
  });

  return { ok: true, id: supplierId };
}

/* ------------------------------------------------------------------ */
/* Materials                                                           */
/* ------------------------------------------------------------------ */

export function listMaterials(includeArchived = false) {
  return db
    .select({
      id: materials.id,
      code: materials.code,
      nameAr: materials.nameAr,
      nameEn: materials.nameEn,
      unit: materials.unit,
      defaultSupplierId: materials.defaultSupplierId,
      defaultSupplierName: suppliers.name,
      active: materials.active,
    })
    .from(materials)
    .leftJoin(suppliers, eq(materials.defaultSupplierId, suppliers.id))
    .where(includeArchived ? undefined : eq(materials.active, true))
    .orderBy(asc(materials.code));
}

export async function createMaterial(
  actor: Actor,
  input: {
    code: string;
    nameAr: string;
    nameEn: string;
    unit?: string | null;
    defaultSupplierId?: string | null;
  }
): Promise<SupplierResult> {
  try {
    const id = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(materials)
        .values({
          code: input.code,
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          unit: input.unit ?? null,
          defaultSupplierId: input.defaultSupplierId ?? null,
          active: true,
        })
        .returning({ id: materials.id });
      if (!created) return null;
      await recordAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.MATERIAL_CREATED,
          entityType: "material",
          entityId: created.id,
          metadata: { code: input.code },
        },
        tx
      );
      return created.id;
    });
    return id ? { ok: true, id } : { ok: false, code: "duplicate" };
  } catch (error) {
    if (error instanceof Error && /materials_code_unique/i.test(error.message)) {
      return { ok: false, code: "duplicate" };
    }
    return { ok: false, code: "failed" };
  }
}

export async function updateMaterial(
  actor: Actor,
  materialId: string,
  input: {
    code: string;
    nameAr: string;
    nameEn: string;
    unit?: string | null;
    defaultSupplierId?: string | null;
  }
): Promise<SupplierResult> {
  const [existing] = await db
    .select({ id: materials.id })
    .from(materials)
    .where(eq(materials.id, materialId))
    .limit(1);
  if (!existing) {
    return { ok: false, code: "notFound" };
  }

  try {
    await db
      .update(materials)
      .set({
        code: input.code,
        nameAr: input.nameAr,
        nameEn: input.nameEn,
        unit: input.unit ?? null,
        defaultSupplierId: input.defaultSupplierId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(materials.id, materialId));
    await recordAudit({
      userId: actor.id,
      action: AUDIT_ACTIONS.MATERIAL_UPDATED,
      entityType: "material",
      entityId: materialId,
      metadata: { code: input.code },
    });
    return { ok: true, id: materialId };
  } catch (error) {
    if (error instanceof Error && /materials_code_unique/i.test(error.message)) {
      return { ok: false, code: "duplicate" };
    }
    return { ok: false, code: "failed" };
  }
}

export async function setMaterialActive(
  actor: Actor,
  materialId: string,
  active: boolean
): Promise<SupplierResult> {
  const [existing] = await db
    .select({ id: materials.id })
    .from(materials)
    .where(eq(materials.id, materialId))
    .limit(1);
  if (!existing) {
    return { ok: false, code: "notFound" };
  }

  await db
    .update(materials)
    .set({ active, updatedAt: new Date() })
    .where(eq(materials.id, materialId));
  await recordAudit({
    userId: actor.id,
    action: active
      ? AUDIT_ACTIONS.MATERIAL_REACTIVATED
      : AUDIT_ACTIONS.MATERIAL_ARCHIVED,
    entityType: "material",
    entityId: materialId,
  });

  return { ok: true, id: materialId };
}

/* ------------------------------------------------------------------ */
/* Purchase invoices                                                   */
/* ------------------------------------------------------------------ */

/** Draw the next purchase invoice number PINV-YYYY-NNNNNN (atomic sequence). */
async function nextInvoiceNumber(tx: TxClient, when: Date): Promise<string> {
  const year = getZonedParts(when).year;
  const result = await tx.execute<{ value: string | number }>(
    sql`SELECT nextval('purchase_invoice_number_seq') AS value`
  );
  const rows = Array.isArray(result)
    ? result
    : (result as unknown as { rows: { value: string | number }[] }).rows;
  const value = Number(rows?.[0]?.value ?? 0);
  return `PINV-${year}-${String(value).padStart(6, "0")}`;
}

export type PurchaseInvoiceItemInput = {
  materialId: string;
  quantity: string;
  unitPrice: string;
  discount?: string | null;
};

export type PurchaseInvoiceInput = {
  supplierId: string;
  supplierRef?: string | null;
  currency: Currency;
  invoiceDate?: Date | null;
  items: PurchaseInvoiceItemInput[];
};

function computeLineTotal(item: PurchaseInvoiceItemInput): string {
  const qty = Math.round(parseFloat(item.quantity) * 100);
  const price = toMinorUnits(item.unitPrice);
  const discount = item.discount ? toMinorUnits(item.discount) : 0;
  return fromMinorUnits(Math.max(Math.round((qty * price) / 100) - discount, 0));
}

/**
 * Create a multi-line purchase invoice: invoice + items + audit in ONE
 * transaction, with the total computed server-side from the lines.
 */
export async function createPurchaseInvoice(
  actor: Actor,
  input: PurchaseInvoiceInput
): Promise<SupplierResult> {
  if (input.items.length === 0) {
    return { ok: false, code: "failed" };
  }

  try {
    const id = await db.transaction(async (tx) => {
      const when = input.invoiceDate ?? new Date();
      const invoiceNumber = await nextInvoiceNumber(tx, when);

      const lineTotals = input.items.map((item) => ({
        item,
        total: computeLineTotal(item),
      }));
      const grandTotal = fromMinorUnits(
        lineTotals.reduce((sum, line) => sum + toMinorUnits(line.total), 0)
      );

      const [invoice] = await tx
        .insert(purchaseInvoices)
        .values({
          invoiceNumber,
          supplierId: input.supplierId,
          supplierRef: input.supplierRef ?? null,
          invoiceDate: when,
          currency: input.currency,
          totalAmount: grandTotal,
          status: "ACTIVE",
          createdBy: actor.id,
        })
        .returning({ id: purchaseInvoices.id });
      if (!invoice) return null;

      await tx.insert(purchaseInvoiceItems).values(
        lineTotals.map((line) => ({
          invoiceId: invoice.id,
          materialId: line.item.materialId,
          quantity: line.item.quantity,
          unitPrice: line.item.unitPrice,
          discount: line.item.discount ?? "0",
          total: line.total,
        }))
      );

      await recordAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.PURCHASE_INVOICE_CREATED,
          entityType: "purchase_invoice",
          entityId: invoice.id,
          metadata: {
            invoiceNumber,
            currency: input.currency,
            total: grandTotal,
            lines: lineTotals.length,
          },
        },
        tx
      );
      return invoice.id;
    });
    return id ? { ok: true, id } : { ok: false, code: "failed" };
  } catch {
    return { ok: false, code: "failed" };
  }
}

/** Cancel a purchase invoice (never delete) — refused once payments exist. */
export async function cancelPurchaseInvoice(
  actor: Actor,
  invoiceId: string,
  reason: string
): Promise<SupplierResult> {
  const [existing] = await db
    .select({ id: purchaseInvoices.id, status: purchaseInvoices.status })
    .from(purchaseInvoices)
    .where(eq(purchaseInvoices.id, invoiceId))
    .limit(1);
  if (!existing) {
    return { ok: false, code: "notFound" };
  }
  if (existing.status !== "ACTIVE") {
    return { ok: false, code: "duplicate" };
  }

  // Net payments still standing against this invoice (reversals excluded).
  const netRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(vouchers)
    .where(
      and(
        eq(vouchers.purchaseInvoiceId, invoiceId),
        eq(vouchers.type, "PAYMENT"),
        sql`${vouchers.status} = 'ACTIVE'`,
        sql`${vouchers.reversalOfVoucherId} IS NULL`
      )
    );
  if ((netRows[0]?.n ?? 0) > 0) {
    return { ok: false, code: "hasPayments" };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(purchaseInvoices)
      .set({ status: "CANCELLED", cancelReason: reason, updatedAt: new Date() })
      .where(eq(purchaseInvoices.id, invoiceId));
    await recordAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.PURCHASE_INVOICE_CANCELLED,
        entityType: "purchase_invoice",
        entityId: invoiceId,
        metadata: { reason },
      },
      tx
    );
  });

  return { ok: true, id: invoiceId };
}

/* ------------------------------------------------------------------ */
/* Queries & balances                                                  */
/* ------------------------------------------------------------------ */

export async function listPurchaseInvoices(filter?: {
  supplierId?: string;
  limit?: number;
}) {
  const conditions = [];
  if (filter?.supplierId) {
    conditions.push(eq(purchaseInvoices.supplierId, filter.supplierId));
  }

  return db
    .select({
      id: purchaseInvoices.id,
      invoiceNumber: purchaseInvoices.invoiceNumber,
      supplierId: purchaseInvoices.supplierId,
      supplierName: suppliers.name,
      supplierRef: purchaseInvoices.supplierRef,
      invoiceDate: purchaseInvoices.invoiceDate,
      currency: purchaseInvoices.currency,
      totalAmount: purchaseInvoices.totalAmount,
      status: purchaseInvoices.status,
      cancelReason: purchaseInvoices.cancelReason,
      createdAt: purchaseInvoices.createdAt,
      paidMinor: sql<string | null>`(
        SELECT sum(CASE WHEN v.reversal_of_voucher_id IS NULL THEN v.amount ELSE -v.amount END)
        FROM vouchers v
        WHERE v.purchase_invoice_id = ${purchaseInvoices.id}
          AND v.type = 'PAYMENT'
      )`,
    })
    .from(purchaseInvoices)
    .innerJoin(suppliers, eq(purchaseInvoices.supplierId, suppliers.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(purchaseInvoices.invoiceDate))
    .limit(filter?.limit ?? 200);
}

export async function getPurchaseInvoiceItems(invoiceId: string) {
  return db
    .select({
      id: purchaseInvoiceItems.id,
      materialId: purchaseInvoiceItems.materialId,
      materialCode: materials.code,
      materialNameAr: materials.nameAr,
      materialNameEn: materials.nameEn,
      quantity: purchaseInvoiceItems.quantity,
      unitPrice: purchaseInvoiceItems.unitPrice,
      discount: purchaseInvoiceItems.discount,
      total: purchaseInvoiceItems.total,
    })
    .from(purchaseInvoiceItems)
    .innerJoin(materials, eq(purchaseInvoiceItems.materialId, materials.id))
    .where(eq(purchaseInvoiceItems.invoiceId, invoiceId));
}

export type SupplierBalanceRow = {
  supplierId: string;
  supplierName: string;
  currency: Currency;
  invoicedMinor: number;
  paidMinor: number;
  balanceMinor: number;
};

/** Supplier balances derived from real movements (invoices − payment vouchers). */
export async function getSupplierBalances(): Promise<SupplierBalanceRow[]> {
  const invoiced = await db
    .select({
      supplierId: purchaseInvoices.supplierId,
      supplierName: suppliers.name,
      currency: purchaseInvoices.currency,
      total: sql<string>`sum(${purchaseInvoices.totalAmount})`,
    })
    .from(purchaseInvoices)
    .innerJoin(suppliers, eq(purchaseInvoices.supplierId, suppliers.id))
    .where(eq(purchaseInvoices.status, "ACTIVE"))
    .groupBy(purchaseInvoices.supplierId, suppliers.name, purchaseInvoices.currency);

  const paid = await db
    .select({
      supplierId: vouchers.supplierId,
      currency: vouchers.currency,
      paid: sql<string>`sum(CASE WHEN ${vouchers.reversalOfVoucherId} IS NULL THEN ${vouchers.amount} ELSE -${vouchers.amount} END)`,
    })
    .from(vouchers)
    .where(
      and(
        eq(vouchers.partyType, "SUPPLIER"),
        eq(vouchers.type, "PAYMENT")
      )
    )
    .groupBy(vouchers.supplierId, vouchers.currency);

  const paidMap = new Map<string, number>();
  for (const row of paid) {
    if (!row.supplierId) continue;
    paidMap.set(
      `${row.supplierId}:${row.currency}`,
      Math.round(parseFloat(row.paid ?? "0") * 100)
    );
  }

  return invoiced.map((row) => {
    const invoicedMinor = Math.round(parseFloat(row.total ?? "0") * 100);
    const paidMinor = paidMap.get(`${row.supplierId}:${row.currency}`) ?? 0;
    return {
      supplierId: row.supplierId,
      supplierName: row.supplierName,
      currency: row.currency,
      invoicedMinor,
      paidMinor,
      balanceMinor: invoicedMinor - paidMinor,
    };
  });
}

/** Payments made to a supplier (statement lines). */
export async function getSupplierPayments(supplierId: string, currency?: Currency) {
  const conditions = [
    eq(vouchers.partyType, "SUPPLIER"),
    eq(vouchers.type, "PAYMENT"),
    eq(vouchers.supplierId, supplierId),
  ];
  if (currency) conditions.push(eq(vouchers.currency, currency));

  return db
    .select({
      id: vouchers.id,
      voucherNumber: vouchers.voucherNumber,
      amount: vouchers.amount,
      currency: vouchers.currency,
      voucherDate: vouchers.voucherDate,
      status: vouchers.status,
      reversalOfVoucherId: vouchers.reversalOfVoucherId,
      purchaseInvoiceId: vouchers.purchaseInvoiceId,
      description: vouchers.description,
    })
    .from(vouchers)
    .where(and(...conditions))
    .orderBy(desc(vouchers.voucherDate));
}
