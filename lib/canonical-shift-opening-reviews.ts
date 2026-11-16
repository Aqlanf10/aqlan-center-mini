import "server-only";
import { getPool, getShiftWith, insertAuditRow, shiftDrawerBreakdown, type CashierShift } from "./db";
import { CURRENCIES, parseAmount, type Currency } from "./money";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import {
  CASHIER_SHIFT_LIFECYCLE_LOCK, correctOpeningWith, listOpeningReviewsWith, projectOpeningReview, reviewOpeningDifferenceWith,
  reviewText, type OpeningCorrection, type OpeningReview, type OpeningReviewView,
} from "./shift-opening-reviews";
import {
  staffOperationCapabilities, staffOperationIdentity, staffOperationIsProtectedOwner, withStaffOperation,
} from "./staff-operation-runtime";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * The review of a shift's opening difference (migration 0129; docs/finance/SHIFT_OPENING_REVIEWS_0129.md
 * §2.2; owner #483 6831365228 item 1). Canonical only: the protected owner, or a holder of
 * `finance.shifts.review-opening`, never a role label. A non-owner may not review a shift they opened or
 * whose previous close they made. The review and its audit row share one transaction; it writes no cash
 * movement and never touches either shift.
 */
const ACTION = "finance.shifts.review-opening" as const;

export class CanonicalOpeningReviewRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message); this.name = "CanonicalOpeningReviewRefusal";
  }
}

export async function commandCanonicalOpeningReview(session: VerifiedDurableSession, body: Record<string, unknown>,
  pool = getPool()): Promise<OpeningReview> {
  const id = Number(body.id);
  if ((typeof body.id !== "number" && typeof body.id !== "string") || !Number.isSafeInteger(id) || id <= 0) {
    throw new CanonicalOpeningReviewRefusal("invalid_opening_review", 400, "رقم مراجعة فرق الافتتاح غير صالح.");
  }
  const reason = reviewText(body.reason), settlement = reviewText(body.settlement);
  if (typeof reason !== "string" || reason === "invalid" || typeof settlement !== "string" || settlement === "invalid") {
    throw new CanonicalOpeningReviewRefusal("invalid_opening_review", 400,
      "اكتب سبب الفرق وكيف سُوّي، كلٌّ منهما بين 3 و300 حرف. لم يُسجَّل شيء.");
  }
  return withStaffOperation(pool, session, ACTION, async (client, handle) => {
    const held = await staffOperationCapabilities(client, handle, ACTION, [ACTION] as const);
    const owner = await staffOperationIsProtectedOwner(client, handle, ACTION);
    if (!owner && !held.has(ACTION)) throw new Error("STAFF_OPERATION_CAPABILITY_DENIED");
    const identity = await staffOperationIdentity(client, handle, ACTION);
    const result = await reviewOpeningDifferenceWith(client, {
      id, reason, settlement, owner, reviewer: { userId: identity.userId, username: identity.username },
    });
    if (result.refusal === "not_found") {
      throw new CanonicalOpeningReviewRefusal("opening_review_not_found", 404, "فرق الافتتاح المطلوب غير موجود.");
    }
    if (result.refusal === "already_reviewed") {
      throw new CanonicalOpeningReviewRefusal("opening_review_already_done", 409,
        "روجع هذا الفرق من قبل، والمراجعة لا تُعدَّل. لم يُسجَّل شيء.");
    }
    if (result.refusal === "own_shift") {
      throw new CanonicalOpeningReviewRefusal("opening_review_own_shift", 403,
        "لا تراجع فرقًا في وردية فتحتها أنت أو أقفلت الوردية السابقة لها؛ يراجعه شخص آخر أو المالك. لم يُسجَّل شيء.");
    }
    const review = result.review!;
    await insertAuditRow(client, { action: "shift.opening_review", entity: "shift", entityId: review.shiftId,
      details: { المراجعة: review.id, العملة: review.currency, الوردية_السابقة: review.previousShiftId,
        الفرق: review.differenceMinor, السبب: review.reviewReason, التسوية: review.reviewSettlement },
      actor: identity.username, actorRole: identity.role });
    return review;
  });
}

/** §8.2: amounts, the previous close and the review texts only for the owner or a reviewer; everyone else who may
 * view shifts sees which currency of which shift waits for review, and its state. */
export async function readCanonicalOpeningReviews(session: VerifiedDurableSession, filter: { status?: unknown }):
  Promise<{ reviews: OpeningReviewView[]; canReview: boolean }> {
  const pendingOnly = filter.status !== "all";
  return runCanonicalReadSnapshot(session, "finance.shifts.view", async (query, scope) => {
    const canReview = scope.granted(ACTION);
    const rows = await listOpeningReviewsWith(query, { pendingOnly, limit: 200 });
    return { reviews: rows.map(row => projectOpeningReview(row, canReview)), canReview };
  }, { errorPrefix: "STAFF_READ", maxBytes: 512 * 1024 });
}

