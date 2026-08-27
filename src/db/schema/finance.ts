import { relations } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import {
  cashAccountTypeEnum,
  currencyEnum,
  paymentMethodEnum,
  partyTypeEnum,
  voucherStatusEnum,
  voucherTypeEnum,
} from "./enums";
import { patients } from "./patients";
import { users } from "./users";
import { labs } from "./labs";
import { suppliers } from "./suppliers";
import { labCases } from "./labs";
import { purchaseInvoices } from "./suppliers";

const money = { precision: 12, scale: 2 } as const;

/* ------------------------------------------------------------------ */
/* Cash / bank accounts (الخزينة)                                      */
/* ------------------------------------------------------------------ */

/**
 * Treasury accounts. One currency per account — money is never converted
 * or mixed; reports group by account and currency.
 */
export const cashAccounts = pgTable(
  "cash_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    currency: currencyEnum("currency").notNull(),
    type: cashAccountTypeEnum("type").notNull().default("CASH"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("cash_accounts_active_idx").on(table.active),
    index("cash_accounts_currency_idx").on(table.currency),
  ]
);

/* ------------------------------------------------------------------ */
/* Expense categories (فئات المصروفات)                                 */
/* ------------------------------------------------------------------ */

export const expenseCategories = pgTable(
  "expense_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nameAr: text("name_ar").notNull(),
    nameEn: text("name_en").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("expense_categories_active_idx").on(table.active)]
);

/* ------------------------------------------------------------------ */
/* Voucher numbering (RCPT-2026-000001 / PV-2026-000001)               */
/* ------------------------------------------------------------------ */

/**
 * Per (kind, year) counters for human-readable voucher numbers.
 * Rows are updated with row-level locking inside the voucher transaction,
 * so concurrent submissions can never draw the same number.
 */
export const voucherCounters = pgTable(
  "voucher_counters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: voucherTypeEnum("kind").notNull(),
    year: integer("year").notNull(),
    lastNumber: integer("last_number").notNull().default(0),
  },
  (table) => [uniqueIndex("voucher_counters_kind_year_unique").on(table.kind, table.year)]
);

/* ------------------------------------------------------------------ */
/* Vouchers (سندات القبض والصرف)                                       */
/* ------------------------------------------------------------------ */

/**
 * Financial vouchers — append-only ledger entries.
 *
 * - RECEIPT: money in (patient payment or other party).
 * - PAYMENT: money out (doctor commission, lab, supplier, general expense).
 * - Corrections NEVER edit or delete rows: a reversal creates a counterpart
 *   voucher (linked via reversalOfVoucherId, mandatory reason) and marks the
 *   original REVERSED.
 * - Currency must match the cash account currency (server-validated + tested).
 */
