import { relations } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { appointmentStatusEnum } from "./enums";
import { patients } from "./patients";
import { users } from "./users";

export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    doctorId: uuid("doctor_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    appointmentDate: timestamp("appointment_date", {
      withTimezone: true,
    }).notNull(),
    reason: text("reason"),
    notes: text("notes"),
    status: appointmentStatusEnum("status").notNull().default("SCHEDULED"),
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
    index("appointments_appointment_date_idx").on(table.appointmentDate),
    index("appointments_status_idx").on(table.status),
    index("appointments_doctor_id_idx").on(table.doctorId),
    index("appointments_patient_id_idx").on(table.patientId),
  ]
);

export const appointmentsRelations = relations(appointments, ({ one }) => ({
  patient: one(patients, {
    fields: [appointments.patientId],
    references: [patients.id],
  }),
  doctor: one(users, { fields: [appointments.doctorId], references: [users.id] }),
  createdByUser: one(users, {
    fields: [appointments.createdBy],
    references: [users.id],
  }),
}));

export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;
