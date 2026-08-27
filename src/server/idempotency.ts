import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { idempotencyKeys } from "@/db/schema";

/**
 * Idempotency support for retryable financial mutations.
 *
 * The client sends a UUID key per logical submission (generated once per
 * dialog submit, reused across retries). The key is claimed inside the SAME
 * transaction as the movement:
 *
 *   1. Before running: look the key up — a hit returns the original entity
 *      (idempotent replay).
 *   2. Inside the tx: INSERT the key row (PK = key). A concurrent duplicate
 *      submission loses the race, the tx fails with a unique violation, and
 *      the loser re-reads the winner's entity id.
 *
 * This is the database-level barrier against double-clicks and retries.
 */

/** Executor interface shared by the db client and transactions. */
export interface IdempotencyExecutor {
  insert: typeof db.insert;
}

/** True when the error is a PostgreSQL unique-violation on the key table. */
export function isIdempotencyConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
  if (candidate.code !== "23505") return false;
  const constraint = String(candidate.constraint ?? "");
  const message = String(candidate.message ?? "");
  return (
    constraint.includes("idempotency_keys") || message.includes("idempotency_keys")
  );
}

/** Find the entity previously created under this key, if any. */
export async function findIdempotentEntityId(
  key: string,
  scope: string
): Promise<string | null> {
  const [row] = await db
    .select({ entityId: idempotencyKeys.entityId })
    .from(idempotencyKeys)
    .where(
      and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.scope, scope))
    )
    .limit(1);
  return row?.entityId ?? null;
}

/** Claim the key inside the movement's transaction (fails on duplicates). */
export async function claimIdempotencyKey(
  executor: IdempotencyExecutor,
  key: string,
  scope: string,
  entityId: string
): Promise<void> {
  await executor.insert(idempotencyKeys).values({ key, scope, entityId });
}
