import { relations } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { visits } from "./visits";
import { users } from "./users";

/**
 * Append-only corrections for COMPLETED visits.
 *
 * Completed visits are immutable — history is never rewritten. A later
 * correction is recorded here (visible on the visit page + audit log),
 * written by ADMIN with a mandatory reason.
 */
export const visitCorrections = pgTable(
  "visit_corrections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    visitId: uuid("visit_id")
      .notNull()
      .references(() => visits.id, { onDelete: "cascade" }),
    note: text("note").notNull(),
    reason: text("reason").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("visit_corrections_visit_id_idx").on(table.visitId)]
);

export const visitCorrectionsRelations = relations(
  visitCorrections,
  ({ one }) => ({
    visit: one(visits, {
      fields: [visitCorrections.visitId],
      references: [visits.id],
    }),
    createdByUser: one(users, {
      fields: [visitCorrections.createdBy],
      references: [users.id],
    }),
  })
);

export type VisitCorrection = typeof visitCorrections.$inferSelect;
export type NewVisitCorrection = typeof visitCorrections.$inferInsert;
