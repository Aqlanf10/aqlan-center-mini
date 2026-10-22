/**
 * Server-proven outcome of a collection attempt key (0068). A client that holds a refused
 * or unanswered collection keeps its key; it may drop it only after this proves the key
 * never committed AND can never commit. The insert below and every receipt / split group
 * insert take the same per-key transaction lock in the database, so the answer cannot be
 * overtaken by a send of the same key that is still in flight.
 */
import { createHash } from "node:crypto";
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
  constructor(readonly status: 400 | 403 | 409, message: string) { super(message); }
}
/** The attempt as the client saved it: the proof is bound to exactly this, never to the current screen. */
export interface CollectionAttemptIdentity {
  idempotencyKey: unknown; patientId: unknown; operation: unknown; requestBody: unknown; originalActor: unknown;
}
export const ATTEMPT_OWNER_CHANGED = "بدأت هذه المحاولة باسم مستخدم آخر؛ لا تُلغى من جلسة مختلفة. تبقى محفوظة حتى يتحقق منها صاحبها.";
const REQUEST_BODY_LIMIT = 16_384;

/** Uniform 409 body for a late send of a retired key: nothing was recorded. */
export function retiredCollectionRefusal() {
  return { reason: "collection_attempt_retired", message: RETIRED_COLLECTION_MESSAGE };
}
/** True for the database refusal of a send whose key was already retired. */
export function isRetiredCollectionKey(error: unknown): boolean {
  return error instanceof Error && error.message === COLLECTION_KEY_RETIRED;
}

export async function retireCollectionAttempt(attempt: CollectionAttemptIdentity, session: SessionPayload): Promise<CollectionAttemptOutcome> {
  const { idempotencyKey: key, patientId, operation, requestBody, originalActor } = attempt;
  if (typeof key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(key)) throw new CollectionAttemptError(400, "مفتاح المحاولة غير صالح.");
  if (typeof patientId !== "number" || !Number.isSafeInteger(patientId) || patientId <= 0) throw new CollectionAttemptError(400, "حدّد المريض صاحب المحاولة.");
  if (operation !== "payment" && operation !== "installment") throw new CollectionAttemptError(400, "نوع المحاولة غير صالح.");
  if (typeof requestBody !== "string" || !requestBody || requestBody.length > REQUEST_BODY_LIMIT) throw new CollectionAttemptError(400, "الطلب المحفوظ للمحاولة غير صالح.");
  if (typeof originalActor !== "string" || !originalActor.trim()) throw new CollectionAttemptError(400, "صاحب المحاولة غير محدد.");
  // The saved request names its own patient; a request for another patient proves nothing here.
  let parsed: unknown;
  try { parsed = JSON.parse(requestBody); } catch { throw new CollectionAttemptError(400, "الطلب المحفوظ للمحاولة غير صالح."); }
  if (!parsed || typeof parsed !== "object" || (parsed as { patientId?: unknown }).patientId !== patientId) throw new CollectionAttemptError(400, "الطلب المحفوظ للمحاولة يخص مريضًا آخر.");
  const requestHash = createHash("sha256").update(requestBody).digest("hex");
  const client = await getPool().connect();
  let destroy = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const current = await revalidateSessionInTransaction(session, client);
    if (!current || !canHandleMoney(current.role)) throw new CollectionAttemptError(403, "التحقق من محاولة التحصيل للإدارة والاستقبال والصندوق.");
    // A replaced session never retires another user's uncertain attempt.
    if (current.username !== originalActor) throw new CollectionAttemptError(409, ATTEMPT_OWNER_CHANGED);
    // The attempt belongs to one patient; a missing patient proves nothing and retires nothing.
    if (!(await client.query("SELECT 1 FROM patients WHERE id=$1", [patientId])).rows.length) throw new CollectionAttemptError(400, "المريض صاحب المحاولة غير موجود.");
    await client.query("SAVEPOINT retire");
    try {
      await client.query(`INSERT INTO collection_attempt_retirements(idempotency_key,patient_id,operation,request_hash,retired_by)
        VALUES($1,$2,$3,$4,$5)`, [key, patientId, operation, requestHash, current.username]);
    } catch (error) {
      if (error instanceof Error && error.message === COLLECTION_KEY_COMMITTED) {
        await client.query("ROLLBACK TO SAVEPOINT retire");
        await client.query("COMMIT");
        return "committed";
      }
      // Already retired by an earlier reconcile (lost reply): the same proven answer, for the same attempt only.
      if ((error as { code?: string }).code === "23505") {
        await client.query("ROLLBACK TO SAVEPOINT retire");
        const { rows: [prior] } = await client.query<{ patient_id: number; operation: string; request_hash: string; retired_by: string }>(
          "SELECT patient_id,operation,request_hash,retired_by FROM collection_attempt_retirements WHERE idempotency_key=$1", [key]);
        await client.query("COMMIT");
        if (prior?.patient_id !== patientId || prior.operation !== operation || prior.request_hash !== requestHash || prior.retired_by !== current.username)
          throw new CollectionAttemptError(409, "مفتاح المحاولة أُلغي لطلب أو مستخدم مختلف؛ لا يُعاد استعماله.");
        return "retired";
      }
      throw error;
    }
    await insertAuditRow(client, { action: "payment.attempt_retire", entity: "payment_attempt", entityId: null,
      details: { idempotencyKey: key, patientId, operation, requestHash }, actor: current.username, actorRole: current.role });
    await client.query("COMMIT");
    return "retired";
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { destroy = true; }
    throw error;
  } finally { client.release(destroy); }
}
