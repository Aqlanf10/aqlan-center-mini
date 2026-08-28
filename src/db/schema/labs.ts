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

import { currencyEnum, labCaseStatusEnum } from "./enums";
import { patients } from "./patients";
import { users } from "./users";
import { services } from "./services";
import { visits } from "./visits";

const money = { precision: 12, scale: 2 } as const;

/**
 * Dental labs directory (دليل المعامل).
 */
export const labs = pgTable(
  "labs",
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
  (table) => [index("labs_active_idx").on(table.active)]
);

/**
 * Lab cases (حالات المعمل) — work sent to an external lab.
 * Linked to patient/visit/doctor/service; the case cost becomes payable
 * once the lab invoice is recorded (invoiced = true).
 */
export const labCases = pgTable(
  "lab_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Human-readable unique number, e.g. LC-2026-000001. */
    caseNumber: text("case_number").notNull(),
    labId: uuid("lab_id")
      .notNull()
      .references(() => labs.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    visitId: uuid("visit_id").references(() => visits.id, {
      onDelete: "set null",
    }),
    doctorId: uuid("doctor_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id").references(() => services.id, {
      onDelete: "set null",
    }),
    /** Free description of the lab work (e.g. crown PFM, acrylic denture). */
    workType: text("work_type").notNull(),
    cost: numeric("cost", money).notNull(),
    currency: currencyEnum("currency").notNull().default("YER"),
    status: labCaseStatusEnum("status").notNull().default("ORDERED"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    expectedDeliveryAt: timestamp("expected_delivery_at", {
      withTimezone: true,
    }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /** Lab invoice recorded → cost becomes part of the lab balance. */
    invoiced: boolean("invoiced").notNull().default(false),
    invoiceNumber: text("invoice_number"),
    invoiceAmount: numeric("invoice_amount", money),
    invoicedAt: timestamp("invoiced_at", { withTimezone: true }),
    notes: text("notes"),
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
    uniqueIndex("lab_cases_number_unique").on(table.caseNumber),
    index("lab_cases_lab_id_idx").on(table.labId),
    index("lab_cases_patient_id_idx").on(table.patientId),
    index("lab_cases_doctor_id_idx").on(table.doctorId),
    index("lab_cases_status_idx").on(table.status),
    check("lab_cases_cost_positive", sql`${table.cost} > 0`),
  ]
);

export const labsRelations = relations(labs, ({ many }) => ({
  cases: many(labCases),
}));

export const labCasesRelations = relations(labCases, ({ one }) => ({
  lab: one(labs, { fields: [labCases.labId], references: [labs.id] }),
  patient: one(patients, {
    fields: [labCases.patientId],
    references: [patients.id],
  }),
  visit: one(visits, { fields: [labCases.visitId], references: [visits.id] }),
  doctor: one(users, { fields: [labCases.doctorId], references: [users.id] }),
  service: one(services, {
    fields: [labCases.serviceId],
    references: [services.id],
  }),
}));

export type Lab = typeof labs.$inferSelect;
export type NewLab = typeof labs.$inferInsert;
export type LabCase = typeof labCases.$inferSelect;
export type NewLabCase = typeof labCases.$inferInsert;
