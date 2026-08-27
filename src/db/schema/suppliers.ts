import { relations } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { currencyEnum, purchaseInvoiceStatusEnum } from "./enums";
import { users } from "./users";

const money = { precision: 12, scale: 2 } as const;

/**
 * Suppliers directory (دليل الموردين).
 */
export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    phone: text("phone"),
    address: text("address"),
    notes: text("notes"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("suppliers_active_idx").on(table.active)]
);

/**
 * Materials directory (دليل المواد). No stock levels at this stage — the
 * table is shaped so a future inventory module can add movements without
 * breaking this schema (active/archived, default supplier, unit).
 */
export const materials = pgTable(
  "materials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    nameAr: text("name_ar").notNull(),
    nameEn: text("name_en").notNull(),
    unit: text("unit"),
    defaultSupplierId: uuid("default_supplier_id").references(
      () => suppliers.id,
      { onDelete: "set null" }
    ),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("materials_code_unique").on(table.code),
    index("materials_active_idx").on(table.active),
    index("materials_supplier_idx").on(table.defaultSupplierId),
  ]
);

/**
 * Purchase invoices (فواتير المشتريات) — multi-line material purchases.
 * Append-only: a wrong invoice is CANCELLED with a mandatory reason, never
 * deleted. Payments to the supplier happen through payment vouchers linked
 * via vouchers.purchaseInvoiceId / vouchers.supplierId.
 */
export const purchaseInvoices = pgTable(
  "purchase_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Human-readable unique number, e.g. PINV-2026-000001. */
    invoiceNumber: text("invoice_number").notNull(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    /** The supplier's own invoice/document reference. */
    supplierRef: text("supplier_ref"),
    invoiceDate: timestamp("invoice_date", { withTimezone: true })
      .notNull()
      .defaultNow(),
    currency: currencyEnum("currency").notNull(),
    /** Server-computed sum of the invoice line totals. */
    totalAmount: numeric("total_amount", money).notNull().default("0"),
    status: purchaseInvoiceStatusEnum("status").notNull().default("ACTIVE"),
    cancelReason: text("cancel_reason"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("purchase_invoices_number_unique").on(table.invoiceNumber),
    index("purchase_invoices_supplier_idx").on(table.supplierId),
    index("purchase_invoices_status_idx").on(table.status),
    check("purchase_invoices_total_positive", sql`${table.totalAmount} > 0`),
  ]
);

/** Purchase invoice lines: material, quantity, unit price, discount, total. */
export const purchaseInvoiceItems = pgTable(
  "purchase_invoice_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => purchaseInvoices.id, { onDelete: "cascade" }),
    materialId: uuid("material_id")
      .notNull()
      .references(() => materials.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 10, scale: 2 }).notNull(),
    unitPrice: numeric("unit_price", money).notNull(),
    discount: numeric("discount", money).notNull().default("0"),
    /** Server-computed: quantity * unitPrice - discount. */
    total: numeric("total", money).notNull(),
  },
  (table) => [index("purchase_invoice_items_invoice_idx").on(table.invoiceId)]
);

export const suppliersRelations = relations(suppliers, ({ many }) => ({
  invoices: many(purchaseInvoices),
  materials: many(materials),
}));

export const materialsRelations = relations(materials, ({ one }) => ({
  defaultSupplier: one(suppliers, {
    fields: [materials.defaultSupplierId],
    references: [suppliers.id],
  }),
}));

export const purchaseInvoicesRelations = relations(
  purchaseInvoices,
  ({ one, many }) => ({
    supplier: one(suppliers, {
      fields: [purchaseInvoices.supplierId],
      references: [suppliers.id],
    }),
    items: many(purchaseInvoiceItems),
  })
);

export const purchaseInvoiceItemsRelations = relations(
  purchaseInvoiceItems,
  ({ one }) => ({
    invoice: one(purchaseInvoices, {
      fields: [purchaseInvoiceItems.invoiceId],
      references: [purchaseInvoices.id],
    }),
    material: one(materials, {
      fields: [purchaseInvoiceItems.materialId],
      references: [materials.id],
    }),
  })
);

export type Supplier = typeof suppliers.$inferSelect;
export type NewSupplier = typeof suppliers.$inferInsert;
export type Material = typeof materials.$inferSelect;
export type NewMaterial = typeof materials.$inferInsert;
export type PurchaseInvoice = typeof purchaseInvoices.$inferSelect;
export type NewPurchaseInvoice = typeof purchaseInvoices.$inferInsert;
export type PurchaseInvoiceItem = typeof purchaseInvoiceItems.$inferSelect;
export type NewPurchaseInvoiceItem = typeof purchaseInvoiceItems.$inferInsert;
