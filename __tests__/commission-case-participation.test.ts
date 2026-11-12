/** Owner decision 2026-11-11 (finance point 3, option 2, per case): participants of a shared case
 * hold shares that add up to 100%; each is paid at his own contract rate on his part of the line's
 * base after the discount, with laboratory and material costs split the same way; without an
 * approved split the commission is held. Pure engine tests, synthetic numbers. */
import { describe, expect, it } from "vitest";
import {
  allocateByWeights, allocateInvoiceDiscount, caseParticipationProblem, commissionForPatientAtEventTime, splitShareByParticipation,
  type CaseParticipation, type CommissionInvoice, type CommissionPolicy, type CoverageChunk, type DoctorShareItem,
} from "../lib/commission";
import type { DoctorCommissionConfig } from "../lib/doctor-permissions";
import type { Currency } from "../lib/money";

const A = 7, B = 8, CASE = 55, AT = "2026-10-05T07:00:00.000Z";
const config = (percent: number, deduct = false) => ({ calculationMode: "percent", defaultPercent: percent, categoryRates: {}, fixedAmountPerVisitMinor: 0,
  deductLabCost: deduct, deductMaterialCost: deduct } as unknown as DoctorCommissionConfig);
const policies = (entries: Record<number, CommissionPolicy>) => (doctorId: number) => entries[doctorId];
const plain = (percent: number): CommissionPolicy => ({ percent, config: null });
const approved = (parts: [number, number][]): CaseParticipation => ({ caseId: CASE, status: "approved", participants: parts.map(([doctorId, shareBp]) => ({ doctorId, shareBp })) });
const line = (amountMinor: number, extra: Partial<DoctorShareItem> = {}, currency: Currency = "YER"): DoctorShareItem => ({ doctorId: A, amountMinor, currency, caseId: CASE, ...extra });
const invoice = (shares: DoctorShareItem[], netMinor: number, id = 1, currency: Currency = "YER"): CommissionInvoice => ({ id, netMinor, currency, createdAt: AT, doctorShares: shares });
const paid = (invoiceId: number, amount: number, sourceTime = "2026-10-10T07:00:00.000Z"): CoverageChunk => ({ invoiceId, amount, sourceTime });
function run(invoices: CommissionInvoice[], chunks: CoverageChunk[], policyAt: ReturnType<typeof policies>, participation?: CaseParticipation) {
  const held: { invoiceId: number; caseId: number; amountMinor: number }[] = [];
  const result = commissionForPatientAtEventTime(invoices, chunks, policyAt, undefined, {
    participationAt: participation ? caseId => (caseId === CASE ? participation : undefined) : undefined,
    onHeld: entry => held.push({ invoiceId: entry.invoiceId, caseId: entry.caseId, amountMinor: entry.amountMinor }),
  });
  const of = (doctorId: number, currency: Currency = "YER") => result.get(doctorId)?.[currency] ?? { accruedMinor: 0, earnedMinor: 0 };
  return { of, held };
}

