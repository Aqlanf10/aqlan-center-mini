import { CURRENCIES, formatMoney, type Currency } from "./money";

/**
 * Shift opening reviews (migration 0129; contract docs/finance/SHIFT_OPENING_REVIEWS_0129.md; owner #483
 * 6831365228 item 1).
 *
 * The opening is compared, per currency, with what was counted when the previous shift closed. A
 * difference is recorded in the opening's own transaction and later reviewed once, with a reason and a
 * settlement, by a person. Nothing here writes a voucher, a payment, an expense, a deposit, a withdrawal
 * or a journal entry, and the previous shift is only read.
 */

/** Shared by the canonical and the legacy opening and by the canonical close. */
export const CASHIER_SHIFT_LIFECYCLE_LOCK = "aqlan.canonical.cashier-shift-lifecycle.v1";
export const OPENING_REVIEW_TEXT_MIN = 3;
export const OPENING_REVIEW_TEXT_MAX = 300;

type Queryable = { query: <R = Record<string, unknown>>(sql: string, args?: unknown[]) => Promise<{ rows: R[]; rowCount?: number | null }> };

export interface OpeningDifference {
  currency: Currency;
  previousShiftId: number;
  /** null: the previous close has no count for this currency (a legacy close). */
  previousCountedMinor: number | null;
  openingMinor: number;
  /** opening − previous counted; null when the previous count is unknown. */
  differenceMinor: number | null;
}

export interface OpeningReview extends OpeningDifference {
  id: number;
  shiftId: number;
  openingNote: string | null;
  detectedBy: string;
  detectedAt: string;
  reviewReason: string | null;
  reviewSettlement: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

/** The opener resends with a note after recounting; nothing was written. */
export class OpeningDifferenceNoteRequired extends Error {
  constructor(readonly differences: OpeningDifference[]) {
    super(openingDifferenceMessage(differences));
    this.name = "OpeningDifferenceNoteRequired";
  }
}

/** Trimmed text of 3–300 characters; `null` when absent or blank; `"invalid"` otherwise. */
export function reviewText(value: unknown): string | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "invalid";
  const text = value.trim();
  if (!text) return null;
  return text.length < OPENING_REVIEW_TEXT_MIN || text.length > OPENING_REVIEW_TEXT_MAX ? "invalid" : text;
}

function describe(difference: OpeningDifference): string {
  if (difference.differenceMinor === null) return `${difference.currency}: عدّ الإقفال السابق غير معروف`;
  const value = difference.differenceMinor;
  return `${value > 0 ? "زيادة" : "نقص"} ${formatMoney(Math.abs(value), difference.currency)}`;
}

export function openingDifferenceMessage(differences: OpeningDifference[]): string {
  return `عدّ الافتتاح لا يطابق ما عُدّ عند إقفال الوردية السابقة (${differences.map(describe).join("، ")}). `
    + "أعد العدّ، وإن صحّ فاكتب ملاحظة بما تعرفه ثم افتح الوردية. يُسجَّل الفرق للمراجعة، ولا تُنشأ أي حركة نقدية، ولا تتغير الوردية السابقة.";
}

const toNumber = (value: unknown) => value === null || value === undefined ? null : Number(value);

/** The previous close is the closed shift with the latest close time (ties: the higher id). */
export async function detectOpeningDifferences(q: Queryable, shiftId: number, opening: Record<Currency, number>):
  Promise<OpeningDifference[]> {
  const { rows } = await q.query<{ id: number; counted_yer: string | null; counted_sar: string | null; counted_usd: string | null }>(
    `SELECT id, counted_yer, counted_sar, counted_usd FROM cashier_shifts
      WHERE status = 'closed' AND id <> $1 ORDER BY closed_at DESC NULLS LAST, id DESC LIMIT 1`, [shiftId]);
  const previous = rows[0];
  if (!previous) return [];
  const differences: OpeningDifference[] = [];
  for (const currency of CURRENCIES) {
    const counted = toNumber(previous[`counted_${currency.toLowerCase()}` as "counted_yer"]);
    const openingMinor = opening[currency];
    if (counted === null) {
      if (openingMinor !== 0) differences.push({ currency, previousShiftId: previous.id, previousCountedMinor: null, openingMinor, differenceMinor: null });
    } else if (openingMinor !== counted) {
      differences.push({ currency, previousShiftId: previous.id, previousCountedMinor: counted, openingMinor, differenceMinor: openingMinor - counted });
    }
  }
  return differences;
}

const REVIEW_COLUMNS = `id, shift_id, currency, previous_shift_id, previous_counted_minor, opening_minor, difference_minor,
  opening_note, detected_by, detected_at, review_reason, review_settlement, reviewed_by, reviewed_at`;
