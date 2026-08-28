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

import {
  commissionBasisEnum,
  commissionStatusEnum,
  commissionTypeEnum,
  currencyEnum,
} from "./enums";
import { services, visitWorkItems } from "./services";
import { users } from "./users";
import { vouchers } from "./finance";

const money = { precision: 12, scale: 2 } as const;

/**
 * Commission plans (خطط عمولات الأطباء).
 *
 * - One row per (doctor, service?) — service NULL = the doctor's default
 *   for every service without a specific plan.
 * - basis: WORK_VALUE (completed work value) or COLLECTED (money actually
 *   collected against the doctor's work).
 * - type: PERCENT of base or a FIXED amount per work item/collection.
 * - Plans are editable; existing commissions keep their snapshot.
 */
export const doctorCommissionPlans = pgTable(
  "doctor_commission_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    doctorId: uuid("doctor_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").references(() => services.id, {
      onDelete: "cascade",
    }),
    basis: commissionBasisEnum("basis").notNull().default("WORK_VALUE"),
    type: commissionTypeEnum("type").notNull(),
    /** Percent (e.g. 25.00) or fixed amount (e.g. 5000.00). */
    value: numeric("value", money).notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("doctor_commission_plans_doctor_idx").on(table.doctorId),
    index("doctor_commission_plans_service_idx").on(table.serviceId),
    // One plan per (doctor, service) — NULL service = the doctor default.
    uniqueIndex("doctor_commission_plans_doctor_service_unique").on(
      table.doctorId,
      table.serviceId
    ),
    check("doctor_commission_plans_value_positive", sql`${table.value} > 0`),
  ]
);

/**
 * Commissions (عمولات الأطباء) — one row per work item (WORK_VALUE) or per
 * (work item, receipt) pair (COLLECTED). Plan type/value are snapshotted;
 * later plan edits never mutate existing commissions.
 *
 * amount is NULL while PENDING without a configured plan — no entitlement
 * exists until ADMIN approves.
 */
export const commissions = pgTable(
  "commissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    doctorId: uuid("doctor_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Set for WORK_VALUE commissions (one per work item). */
    workItemId: uuid("work_item_id").references(() => visitWorkItems.id, {
      onDelete: "restrict",
    }),
    /** Receipt voucher that triggered a COLLECTED-basis commission. */
    sourceVoucherId: uuid("source_voucher_id").references(() => vouchers.id, {
      onDelete: "restrict",
    }),
    basis: commissionBasisEnum("basis").notNull(),
    /** Snapshot of the applied plan (nullable when no plan was configured). */
    planType: commissionTypeEnum("plan_type"),
    planValue: numeric("plan_value", money),
    baseAmount: numeric("base_amount", money).notNull(),
    currency: currencyEnum("currency").notNull(),
    /** Computed amount; NULL until a plan is applied / ADMIN sets it. */
    amount: numeric("amount", money),
    status: commissionStatusEnum("status").notNull().default("PENDING"),
    paidVoucherId: uuid("paid_voucher_id").references(() => vouchers.id, {
      onDelete: "restrict",
    }),
    approvedBy: uuid("approved_by").references(() => users.id, {
      onDelete: "restrict",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    reversalReason: text("reversal_reason"),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
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
    index("commissions_doctor_idx").on(table.doctorId),
    index("commissions_status_idx").on(table.status),
    index("commissions_work_item_idx").on(table.workItemId),
    index("commissions_source_voucher_idx").on(table.sourceVoucherId),
    // Exactly one WORK_VALUE commission per work item.
    uniqueIndex("commissions_work_item_unique")
      .on(table.workItemId)
      .where(sql`basis = 'WORK_VALUE' AND work_item_id IS NOT NULL`),
    // One COLLECTED commission per (work item, receipt voucher).
    uniqueIndex("commissions_collected_unique")
      .on(table.workItemId, table.sourceVoucherId)
      .where(
        sql`basis = 'COLLECTED' AND work_item_id IS NOT NULL AND source_voucher_id IS NOT NULL`
      ),
    check("commissions_base_positive", sql`${table.baseAmount} > 0`),
  ]
);

export const doctorCommissionPlansRelations = relations(
  doctorCommissionPlans,
  ({ one }) => ({
    doctor: one(users, {
      fields: [doctorCommissionPlans.doctorId],
      references: [users.id],
    }),
    service: one(services, {
      fields: [doctorCommissionPlans.serviceId],
      references: [services.id],
    }),
  })
);

export const commissionsRelations = relations(commissions, ({ one }) => ({
  doctor: one(users, {
    fields: [commissions.doctorId],
    references: [users.id],
  }),
  paidVoucher: one(vouchers, {
    fields: [commissions.paidVoucherId],
    references: [vouchers.id],
  }),
}));

export type DoctorCommissionPlan = typeof doctorCommissionPlans.$inferSelect;
export type NewDoctorCommissionPlan = typeof doctorCommissionPlans.$inferInsert;
export type Commission = typeof commissions.$inferSelect;
export type NewCommission = typeof commissions.$inferInsert;