describe("an approved split is complete and exact", () => {
  it("accepts shares that add up to 100% and names what is wrong otherwise", () => {
    expect(caseParticipationProblem([{ doctorId: A, shareBp: 6_000 }, { doctorId: B, shareBp: 4_000 }])).toBeNull();
    expect(caseParticipationProblem([{ doctorId: A, shareBp: 5_000 }, { doctorId: B, shareBp: 5_000 }])).toBeNull();
    expect(caseParticipationProblem([{ doctorId: A, shareBp: 10_000 }])).toBeNull();
    expect(caseParticipationProblem([])).toBe("no_participants");
    expect(caseParticipationProblem([{ doctorId: A, shareBp: 6_000 }, { doctorId: B, shareBp: 3_000 }])).toBe("shares_below_full");
    expect(caseParticipationProblem([{ doctorId: A, shareBp: 6_000 }, { doctorId: B, shareBp: 5_000 }])).toBe("shares_above_full");
    expect(caseParticipationProblem([{ doctorId: A, shareBp: 5_000 }, { doctorId: A, shareBp: 5_000 }])).toBe("duplicate_doctor");
    expect(caseParticipationProblem([{ doctorId: A, shareBp: 0 }, { doctorId: B, shareBp: 10_000 }])).toBe("invalid_share");
    expect(caseParticipationProblem([{ doctorId: A, shareBp: 33.3 }, { doctorId: B, shareBp: 9_966.7 }])).toBe("invalid_share");
    expect(caseParticipationProblem([{ doctorId: 0, shareBp: 10_000 }])).toBe("invalid_doctor");
  });
  it("splits whole units by weights with nothing lost or invented", () => {
    expect(allocateByWeights(100_000, [6_000, 4_000])).toEqual([60_000, 40_000]);
    expect(allocateByWeights(100, [3_333, 3_333, 3_334])).toEqual([33, 33, 34]);
    expect(allocateByWeights(1, [5_000, 5_000])).toEqual([1, 0]);
    expect(allocateByWeights(0, [5_000, 5_000])).toEqual([0, 0]);
    for (const total of [1, 7, 999, 100_001, 9_000_000_000_001]) {
      expect(allocateByWeights(total, [6_000, 3_999, 1]).reduce((sum, part) => sum + part, 0)).toBe(total);
    }
    expect(() => allocateByWeights(10, [0, 0])).toThrow();
    expect(() => allocateByWeights(-1, [1])).toThrow();
  });
  it("splits the line's amount and its costs by the same shares and refuses an incomplete split", () => {
    const parts = splitShareByParticipation(line(100_001, { labCostMinor: 20_001, materialCostMinor: 5 }), approved([[A, 6_000], [B, 4_000]]));
    expect(parts.map(part => [part.doctorId, part.amountMinor, part.labCostMinor, part.materialCostMinor])).toEqual([[A, 60_001, 12_001, 3], [B, 40_000, 8_000, 2]]);
    expect(() => splitShareByParticipation(line(100), approved([[A, 6_000], [B, 3_000]]))).toThrow();
    expect(() => splitShareByParticipation(line(100), { caseId: CASE, status: "pending", participants: [] })).toThrow();
  });
});

describe("option 2: each participant at his own rate on his part of the work", () => {
  it("the owner's scenario: base 100,000, A 40% with 60% of the work, B 30% with 40% — 24,000 and 12,000, not 40,000 twice", () => {
    const { of } = run([invoice([line(100_000)], 100_000)], [paid(1, 100_000)], policies({ [A]: plain(40), [B]: plain(30) }), approved([[A, 6_000], [B, 4_000]]));
    expect(of(A)).toEqual({ accruedMinor: 24_000, earnedMinor: 24_000 });
    expect(of(B)).toEqual({ accruedMinor: 12_000, earnedMinor: 12_000 });
  });
  it("does not depend on which doctor is recorded on the line", () => {
    const split = approved([[A, 6_000], [B, 4_000]]), policy = policies({ [A]: plain(40), [B]: plain(30) });
    const onA = run([invoice([line(100_000, { doctorId: A })], 100_000)], [paid(1, 100_000)], policy, split);
    const onB = run([invoice([line(100_000, { doctorId: B })], 100_000)], [paid(1, 100_000)], policy, split);
    expect([onA.of(A), onA.of(B)]).toEqual([onB.of(A), onB.of(B)]);
  });
  it("an equal split, and a single doctor holding 100%, behave as expected", () => {
    const equal = run([invoice([line(100_000)], 100_000)], [paid(1, 100_000)], policies({ [A]: plain(40), [B]: plain(40) }), approved([[A, 5_000], [B, 5_000]]));
    expect([equal.of(A).earnedMinor, equal.of(B).earnedMinor]).toEqual([20_000, 20_000]);
    const single = run([invoice([line(100_000)], 100_000)], [paid(1, 100_000)], policies({ [A]: plain(40) }), approved([[A, 10_000]]));
    const unshared = run([invoice([line(100_000)], 100_000)], [paid(1, 100_000)], policies({ [A]: plain(40) }));
    expect(single.of(A)).toEqual(unshared.of(A));
  });
  it("a case that is not shared, and a line of another case, are untouched", () => {
    const { of, held } = run([invoice([line(100_000, { caseId: 99 })], 100_000)], [paid(1, 100_000)], policies({ [A]: plain(40), [B]: plain(30) }), approved([[A, 6_000], [B, 4_000]]));
    expect(of(A)).toEqual({ accruedMinor: 40_000, earnedMinor: 40_000 });
    expect(of(B)).toEqual({ accruedMinor: 0, earnedMinor: 0 });
    expect(held).toEqual([]);
  });
});