export const vouchers = pgTable(
  "vouchers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: voucherTypeEnum("type").notNull(),
    /** Human-readable unique number, e.g. RCPT-2026-000001 / PV-2026-000001. */
    voucherNumber: text("voucher_number").notNull(),
    partyType: partyTypeEnum("party_type").notNull(),

    // Counterparty references (exactly one is set according to partyType).
    patientId: uuid("patient_id").references(() => patients.id, {
      onDelete: "restrict",
    }),
    doctorId: uuid("doctor_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    labId: uuid("lab_id").references(() => labs.id, { onDelete: "restrict" }),
    supplierId: uuid("supplier_id").references(() => suppliers.id, {
      onDelete: "restrict",
    }),
    /** Free-text party for non-catalog beneficiaries (general expense / other income). */
    otherPartyName: text("other_party_name"),

    // Optional treasury links to specific documents.
    labCaseId: uuid("lab_case_id").references(() => labCases.id, {
      onDelete: "restrict",
    }),
    purchaseInvoiceId: uuid("purchase_invoice_id").references(
      () => purchaseInvoices.id,
      { onDelete: "restrict" }
    ),
    /** Commission payment link (FK defined on commissions.paidVoucherId). */
    commissionId: uuid("commission_id"),

    expenseCategoryId: uuid("expense_category_id").references(
      () => expenseCategories.id,
      { onDelete: "restrict" }
    ),

    amount: numeric("amount", money).notNull(),
    currency: currencyEnum("currency").notNull(),
    cashAccountId: uuid("cash_account_id")
      .notNull()
      .references(() => cashAccounts.id, { onDelete: "restrict" }),
    paymentMethod: paymentMethodEnum("payment_method").notNull().default("CASH"),
    voucherDate: timestamp("voucher_date", { withTimezone: true })
      .notNull()
      .defaultNow(),

    description: text("description"),
    reference: text("reference"),

    status: voucherStatusEnum("status").notNull().default("ACTIVE"),
    /** Set on the reversal entry: points to the voucher being reversed. */
    reversalOfVoucherId: uuid("reversal_of_voucher_id").references(
      (): AnyPgColumn => vouchers.id,
      { onDelete: "restrict" }
    ),
    reversalReason: text("reversal_reason"),

    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    approvedBy: uuid("approved_by").references(() => users.id, {
      onDelete: "restrict",
    }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("vouchers_number_unique").on(table.voucherNumber),
    index("vouchers_type_date_idx").on(table.type, table.voucherDate),
    index("vouchers_party_idx").on(table.partyType, table.patientId, table.doctorId),
    index("vouchers_cash_account_idx").on(table.cashAccountId),
    index("vouchers_status_idx").on(table.status),
    index("vouchers_lab_case_idx").on(table.labCaseId),
    index("vouchers_purchase_invoice_idx").on(table.purchaseInvoiceId),
    index("vouchers_commission_idx").on(table.commissionId),
    // Positive amounts only — enforced by the database, not just the app.
    check("vouchers_amount_positive", sql`${table.amount} > 0`),
    // A receipt is for a patient OR another named party.
    check(
      "vouchers_receipt_party",
      sql`${table.type} = 'PAYMENT' OR (${table.patientId} IS NOT NULL OR ${table.otherPartyName} IS NOT NULL)`
    ),
    // A payment names a doctor, lab, supplier or another beneficiary.
    check(
      "vouchers_payment_party",
      sql`${table.type} = 'RECEIPT' OR (${table.doctorId} IS NOT NULL OR ${table.labId} IS NOT NULL OR ${table.supplierId} IS NOT NULL OR ${table.otherPartyName} IS NOT NULL)`
    ),
    // General expense (OTHER) always carries an expense category.
    check(
      "vouchers_other_party_category",
      sql`${table.partyType} <> 'OTHER' OR ${table.expenseCategoryId} IS NOT NULL`
    ),
  ]
);

export const cashAccountsRelations = relations(cashAccounts, ({ many }) => ({
  vouchers: many(vouchers),
}));

export const expenseCategoriesRelations = relations(
  expenseCategories,
  ({ many }) => ({
    vouchers: many(vouchers),
  })
);

export const vouchersRelations = relations(vouchers, ({ one }) => ({
  patient: one(patients, {
    fields: [vouchers.patientId],
    references: [patients.id],
  }),
  doctor: one(users, {
    fields: [vouchers.doctorId],
    references: [users.id],
  }),
  lab: one(labs, {
    fields: [vouchers.labId],
    references: [labs.id],
  }),
  supplier: one(suppliers, {
    fields: [vouchers.supplierId],
    references: [suppliers.id],
  }),
  cashAccount: one(cashAccounts, {
    fields: [vouchers.cashAccountId],
    references: [cashAccounts.id],
  }),
  expenseCategory: one(expenseCategories, {
    fields: [vouchers.expenseCategoryId],
    references: [expenseCategories.id],
  }),
  createdByUser: one(users, {
    fields: [vouchers.createdBy],
    references: [users.id],
  }),
}));

export type CashAccount = typeof cashAccounts.$inferSelect;
export type NewCashAccount = typeof cashAccounts.$inferInsert;
export type ExpenseCategory = typeof expenseCategories.$inferSelect;
export type NewExpenseCategory = typeof expenseCategories.$inferInsert;
export type Voucher = typeof vouchers.$inferSelect;
export type NewVoucher = typeof vouchers.$inferInsert;
