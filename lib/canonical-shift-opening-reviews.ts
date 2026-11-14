import "server-only";
import { getPool, insertAuditRow } from "./db";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import {
  listOpeningReviewsWith, projectOpeningReview, reviewOpeningDifferenceWith, reviewText, type OpeningReview,
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

export async function readCanonicalOpeningReviews(session: VerifiedDurableSession, filter: { status?: unknown }):
  Promise<{ reviews: OpeningReview[]; text: boolean; canReview: boolean }> {
  const pendingOnly = filter.status !== "all";
  return runCanonicalReadSnapshot(session, "finance.shifts.view", async (query, scope) => {
    const canReview = scope.granted(ACTION);
    const text = canReview || (scope.granted("finance.payments.view") && scope.granted("finance.expenses.view")
      && scope.patientScope.kind === "all");
    const rows = await listOpeningReviewsWith(query, { pendingOnly, limit: 200 });
    return { reviews: rows.map(row => projectOpeningReview(row, text)), text, canReview };
  }, { errorPrefix: "STAFF_READ", maxBytes: 512 * 1024 });
}