describe("without an approved split the shared commission is held", () => {
  it("a pending case pays no one and reports what is held", () => {
    const { of, held } = run([invoice([line(100_000)], 100_000)], [paid(1, 100_000)], policies({ [A]: plain(40), [B]: plain(30) }),
      { caseId: CASE, status: "pending", participants: [] });
    expect([of(A), of(B)]).toEqual([{ accruedMinor: 0, earnedMinor: 0 }, { accruedMinor: 0, earnedMinor: 0 }]);
    expect(held).toEqual([{ invoiceId: 1, caseId: CASE, amountMinor: 100_000 }]);
  });
  it("shares below or above 100% are never paid, even if marked approved", () => {
    for (const parts of [[[A, 6_000], [B, 3_000]], [[A, 6_000], [B, 5_000]]] as [number, number][][]) {
      const { of, held } = run([invoice([line(100_000)], 100_000)], [paid(1, 100_000)], policies({ [A]: plain(40), [B]: plain(30) }), approved(parts));
      expect(of(A).earnedMinor + of(B).earnedMinor).toBe(0);
      expect(held).toHaveLength(1);
    }
  });
});

describe("discount, costs, collections and currencies", () => {
  it("the invoice discount comes first, then the split", () => {
    const [part] = allocateInvoiceDiscount([100_000], 20_000);
    const { of } = run([invoice([line(100_000 - part)], 80_000)], [paid(1, 80_000)], policies({ [A]: plain(40), [B]: plain(30) }), approved([[A, 6_000], [B, 4_000]]));
    expect([of(A).earnedMinor, of(B).earnedMinor]).toEqual([19_200, 9_600]); // 48,000 × 40%, 32,000 × 30%
  });
  it("laboratory and material costs are split by the same shares and deducted by each doctor's own policy", () => {
    const shares = [line(100_000, { labCostMinor: 20_000, materialCostMinor: 10_000 })];
    const { of } = run([invoice(shares, 100_000)], [paid(1, 100_000)],
      policies({ [A]: { percent: 40, config: config(40, true) }, [B]: { percent: 30, config: config(30, false) } }), approved([[A, 6_000], [B, 4_000]]));
    // A deducts his part of both costs: (60,000 − 12,000 − 6,000) × 40% = 16,800. B's policy deducts none: 40,000 × 30% = 12,000.
    expect([of(A).earnedMinor, of(B).earnedMinor]).toEqual([16_800, 12_000]);
  });
  it("a part collection earns each participant in proportion; a later collection completes it; a refund takes it back", () => {
    const invoices = [invoice([line(100_000)], 100_000)], policy = policies({ [A]: plain(40), [B]: plain(30) }), split = approved([[A, 6_000], [B, 4_000]]);
    const half = run(invoices, [paid(1, 50_000)], policy, split);
    expect([half.of(A).earnedMinor, half.of(B).earnedMinor]).toEqual([12_000, 6_000]);
    const full = run(invoices, [paid(1, 50_000), paid(1, 50_000, "2026-11-05T07:00:00.000Z")], policy, split);
    expect([full.of(A).earnedMinor, full.of(B).earnedMinor]).toEqual([24_000, 12_000]);
    // After a 25,000 refund the covering amount is 75,000.
    const refunded = run(invoices, [paid(1, 75_000)], policy, split);
    expect([refunded.of(A).earnedMinor, refunded.of(B).earnedMinor]).toEqual([18_000, 9_000]);
  });
  it("each currency is its own bucket and odd units never exceed the line", () => {
    const usd = invoice([line(10_001, {}, "USD")], 10_001, 2, "USD");
    const { of } = run([usd], [paid(2, 10_001)], policies({ [A]: plain(100), [B]: plain(100) }), approved([[A, 3_333], [B, 6_667]]));
    expect([of(A, "USD").earnedMinor, of(B, "USD").earnedMinor]).toEqual([3_333, 6_668]);
    expect(of(A, "USD").earnedMinor + of(B, "USD").earnedMinor).toBe(10_001);
    expect(of(A, "YER")).toEqual({ accruedMinor: 0, earnedMinor: 0 });
  });
  it("is deterministic: the same inputs give the same result on every recalculation", () => {
    const once = () => run([invoice([line(99_999)], 99_999)], [paid(1, 33_333)], policies({ [A]: plain(35), [B]: plain(45) }), approved([[A, 5_500], [B, 4_500]]));
    const first = once(), second = once();
    expect([first.of(A), first.of(B)]).toEqual([second.of(A), second.of(B)]);
  });
});
