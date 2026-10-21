/**
 * Advisory review of a similar patient collection — never a financial deduplication key.
 *
 * The check runs INSIDE each collection writer's transaction, after the writer holds the open
 * cashier-shift row (`FOR UPDATE`, the one fence every money writer takes) and after its exact
 * Idempotency-Key replay check. So:
 *  - a same-key retry of a committed (or still in-flight) request is always answered by replay,
 *    never by a similarity refusal (the in-flight original holds the shift row until it commits);
 *  - two devices with distinct keys serialize on the shift row: the second one sees the first
 *    one's committed receipt and is asked to review it;
 *  - a refusal rolls the whole transaction back, so nothing (receipt, drawer, installment,
 *    commission, audit) is written.
 * The review is advisory: confirming the exact receipts the server reported records an
 * independent payment. No manager, no reason, no automatic cancellation or deduplication.
 */
import type { Currency } from "./money";

export const SIMILAR_COLLECTION_WINDOW_HOURS = 24;
export const SIMILAR_COLLECTION_REVIEW_HEADER = "x-collection-similarity-review";
export const SIMILAR_COLLECTION_REASON = "similar_collection_review_required";
export const SIMILAR_COLLECTION_MESSAGE =
  "يوجد سند قبض مشابه لهذا المريض بالمبلغ والعملة نفسيهما خلال آخر 24 ساعة. راجع السند السابق، ثم ألغِ أو سجّل دفعة مستقلة.";
const MATCH_LIMIT = 32;

export interface SimilarCollectionReceipt {
  id: number; receiptNumber: string; amountMinor: number; currency: Currency;
  createdAt: string; method: string; invoiceId: number | null; planId: number | null;
  openingCurrency: Currency | null; createdBy: string;
}
/** The receipts the operator saw and confirmed; empty = "I saw none". */
export interface SimilarCollectionReview { observedReceiptIds: number[] }

type Queryable = { query: <R = unknown>(text: string, values?: unknown[]) => Promise<{ rows: R[] }> };
type ReceiptRow = {
  id: number; receipt_number: string; amount_minor: string; currency: Currency; created_at: Date | string;
  method: string; invoice_id: number | null; plan_id: number | null; opening_currency: Currency | null; created_by: string;
};

/** Thrown inside a writer transaction; the owner rolls back and the route answers 409. */
export class SimilarCollectionReviewRequired extends Error {
  constructor(readonly receipts: SimilarCollectionReceipt[]) { super(SIMILAR_COLLECTION_REASON); }
}

/** Header grammar: `none` or `ids:<id>,<id>…` in the order the server reported. Absent = none. */
export function parseSimilarCollectionReviewHeader(value: string | null): SimilarCollectionReview | null {
  if (value === null || value.trim() === "" || value.trim() === "none") return { observedReceiptIds: [] };
  const match = /^ids:(\d{1,10}(?:,\d{1,10}){0,31})$/.exec(value.trim());
  if (!match) return null;
  const ids = match[1].split(",").map(Number);
  if (!ids.every((id) => Number.isSafeInteger(id) && id > 0) || new Set(ids).size !== ids.length) return null;
  return { observedReceiptIds: ids };
}
export function formatSimilarCollectionReviewHeader(review: SimilarCollectionReview): string {
  return review.observedReceiptIds.length ? `ids:${review.observedReceiptIds.join(",")}` : "none";
}

/**
 * One patient, exact native tender amount and currency, preceding rolling 24h. A fully reversed
 * receipt is no longer collected; partial reversals stay visible. A split agreement collection
 * (one tender, several receipts) is matched by its tender total and shown as its first receipt.
 * Refund totals are grouped per original receipt AND currency (same-currency by construction).
 */
