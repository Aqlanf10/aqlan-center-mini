import { relations } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { genderEnum, treatmentStatusEnum } from "./enums";
import { users } from "./users";

export const patients = pgTable(
  "patients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Unique clinic file number (human-readable). */
    fileNumber: text("file_number").notNull(),
    fullName: text("full_name").notNull(),
    gender: genderEnum("gender").notNull(),
    dateOfBirth: date("date_of_birth"),
    mobile: text("mobile").notNull(),
    alternateMobile: text("alternate_mobile"),
    address: text("address"),
    treatingDoctorId: uuid("treating_doctor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    treatmentType: text("treatment_type"),
    treatmentStatus: treatmentStatusEnum("treatment_status")
      .notNull()
      .default("ACTIVE"),
    recallIntervalDays: integer("recall_interval_days").notNull().default(180),
    active: boolean("active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("patients_file_number_unique").on(table.fileNumber),
    index("patients_mobile_idx").on(table.mobile),
    index("patients_treating_doctor_id_idx").on(table.treatingDoctorId),
    index("patients_treatment_status_idx").on(table.treatmentStatus),
    index("patients_active_idx").on(table.active),
  ]
);

export const patientsRelations = relations(patients, ({ one }) => ({
  treatingDoctor: one(users, {
    fields: [patients.treatingDoctorId],
    references: [users.id],
  }),
}));

export type Patient = typeof patients.$inferSelect;
export type NewPatient = typeof patients.$inferInsert;
