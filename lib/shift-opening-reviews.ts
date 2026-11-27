import { CURRENCIES, type Currency } from "./money";

/**
 * Shift opening reviews (migration 0129; contract docs/finance/SHIFT_OPENING_REVIEWS_0129.md; owner #483
 * 6831365228 item 1; blind count, owner #483 6886911163, contract §8).
 *
 * The opening is compared, per currency, with what was counted when the previous shift closed. A
 * difference is recorded in the opening's own transaction and later reviewed once, with a reason and a
 * settlement, by a person. Nothing here writes a voucher, a payment, an expense, a deposit, a withdrawal
 * or a journal entry, and the previous shift is only read.
 *
 * Blind count: the count is committed before any comparison is shown. Only an authorized viewer (the
 * protected owner or `finance.shifts.review-opening`; on the legacy runtime the admin) sees the previous
 * count and the difference; everyone else learns only that a currency waits for review. Until the next count
 * is fixed, the latest close's amounts are sealed for everyone else too (`sealShiftForViewer`).
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

export type OpeningReviewState = "pending" | "reviewed";
export interface OpeningReview extends OpeningDifference {
  id: number;
  shiftId: number;
  state: OpeningReviewState;
  detectedBy: string;
  detectedAt: string;
  reviewReason: string | null;
  reviewSettlement: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

/** Trimmed text of 3–300 characters; `null` when absent or blank; `"invalid"` otherwise. */
export function reviewText(value: unknown): string | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "invalid";
  const text = value.trim();
  if (!text) return null;
  return text.length < OPENING_REVIEW_TEXT_MIN || text.length > OPENING_REVIEW_TEXT_MAX ? "invalid" : text;
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
  detected_by, detected_at, review_reason, review_settlement, reviewed_by, reviewed_at`;
type ReviewRow = {
  id: string; shift_id: number; currency: Currency; previous_shift_id: number; previous_counted_minor: string | null;
  opening_minor: string; difference_minor: string | null; detected_by: string; detected_at: Date;
  review_reason: string | null; review_settlement: string | null; reviewed_by: string | null; reviewed_at: Date | null;
};
const toReview = (row: ReviewRow): OpeningReview => ({
  id: Number(row.id), shiftId: row.shift_id, currency: row.currency, previousShiftId: row.previous_shift_id,
  previousCountedMinor: toNumber(row.previous_counted_minor), openingMinor: Number(row.opening_minor),
  differenceMinor: toNumber(row.difference_minor), state: row.reviewed_at ? "reviewed" : "pending", detectedBy: row.detected_by,
  detectedAt: row.detected_at.toISOString(), reviewReason: row.review_reason, reviewSettlement: row.review_settlement,
  reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
});

export async function recordOpeningDifferences(q: Queryable, shiftId: number, differences: OpeningDifference[],
  detectedBy: string): Promise<OpeningReview[]> {
  const reviews: OpeningReview[] = [];
  for (const d of differences) {
    const { rows } = await q.query<ReviewRow>(
      `INSERT INTO shift_opening_reviews (shift_id, currency, previous_shift_id, previous_counted_minor, opening_minor,
         difference_minor, detected_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${REVIEW_COLUMNS}`,
      [shiftId, d.currency, d.previousShiftId, d.previousCountedMinor, d.openingMinor, d.differenceMinor, detectedBy]);
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
      ORDER BY ${filter.shiftId !== undefined ? "id" : "detected_at DESC, id DESC"} LIMIT $${args.length}`, args);
  return rows.map(toReview);
}