export async function findSimilarCollectionsOn(q: Queryable, patientId: number, amountMinor: number, currency: Currency): Promise<SimilarCollectionReceipt[]> {
  if (!Number.isSafeInteger(patientId) || patientId <= 0 || !Number.isSafeInteger(amountMinor) || amountMinor <= 0)
    throw new Error("invalid_collection_query");
  const { rows } = await q.query<ReceiptRow>(`
    WITH refunded AS (
      SELECT r.reversal_of_id, r.currency, SUM(r.amount_minor) AS refunded_minor
        FROM payments r
       WHERE r.patient_id = $1 AND r.kind = 'refund' AND r.reversal_of_id IS NOT NULL
       GROUP BY r.reversal_of_id, r.currency
    ), live AS (
      SELECT p.* FROM payments p
        LEFT JOIN refunded f ON f.reversal_of_id = p.id AND f.currency = p.currency
       WHERE p.patient_id = $1 AND p.kind = 'payment' AND p.reversal_of_id IS NULL
         AND p.created_at >= NOW() - INTERVAL '24 hours'
         AND p.amount_minor > COALESCE(f.refunded_minor, 0)
    ), split AS (
      SELECT g.payment_ids[1] AS first_id
        FROM agreement_delta_collection_receipts g
       WHERE g.patient_id = $1 AND cardinality(g.payment_ids) > 1
         AND g.created_at >= NOW() - INTERVAL '24 hours'
         AND g.result_snapshot->>'currency' = $3
         AND (g.result_snapshot->>'amountMinor')::bigint = $2
    )
    SELECT l.id, l.receipt_number, l.amount_minor::text AS amount_minor, l.currency, l.created_at,
           l.method, l.invoice_id, l.plan_id, l.opening_currency, l.created_by
      FROM live l
     WHERE (l.amount_minor = $2 AND l.currency = $3) OR l.id IN (SELECT first_id FROM split)
     ORDER BY l.created_at DESC, l.id DESC LIMIT $4
  `, [patientId, amountMinor, currency, MATCH_LIMIT]);
  return rows.map((row) => ({
    id: row.id, receiptNumber: row.receipt_number,
    // A split tender is reported at its tender total, which is what the operator compares.
    amountMinor, currency: row.currency,
    createdAt: new Date(row.created_at).toISOString(), method: row.method,
    invoiceId: row.invoice_id, planId: row.plan_id, openingCurrency: row.opening_currency, createdBy: row.created_by,
  }));
}

/**
 * Call on the writer's transaction client, after the shift lock and the exact-key replay check,
 * before any write. `review === undefined` means an internal caller that is not a human
 * collection entry point (corrections, refunds, migrations): no advisory applies.
 */
export async function assertSimilarCollectionReviewed(
  q: Queryable,
  input: { patientId: number; amountMinor: number; currency: Currency; review: SimilarCollectionReview | undefined },
): Promise<void> {
  if (input.review === undefined) return;
  const receipts = await findSimilarCollectionsOn(q, input.patientId, input.amountMinor, input.currency);
  const seen = input.review.observedReceiptIds;
  const same = receipts.length === seen.length && receipts.every((receipt, index) => receipt.id === seen[index]);
  if (!same) throw new SimilarCollectionReviewRequired(receipts);
}

/** Uniform 409 body: the reported receipts are what the operator must confirm. */
export function similarCollectionRefusal(error: SimilarCollectionReviewRequired) {
  return { reason: SIMILAR_COLLECTION_REASON, message: SIMILAR_COLLECTION_MESSAGE,
    windowHours: SIMILAR_COLLECTION_WINDOW_HOURS, receipts: error.receipts };
}

/** Client-side validation of a refusal body; anything else is not a proven review request. */
export function readSimilarCollectionRefusal(value: unknown): SimilarCollectionReceipt[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.reason !== SIMILAR_COLLECTION_REASON || v.windowHours !== SIMILAR_COLLECTION_WINDOW_HOURS || !Array.isArray(v.receipts)
    || v.receipts.length > MATCH_LIMIT) return null;
  const ok = v.receipts.every((r: unknown) => {
    const x = r as SimilarCollectionReceipt;
    return !!x && Number.isSafeInteger(x.id) && x.id > 0 && typeof x.receiptNumber === "string"
      && Number.isSafeInteger(x.amountMinor) && x.amountMinor > 0 && typeof x.currency === "string"
      && typeof x.createdAt === "string" && Number.isFinite(Date.parse(x.createdAt))
      && typeof x.method === "string" && typeof x.createdBy === "string"
      && (x.invoiceId === null || Number.isSafeInteger(x.invoiceId))
      && (x.planId === null || Number.isSafeInteger(x.planId))
      && (x.openingCurrency === null || typeof x.openingCurrency === "string");
  });
  return ok ? v.receipts as SimilarCollectionReceipt[] : null;
}
