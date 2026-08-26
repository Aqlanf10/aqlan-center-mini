import { relations } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { visitStatusEnum } from "./enums";
import { appointments } from "./appointments";
import { patients } from "./patients";
import { users } from "./users";

export const visits = pgTable(
  "visits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      // Medical history is immutable: deleting a patient must never
      // cascade-delete visit records (restrict = hard safety net).
      .references(() => patients.id, { onDelete: "restrict" }),
    doctorId: uuid("doctor_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    appointmentId: uuid("appointment_id").references(() => appointments.id, {
      onDelete: "set null",
    }),
    visitDate: timestamp("visit_date", { withTimezone: true }).notNull(),
    chiefComplaint: text("chief_complaint"),
    treatmentPerformed: text("treatment_performed").notNull(),
    clinicalNotes: text("clinical_notes"),
    nextVisitPlan: text("next_visit_plan"),
    nextAppointmentDate: timestamp("next_appointment_date", {
      withTimezone: true,
    }),
    status: visitStatusEnum("status").notNull().default("DRAFT"),
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
    index("visits_patient_id_idx").on(table.patientId),
    index("visits_doctor_id_idx").on(table.doctorId),
    index("visits_appointment_id_idx").on(table.appointmentId),
    index("visits_visit_date_idx").on(table.visitDate),
  ]
);

export const visitsRelations = relations(visits, ({ one }) => ({
  patient: one(patients, { fields: [visits.patientId], references: [patients.id] }),
  doctor: one(users, { fields: [visits.doctorId], references: [users.id] }),
  appointment: one(appointments, {
    fields: [visits.appointmentId],
    references: [appointments.id],
  }),
  createdByUser: one(users, {
    fields: [visits.createdBy],
    references: [users.id],
  }),
}));

export type Visit = typeof visits.$inferSelect;
export type NewVisit = typeof visits.$inferInsert;