/** §8.2: what an unauthorized viewer may know about a difference: that it exists for a currency, and its state. */
export interface OpeningReviewNotice { id: number; shiftId: number; currency: Currency; state: OpeningReviewState }
export type OpeningReviewView = OpeningReview | OpeningReviewNotice;
export function projectOpeningReview(review: OpeningReview, authorized: boolean): OpeningReviewView {
  return authorized ? review : { id: review.id, shiftId: review.shiftId, currency: review.currency, state: review.state };
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
            r.difference_minor, r.detected_by, r.detected_at, r.review_reason, r.review_settlement,
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

// ---------------------------------------------------------------------------------------------------------
// §8.3 The previous close is sealed until the next count is fixed.

/** The latest closed shift while no shift is open; null when a shift is open (its count is already fixed). */
export async function sealedCloseIdWith(q: Queryable): Promise<number | null> {
  const { rows } = await q.query<{ id: number | null }>(
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open') THEN NULL
            ELSE (SELECT id FROM cashier_shifts WHERE status = 'closed' ORDER BY closed_at DESC NULLS LAST, id DESC LIMIT 1) END AS id`);
  return rows[0]?.id ?? null;
}

interface SealableShift {
  id: number;
  counted: Record<Currency, number> | null;
  expected: Record<Currency, number> | null;
  difference: Record<Currency, number> | null;
  note?: string | null;
  differenceReason?: string | null;
}
export type SealedFields = { counted: null; expected: null; difference: null; note: null; differenceReason: null; sealed: true };
/** The sealed close loses every amount and text that could disclose its count; anything else is unchanged. */
export function sealShiftForViewer<T extends SealableShift>(shift: T, sealedId: number | null, authorized: boolean): T | (Omit<T, keyof SealedFields> & SealedFields) {
  if (authorized || sealedId === null || shift.id !== sealedId) return shift;
  return { ...shift, counted: null, expected: null, difference: null, note: null, differenceReason: null, sealed: true };
}

// ---------------------------------------------------------------------------------------------------------
// §8.4 Correction of the opening count: authorized, audited, append-only, never by the opener.

export interface OpeningCorrection {
  id: number; shiftId: number; currency: Currency; fromMinor: number; toMinor: number;
  reason: string; correctedBy: string; correctedAt: string;
}
export interface OpeningCorrectionNotice { id: number; shiftId: number; currency: Currency }
export type OpeningCorrectionView = OpeningCorrection | OpeningCorrectionNotice;
type CorrectionRow = { id: string; shift_id: number; currency: Currency; from_minor: string; to_minor: string; reason: string; corrected_by: string; corrected_at: Date };
const CORRECTION_COLUMNS = "id, shift_id, currency, from_minor, to_minor, reason, corrected_by, corrected_at";
const toCorrection = (row: CorrectionRow): OpeningCorrection => ({ id: Number(row.id), shiftId: row.shift_id, currency: row.currency,
  fromMinor: Number(row.from_minor), toMinor: Number(row.to_minor), reason: row.reason, correctedBy: row.corrected_by,
  correctedAt: row.corrected_at.toISOString() });
export function projectOpeningCorrection(correction: OpeningCorrection, authorized: boolean): OpeningCorrectionView {
  return authorized ? correction : { id: correction.id, shiftId: correction.shiftId, currency: correction.currency };
}
export async function listOpeningCorrectionsWith(q: Queryable, shiftId: number): Promise<OpeningCorrection[]> {
  const { rows } = await q.query<CorrectionRow>(`SELECT ${CORRECTION_COLUMNS} FROM shift_opening_corrections WHERE shift_id = $1 ORDER BY id`, [shiftId]);
  return rows.map(toCorrection);
}

export type OpeningCorrectionRefusal = "not_open" | "own_shift" | "no_change" | "negative_drawer";

/**
 * Correct the opening of the OPEN shift on the caller's transaction, after the shift lifecycle lock. The shift
 * row is locked (as payment and expense writers lock it); a non-owner may not correct a shift they opened or
 * whose previous close they made. `expectedAfter` recomputes the drawer on the same transaction so that a
 * correction leaving the expected cash negative in a currency is refused (the caller rolls back).
 */
export async function correctOpeningWith(q: Queryable, input: {
  shiftId: number; opening: Partial<Record<Currency, number>>; reason: string;
  corrector: { userId: number; username: string }; owner: boolean;
  expectedAfter: () => Promise<Record<Currency, number>>;
}): Promise<{ corrections: OpeningCorrection[]; refusal: OpeningCorrectionRefusal | null }> {
  const { rows } = await q.query<{ id: number; opened_by: string; opening_yer: string; opening_sar: string; opening_usd: string }>(
    "SELECT id, opened_by, opening_yer, opening_sar, opening_usd FROM cashier_shifts WHERE id = $1 AND status = 'open' FOR UPDATE", [input.shiftId]);
  const shift = rows[0];
  if (!shift) return { corrections: [], refusal: "not_open" };
  const { rows: previous } = await q.query<{ closed_by: string | null }>(
    `SELECT closed_by FROM cashier_shifts WHERE status = 'closed' AND id <> $1 ORDER BY closed_at DESC NULLS LAST, id DESC LIMIT 1`, [shift.id]);
  const { rows: detectors } = await q.query<{ detected_by: string }>("SELECT DISTINCT detected_by FROM shift_opening_reviews WHERE shift_id = $1", [shift.id]);
  const same = (a: string | null | undefined) => !!a && a.trim().toLowerCase() === input.corrector.username.trim().toLowerCase();
  if (!input.owner && (same(shift.opened_by) || same(previous[0]?.closed_by) || detectors.some(d => same(d.detected_by)))) {
    return { corrections: [], refusal: "own_shift" };
  }
  const current: Record<Currency, number> = { YER: Number(shift.opening_yer), SAR: Number(shift.opening_sar), USD: Number(shift.opening_usd) };
  const changes = CURRENCIES.filter(currency => input.opening[currency] !== undefined && input.opening[currency] !== current[currency]);
  if (!changes.length) return { corrections: [], refusal: "no_change" };
  const corrections: OpeningCorrection[] = [];
  for (const currency of changes) {
    const to = input.opening[currency]!;
    const { rows: inserted } = await q.query<CorrectionRow>(
      `INSERT INTO shift_opening_corrections (shift_id, currency, from_minor, to_minor, reason, corrected_by_user_id, corrected_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${CORRECTION_COLUMNS}`,
      [shift.id, currency, current[currency], to, input.reason, input.corrector.userId, input.corrector.username]);
    await q.query(`UPDATE cashier_shifts SET opening_${currency.toLowerCase()} = $2 WHERE id = $1 AND status = 'open'`, [shift.id, to]);
    corrections.push(toCorrection(inserted[0]));
  }
  const expected = await input.expectedAfter();
  if (CURRENCIES.some(currency => expected[currency] < 0)) return { corrections: [], refusal: "negative_drawer" };
  return { corrections, refusal: null };
}
