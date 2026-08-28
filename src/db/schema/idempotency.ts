import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Idempotency keys for retryable financial mutations.
 *
 * A client-generated key (UUID per logical submission) is stored in the SAME
 * transaction as the movement it guards. Re-submitting the same key returns
 * the original entity instead of creating a duplicate — the database-level
 * barrier against double-clicks and request retries.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: text("key").primaryKey(),
    /** Logical operation, e.g. "payment" | "receipt-voucher". */
    scope: text("scope").notNull(),
    entityId: uuid("entity_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idempotency_keys_entity_idx").on(table.entityId)]
);

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKey = typeof idempotencyKeys.$inferInsert;
