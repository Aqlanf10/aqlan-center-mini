import { relations } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { contactResultEnum, contactTypeEnum } from "./enums";
import { patients } from "./patients";
import { users } from "./users";

export const patientContacts = pgTable(
  "patient_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    contactType: contactTypeEnum("contact_type").notNull(),
    result: contactResultEnum("result").notNull(),
    note: text("note"),
    contactedAt: timestamp("contacted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("patient_contacts_patient_id_idx").on(table.patientId),
    index("patient_contacts_user_id_idx").on(table.userId),
    index("patient_contacts_contacted_at_idx").on(table.contactedAt),
  ]
);

export const patientContactsRelations = relations(
  patientContacts,
  ({ one }) => ({
    patient: one(patients, {
      fields: [patientContacts.patientId],
      references: [patients.id],
    }),
    user: one(users, {
      fields: [patientContacts.userId],
      references: [users.id],
    }),
  })
);

export type PatientContact = typeof patientContacts.$inferSelect;
export type NewPatientContact = typeof patientContacts.$inferInsert;
