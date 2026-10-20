// Unit coverage for original stored base conservation.
import { describe, expect, it } from 'vitest';
import { allocateRefundBaseMinor, isRefundBaseBudgetValid } from '../lib/refund-base-allocation';
function allocation(originCash: number, originBase: number, priorCash: number, priorBase: number, cash: number) {
    const value = allocateRefundBaseMinor({ originalAmountMinor: originCash, originalBaseAmountMinor: originBase, refundedAmountMinor: priorCash, refundedBaseAmountMinor: priorBase }, cash);
    if (value === null)
        throw new Error('review');
    return value;
}
describe('exact origin-base conservation', () => {
    it('rejects unsafe, negative and fully-refunded inconsistent evidence', () => { const valid = { originalAmountMinor: 100, originalBaseAmountMinor: 140, refundedAmountMinor: 0, refundedBaseAmountMinor: 0 }; for (const field of Object.keys(valid))
        for (const value of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])
            expect(isRefundBaseBudgetValid({ ...valid, [field]: value })).toBe(false); expect(isRefundBaseBudgetValid({ ...valid, refundedAmountMinor: 100, refundedBaseAmountMinor: 139 })).toBe(false); expect(isRefundBaseBudgetValid({ ...valid, originalAmountMinor: 0 })).toBe(false); });
    it('fully refunds the legacy 81 SAR-minor / 113 YER snapshot, not repriced 114', () => { expect(allocation(81, 113, 0, 0, 81)).toBe(113); });
    it('cash splits conserve base exactly using cumulative integer rounding', () => { const a = allocation(3, 4, 0, 0, 1); const b = allocation(3, 4, 1, a, 1); const c = allocation(3, 4, 2, a + b, 1); expect([a, b, c]).toEqual([1, 2, 1]); expect(a + b + c).toBe(4); });
    it('supports a remaining refund after legacy positive rounding drift while preserving prior receipts', () => { expect(allocation(81, 113, 40, 57, 41)).toBe(56); expect(57 + 56).toBe(113); });
    it('refuses already excessive legacy base refunds or a negative next allocation, instead of rewriting/clamping', () => { expect(() => allocation(81, 113, 40, 114, 41)).toThrow('review'); expect(() => allocation(100, 10, 10, 9, 10)).toThrow('review'); });
    it('uses BigInt so safe-integer inputs cannot overflow during proportional multiplication', () => { const n = Number.MAX_SAFE_INTEGER; expect(allocation(n, n - 1, 0, 0, n)).toBe(n - 1); expect(allocation(n, n - 1, n - 1, n - 2, 1)).toBe(1); });
    it('exhaustively conserves many cash partitions and never reverses excess base', () => { for (let native = 1; native <= 100; native++) {
        for (let base = 0; base <= 200; base++) {
            let done = 0, total = 0;
            while (done < native) {
                const amount = Math.min(1 + (done % 7), native - done);
                const delta = allocation(native, base, done, total, amount);
                if (delta < 0)
                    throw new Error('negative delta');
                done += amount;
                total += delta;
                if (total > base)
                    throw new Error('excess base');
            }
            if (total !== base)
                throw new Error('nonconservation');
        }
    } expect(true).toBe(true); });
});
