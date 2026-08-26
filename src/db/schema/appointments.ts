import { relations, sql } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
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
      // Clinical records must never be destroyed through the patient:
      // restrict (fail) instead of cascade-deleting medical history.
      .references(() => patients.id, { onDelete: "restrict" }),
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
    /**
     * Server-side double-booked-slot guard: one doctor cannot hold two
     * ACTIVE appointments at the exact same time. Cancelled/completed
     * appointments free the slot (partial index).
     *
     * The application checks conflicts first for friendly bilingual errors;
     * this index is the race-condition safety net at the database level.
     */
    uniqueIndex("appointments_doctor_time_active_unique")
      .on(table.doctorId, table.appointmentDate)
      .where(
        sql`status IN ('SCHEDULED', 'CONFIRMED', 'ARRIVED', 'IN_TREATMENT')`
      ),
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