/**
 * §8.4: correct the open shift's opening count. The owner or a reviewer who neither opened it nor closed the
 * previous shift; never the opener. Under the shift lifecycle lock and the shift row lock; one append-only row
 * per changed currency, the new opening and the audit row in one transaction; no cash movement; a correction
 * that leaves the drawer's expected cash negative is refused and rolls back.
 */
export async function commandCanonicalOpeningCorrection(session: VerifiedDurableSession, body: Record<string, unknown>,
  pool = getPool()): Promise<{ shift: CashierShift; corrections: OpeningCorrection[] }> {
  const shiftId = Number(body.shiftId);
  if ((typeof body.shiftId !== "number" && typeof body.shiftId !== "string") || !Number.isSafeInteger(shiftId) || shiftId <= 0) {
    throw new CanonicalOpeningReviewRefusal("invalid_opening_correction", 400, "رقم الوردية غير صالح. لم يُسجَّل شيء.");
  }
  const reason = reviewText(body.reason);
  if (typeof reason !== "string" || reason === "invalid") {
    throw new CanonicalOpeningReviewRefusal("invalid_opening_correction", 400, "اكتب سبب التصحيح بين 3 و300 حرف. لم يُسجَّل شيء.");
  }
  const source = body.opening;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new CanonicalOpeningReviewRefusal("invalid_opening_correction", 400, "اكتب العدّ المصحَّح. لم يُسجَّل شيء.");
  }
  const opening: Partial<Record<Currency, number>> = {};
  for (const currency of CURRENCIES) {
    const raw = (source as Record<string, unknown>)[currency];
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) continue;
    const minor = typeof raw === "string" || typeof raw === "number" ? parseAmount(String(raw), currency) : null;
    if (minor === null || minor < 0) throw new CanonicalOpeningReviewRefusal("invalid_opening_correction", 400, "مبلغ العدّ المصحَّح غير صحيح. لم يُسجَّل شيء.");
    opening[currency] = minor;
  }
  return withStaffOperation(pool, session, ACTION, async (client, handle) => {
    const held = await staffOperationCapabilities(client, handle, ACTION, [ACTION] as const);
    const owner = await staffOperationIsProtectedOwner(client, handle, ACTION);
    if (!owner && !held.has(ACTION)) throw new Error("STAFF_OPERATION_CAPABILITY_DENIED");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [CASHIER_SHIFT_LIFECYCLE_LOCK]);
    const identity = await staffOperationIdentity(client, handle, ACTION);
    const result = await correctOpeningWith(client, {
      shiftId, opening, reason, owner, corrector: { userId: identity.userId, username: identity.username },
      expectedAfter: async () => (await shiftDrawerBreakdown((await getShiftWith(client, shiftId))!, client)).expected,
    });
    if (result.refusal === "not_open") {
      throw new CanonicalOpeningReviewRefusal("opening_correction_shift_not_open", 409, "الوردية مقفلة أو غير موجودة؛ يُصحَّح عدّ وردية مفتوحة فقط. لم يُسجَّل شيء.");
    }
    if (result.refusal === "own_shift") {
      throw new CanonicalOpeningReviewRefusal("opening_correction_own_shift", 403,
        "لا تصحّح عدّ وردية فتحتها أنت أو أقفلت الوردية السابقة لها؛ يصحّحه شخص آخر أو المالك. لم يُسجَّل شيء.");
    }
    if (result.refusal === "no_change") {
      throw new CanonicalOpeningReviewRefusal("invalid_opening_correction", 400, "العدّ المصحَّح يساوي العدّ المسجَّل؛ لا شيء يُصحَّح. لم يُسجَّل شيء.");
    }
    if (result.refusal === "negative_drawer") {
      // Rolls back the rows and the opening already written on this transaction.
      throw new CanonicalOpeningReviewRefusal("opening_correction_negative_drawer", 409,
        "بعد هذا التصحيح يصير النقد المتوقَّع في الدرج سالبًا؛ راجع العدّ والحركات. لم يُسجَّل شيء.");
    }
    await insertAuditRow(client, { action: "shift.opening_correct", entity: "shift", entityId: shiftId,
      details: { التصحيحات: result.corrections.map(c => ({ العملة: c.currency, من: c.fromMinor, إلى: c.toMinor })), السبب: reason },
      actor: identity.username, actorRole: identity.role });
    return { shift: (await getShiftWith(client, shiftId))!, corrections: result.corrections };
  });
}
