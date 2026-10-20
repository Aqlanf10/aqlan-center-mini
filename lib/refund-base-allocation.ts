/** Immutable receipt snapshot and cumulative committed refunds, all in minor units. */
export interface RefundBaseBudget {
  originalAmountMinor: number;
  originalBaseAmountMinor: number;
  refundedAmountMinor: number;
  refundedBaseAmountMinor: number;
}

/** A historical discrepancy is reviewable evidence, never an automatic repair. */
export function isRefundBaseBudgetValid(budget: RefundBaseBudget): boolean {
  const { originalAmountMinor: original, originalBaseAmountMinor: base,
    refundedAmountMinor: refunded, refundedBaseAmountMinor: refundedBase } = budget;
  return [original, base, refunded, refundedBase].every((value) => Number.isSafeInteger(value) && value >= 0)
    && original > 0 && refunded <= original && refundedBase <= base
    && (refunded !== original || refundedBase === base);
}

/**
 * Allocate from the original stored base budget, not a rounded FX revaluation.
 * Caller holds the origin lock and resolves exact idempotent replay FIRST.
 * BigInt keeps proportional multiplication exact even at safe-integer boundaries.
 * A negative allocation or inconsistent history requires review, never clamping.
 */
export function allocateRefundBaseMinor(budget: RefundBaseBudget, amountMinor: number): number | null {
  if (!isRefundBaseBudgetValid(budget) || !Number.isSafeInteger(amountMinor) || amountMinor <= 0
    || amountMinor > budget.originalAmountMinor - budget.refundedAmountMinor) return null;
  const original = BigInt(budget.originalAmountMinor);
  const cumulativeNative = BigInt(budget.refundedAmountMinor) + BigInt(amountMinor);
  const cumulativeBase = (2n * BigInt(budget.originalBaseAmountMinor) * cumulativeNative + original) / (2n * original);
  const allocated = cumulativeBase - BigInt(budget.refundedBaseAmountMinor);
  if (allocated < 0n || allocated > BigInt(budget.originalBaseAmountMinor - budget.refundedBaseAmountMinor)) return null;
  return Number(allocated);
}