type ReviewRow = {
  id: string; shift_id: number; currency: Currency; previous_shift_id: number; previous_counted_minor: string | null;
  opening_minor: string; difference_minor: string | null; opening_note: string | null; detected_by: string; detected_at: Date;
  review_reason: string | null; review_settlement: string | null; reviewed_by: string | null; reviewed_at: Date | null;
};
const toReview = (row: ReviewRow): OpeningReview => ({
  id: Number(row.id), shiftId: row.shift_id, currency: row.currency, previousShiftId: row.previous_shift_id,
  previousCountedMinor: toNumber(row.previous_counted_minor), openingMinor: Number(row.opening_minor),
  differenceMinor: toNumber(row.difference_minor), openingNote: row.opening_note, detectedBy: row.detected_by,
  detectedAt: row.detected_at.toISOString(), reviewReason: row.review_reason, reviewSettlement: row.review_settlement,
  reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
});

export async function recordOpeningDifferences(q: Queryable, shiftId: number, differences: OpeningDifference[],
  note: string | null, detectedBy: string): Promise<OpeningReview[]> {
  const reviews: OpeningReview[] = [];
  for (const d of differences) {
    const { rows } = await q.query<ReviewRow>(
      `INSERT INTO shift_opening_reviews (shift_id, currency, previous_shift_id, previous_counted_minor, opening_minor,
         difference_minor, opening_note, detected_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${REVIEW_COLUMNS}`,
      [shiftId, d.currency, d.previousShiftId, d.previousCountedMinor, d.openingMinor, d.differenceMinor, note, detectedBy]);
    reviews.push(toReview(rows[0]));
  }
  return reviews;
}

export async function listOpeningReviewsWith(q: Queryable, filter: { shiftId?: number; pendingOnly?: boolean; limit?: number } = {}):
  Promise<OpeningReview[]> {
  const where: string[] = [], args: unknown[] = [];
  if (filter.shiftId !== undefined) { args.push(filter.shiftId); where.push(`shift_id = $${args.length}`); }
  if (filter.pendingOnly) where.push("reviewed_at IS NULL");
  args.push(Math.min(Math.max(filter.limit ?? 200, 1), 200));
  const { rows } = await q.query<ReviewRow>(
    `SELECT ${REVIEW_COLUMNS} FROM shift_opening_reviews ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY detected_at DESC, id DESC LIMIT $${args.length}`, args);
  return rows.map(toReview);
}

/** Free text (the opener's note, the reason and the settlement) is shown only where shift notes are, or to
 * whoever can review; amounts and states are shown to every shift viewer. */
export function projectOpeningReview(review: OpeningReview, text: boolean): OpeningReview {
  return text ? review : { ...review, openingNote: null, reviewReason: null, reviewSettlement: null };
}

export async function pendingOpeningReviewCountWith(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ count: string }>("SELECT count(*) FROM shift_opening_reviews WHERE reviewed_at IS NULL");
  return Number(rows[0].count);
}

export type OpeningReviewRefusal = "not_found" | "already_reviewed" | "own_shift";

/**
 * The single review of one pending difference, on the caller's transaction. The row is locked first;
 * a non-owner reviewer may not review a shift they opened or whose previous close they made.
 */
export async function reviewOpeningDifferenceWith(q: Queryable, input: {
  id: number; reason: string; settlement: string; reviewer: { userId: number; username: string }; owner: boolean;
}): Promise<{ review: OpeningReview | null; refusal: OpeningReviewRefusal | null }> {
  const { rows } = await q.query<ReviewRow & { opened_by: string; previous_closed_by: string | null }>(
    `SELECT r.id, r.shift_id, r.currency, r.previous_shift_id, r.previous_counted_minor, r.opening_minor,
            r.difference_minor, r.opening_note, r.detected_by, r.detected_at, r.review_reason, r.review_settlement,
            r.reviewed_by, r.reviewed_at, s.opened_by, p.closed_by AS previous_closed_by
       FROM shift_opening_reviews r
       JOIN cashier_shifts s ON s.id = r.shift_id
       JOIN cashier_shifts p ON p.id = r.previous_shift_id
      WHERE r.id = $1 FOR UPDATE OF r`, [input.id]);
  const row = rows[0];
  if (!row) return { review: null, refusal: "not_found" };
  if (row.reviewed_at) return { review: toReview(row), refusal: "already_reviewed" };
  const same = (a: string | null) => a !== null && a.trim().toLowerCase() === input.reviewer.username.trim().toLowerCase();
  if (!input.owner && (same(row.opened_by) || same(row.detected_by) || same(row.previous_closed_by))) {
    return { review: null, refusal: "own_shift" };
  }
  const { rows: updated } = await q.query<ReviewRow>(
    `UPDATE shift_opening_reviews SET review_reason = $2, review_settlement = $3, reviewed_by_user_id = $4,
            reviewed_by = $5, reviewed_at = now()
      WHERE id = $1 AND reviewed_at IS NULL RETURNING ${REVIEW_COLUMNS}`,
    [input.id, input.reason, input.settlement, input.reviewer.userId, input.reviewer.username]);
  if (!updated[0]) return { review: null, refusal: "already_reviewed" };
  return { review: toReview(updated[0]), refusal: null };
}
