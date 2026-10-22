/**
 * Server-proven outcome of a collection attempt key (0068). A client that holds a refused
 * or unanswered collection keeps its key; it may drop it only after this proves the key
 * never committed AND can never commit. The insert below and every receipt / split group
 * insert take the same per-key transaction lock in the database, so the answer cannot be
 * overtaken by a send of the same key that is still in flight.
 */
import type { SessionPayload } from "./auth";
import { getPool, insertAuditRow } from "./db";
import { IDEMPOTENCY_KEY_PATTERN } from "./idempotency-key";
import { canHandleMoney } from "./roles";
import { revalidateSessionInTransaction } from "./session";

export const COLLECTION_KEY_COMMITTED = "collection key already committed";
export const COLLECTION_KEY_RETIRED = "collection key was retired";
export const RETIRED_COLLECTION_MESSAGE = "أُلغيت هذه المحاولة بعد التحقق من أنها لم تُحفظ. ابدأ تحصيلًا جديدًا إن كان مقصودًا.";
export type CollectionAttemptOutcome = "retired" | "committed";
export class CollectionAttemptError extends Error {
  constructor(readonly status: 400 | 403, message: string) { super(message); }
}

/** Uniform 409 body for a late send of a retired key: nothing was recorded. */
export function retiredCollectionRefusal() {
  return { reason: "collection_attempt_retired", message: RETIRED_COLLECTION_MESSAGE };
}
/** True for the database refusal of a send whose key was already retired. */
export function isRetiredCollectionKey(error: unknown): boolean {
  return error instanceof Error && error.message === COLLECTION_KEY_RETIRED;
}

export async function retireCollectionAttempt(key: unknown, patientId: unknown, session: SessionPayload): Promise<CollectionAttemptOutcome> {
  if (typeof key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(key)) throw new CollectionAttemptError(400, "مفتاح المحاولة غير صالح.");
  if (typeof patientId !== "number" || !Number.isSafeInteger(patientId) || patientId <= 0) throw new CollectionAttemptError(400, "حدّد المريض صاحب المحاولة.");
  const client = await getPool().connect();
  let destroy = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const current = await revalidateSessionInTransaction(session, client);
    if (!current || !canHandleMoney(current.role)) throw new CollectionAttemptError(403, "التحقق من محاولة التحصيل للإدارة والاستقبال والصندوق.");
    // The attempt belongs to one patient; a missing patient proves nothing and retires nothing.
    if (!(await client.query("SELECT 1 FROM patients WHERE id=$1", [patientId])).rows.length) throw new CollectionAttemptError(400, "المريض صاحب المحاولة غير موجود.");
    await client.query("SAVEPOINT retire");
    try {
      await client.query("INSERT INTO collection_attempt_retirements(idempotency_key,patient_id,retired_by) VALUES($1,$2,$3)", [key, patientId, current.username]);
    } catch (error) {
      if (error instanceof Error && error.message === COLLECTION_KEY_COMMITTED) {
        await client.query("ROLLBACK TO SAVEPOINT retire");
        await client.query("COMMIT");
        return "committed";
      }
      // Already retired by an earlier reconcile (lost reply): the same proven answer, for the same patient only.
      if ((error as { code?: string }).code === "23505") {
        await client.query("ROLLBACK TO SAVEPOINT retire");
        const { rows: [prior] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM collection_attempt_retirements WHERE idempotency_key=$1", [key]);
        await client.query("COMMIT");
        if (prior?.patient_id !== patientId) throw new CollectionAttemptError(400, "مفتاح المحاولة يخص مريضًا آخر.");
        return "retired";
      }
      throw error;
    }
    await insertAuditRow(client, { action: "payment.attempt_retire", entity: "payment_attempt", entityId: null,
      details: { idempotencyKey: key, patientId }, actor: current.username, actorRole: current.role });
    await client.query("COMMIT");
    return "retired";
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { destroy = true; }
    throw error;
  } finally { client.release(destroy); }
}
