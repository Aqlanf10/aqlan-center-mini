import { relations } from "drizzle-orm";
import {
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { currencyEnum } from "./enums";
import { patients } from "./patients";
import { users } from "./users";
import { vouchers } from "./finance";

const money = {
  precision: 12,
  scale: 2,
} as const;

export const charges = pgTable(
  "charges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    amount: numeric("amount", money).notNull(),
    currency: currencyEnum("currency").notNull().default("YER"),
    description: text("description").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("charges_patient_id_idx").on(table.patientId),
    index("charges_created_at_idx").on(table.createdAt),
  ]
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    amount: numeric("amount", money).notNull(),
    currency: currencyEnum("currency").notNull().default("YER"),
    description: text("description"),
    /** Set when the payment was created through a receipt voucher (1:1). */
    voucherId: uuid("voucher_id").references(() => vouchers.id, {
      onDelete: "restrict",
    }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("payments_patient_id_idx").on(table.patientId),
    index("payments_created_at_idx").on(table.createdAt),
  ]
);

export const chargesRelations = relations(charges, ({ one }) => ({
  patient: one(patients, {
    fields: [charges.patientId],
    references: [patients.id],
  }),
  createdByUser: one(users, {
    fields: [charges.createdBy],
    references: [users.id],
  }),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  patient: one(patients, {
    fields: [payments.patientId],
    references: [patients.id],
  }),
  voucher: one(vouchers, {
    fields: [payments.voucherId],
    references: [vouchers.id],
  }),
  createdByUser: one(users, {
    fields: [payments.createdBy],
    references: [users.id],
  }),
}));

export type Charge = typeof charges.$inferSelect;
export type NewCharge = typeof charges.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
