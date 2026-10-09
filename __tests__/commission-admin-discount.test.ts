import { describe, expect, it } from "vitest";
import { commissionForPatientAtEventTime, type CommissionInvoice, type CoverageChunk } from "../lib/commission";
import { allocateAdminDiscount, fifoCoverageOfInvoice } from "../lib/invoice-discount";

/**
 * (FIN-DISC, owner decision: option 2) Commission on the service value after an admin discount, at the decision time.
 * Synthetic numbers only (minor units).
 */
const T0 = "2026-09-01T08:00:00.000Z"; // invoice
const T1 = "2026-09-02T08:00:00.000Z"; // first collection
const T2 = "2026-09-03T08:00:00.000Z"; // admin discount
const T3 = "2026-09-04T08:00:00.000Z"; // later collection
const policy = (percent: number) => () => ({ percent, config: null });
const policies = (byDoctor: Record<number, number>) => (doctorId: number) => ({ percent: byDoctor[doctorId], config: null });
const run = (invoice: CommissionInvoice, chunks: CoverageChunk[], at = policy(50) as Parameters<typeof commissionForPatientAtEventTime>[2]) =>
  commissionForPatientAtEventTime([invoice], chunks, at);
const one = (result: ReturnType<typeof run>, doctorId = 1) => result.get(doctorId)?.YER ?? { accruedMinor: 0, earnedMinor: 0 };

describe("exact per-line allocation", () => {
  it("splits proportionally to each line's remaining value, sums exactly, and never exceeds a line", () => {
    expect(allocateAdminDiscount([{ id: 1, totalMinor: 60000, allocatedMinor: 0 }, { id: 2, totalMinor: 40000, allocatedMinor: 0 }], 10000))
      .toEqual(new Map([[1, 6000], [2, 4000]]));
    const odd = allocateAdminDiscount([{ id: 1, totalMinor: 1, allocatedMinor: 0 }, { id: 2, totalMinor: 1, allocatedMinor: 0 },
      { id: 3, totalMinor: 1, allocatedMinor: 0 }], 2)!;
    expect([...odd.values()].reduce((a, b) => a + b, 0)).toBe(2);
    expect([...odd.values()].every((part) => part <= 1)).toBe(true);
    // Earlier allocations reduce a line's share of the next decision.
    expect(allocateAdminDiscount([{ id: 1, totalMinor: 60000, allocatedMinor: 50000 }, { id: 2, totalMinor: 40000, allocatedMinor: 0 }], 5000))
      .toEqual(new Map([[1, 1000], [2, 4000]]));
    expect(allocateAdminDiscount([{ id: 1, totalMinor: 100, allocatedMinor: 0 }], 101)).toBeNull();
    expect(allocateAdminDiscount([{ id: 1, totalMinor: 100, allocatedMinor: 0 }], 0)).toBeNull();
  });
});

describe("commission FIFO coverage of one invoice", () => {
  it("fills the opening first, then invoices oldest first, regardless of the receipt's named invoice", () => {
    const invoices = [{ id: 2, netMinor: 50000, createdAt: T1 }, { id: 1, netMinor: 100000, createdAt: T0 }];
    expect(fifoCoverageOfInvoice({ openingMinor: 20000, invoices, collectedMinor: 70000 }, 1)).toBe(50000);
    expect(fifoCoverageOfInvoice({ openingMinor: 20000, invoices, collectedMinor: 70000 }, 2)).toBe(0);
    expect(fifoCoverageOfInvoice({ openingMinor: 0, invoices, collectedMinor: 130000 }, 2)).toBe(30000);
  });
});

describe("event-time commission after an admin discount", () => {
  const base = (over: Partial<CommissionInvoice> = {}): CommissionInvoice => ({
    id: 1, netMinor: 100000, currency: "YER", createdAt: T0,
    doctorShares: [{ doctorId: 1, amountMinor: 100000, currency: "YER" }], ...over,
  });
  const discounted = (amount: number, net: number, extra: Partial<CommissionInvoice["doctorShares"][number]> = {}) => base({
    netMinor: net, adminDiscounts: [{ atIso: T2, amountMinor: amount }],
    doctorShares: [{ doctorId: 1, amountMinor: 100000, currency: "YER", adminDiscounts: [{ atIso: T2, amountMinor: amount }], ...extra }],
  });

  it("review example: 100,000 at 50%, 30,000 collected — earned stays 15,000 after a 20,000 discount; accrued falls to 40,000", () => {
    expect(one(run(base(), [{ invoiceId: 1, amount: 30000, sourceTime: T1 }]))).toEqual({ accruedMinor: 50000, earnedMinor: 15000 });
    expect(one(run(discounted(20000, 80000), [{ invoiceId: 1, amount: 30000, sourceTime: T1 }])))
      .toEqual({ accruedMinor: 40000, earnedMinor: 15000 });
  });

  it("a discount alone is not a collection, and full later collection ends exactly at the reduced accrual", () => {
    expect(one(run(discounted(20000, 80000), []))).toEqual({ accruedMinor: 40000, earnedMinor: 0 });
    expect(one(run(discounted(20000, 80000), [
      { invoiceId: 1, amount: 30000, sourceTime: T1 }, { invoiceId: 1, amount: 50000, sourceTime: T3 },
    ]))).toEqual({ accruedMinor: 40000, earnedMinor: 40000 });
  });

  it("with lab cost, what was earned before the discount is kept (no clawback) and nothing more is earned beyond the new base", () => {
    const result = one(run(discounted(70000, 30000, { labCostMinor: 20000 }), [
      { invoiceId: 1, amount: 30000, sourceTime: T1 },
    ]));
    // Before: base 80,000 × 50% × 30% collected = 12,000. After: base 10,000 → accrued 5,000; the 12,000 is not restated.
    expect(result).toEqual({ accruedMinor: 5000, earnedMinor: 12000 });
  });

  it("two doctors with different rates: allocation by line value, each ends at their own reduced accrual when fully collected", () => {
    const invoice: CommissionInvoice = {
      id: 1, netMinor: 90000, currency: "YER", createdAt: T0, adminDiscounts: [{ atIso: T2, amountMinor: 10000 }],
      doctorShares: [
        { doctorId: 1, amountMinor: 60000, currency: "YER", adminDiscounts: [{ atIso: T2, amountMinor: 6000 }] },
        { doctorId: 2, amountMinor: 40000, currency: "YER", adminDiscounts: [{ atIso: T2, amountMinor: 4000 }] },
      ],
    };
    const result = commissionForPatientAtEventTime([invoice], [
      { invoiceId: 1, amount: 50000, sourceTime: T1 }, { invoiceId: 1, amount: 40000, sourceTime: T3 },
    ], policies({ 1: 50, 2: 30 }));
    expect(result.get(1)!.YER).toEqual({ accruedMinor: 27000, earnedMinor: 27000 });
    expect(result.get(2)!.YER).toEqual({ accruedMinor: 10800, earnedMinor: 10800 });
    // Collections before the discount earned exactly what they did before it.
    const before = commissionForPatientAtEventTime([{ ...invoice, netMinor: 100000, adminDiscounts: undefined,
      doctorShares: invoice.doctorShares.map((share) => ({ ...share, adminDiscounts: undefined })) }],
    [{ invoiceId: 1, amount: 50000, sourceTime: T1 }], policies({ 1: 50, 2: 30 }));
    const partial = commissionForPatientAtEventTime([invoice], [{ invoiceId: 1, amount: 50000, sourceTime: T1 }], policies({ 1: 50, 2: 30 }));
    expect(partial.get(1)!.YER.earnedMinor).toBe(before.get(1)!.YER.earnedMinor);
    expect(partial.get(2)!.YER.earnedMinor).toBe(before.get(2)!.YER.earnedMinor);
  });

  it("odd amounts: what was earned before a decision is identical to the minor unit (no rounding drift), so a paid amount stays covered", () => {
    for (const [gross, collected, cut] of [[100001, 33333, 7], [99999, 1, 33333], [70003, 70002, 1], [12345, 6789, 5555]]) {
      const plain = base({ netMinor: gross, doctorShares: [{ doctorId: 1, amountMinor: gross, currency: "YER" }] });
      const chunks = [{ invoiceId: 1, amount: collected, sourceTime: T1 }];
      const before = one(run(plain, chunks, policy(37)));
      const after = one(run(base({ netMinor: gross - cut, adminDiscounts: [{ atIso: T2, amountMinor: cut }],
        doctorShares: [{ doctorId: 1, amountMinor: gross, currency: "YER", adminDiscounts: [{ atIso: T2, amountMinor: cut }] }] }), chunks, policy(37)));
      expect(after.earnedMinor).toBe(before.earnedMinor);
    }
  });

  it("review 5464652001: full settlement after a decision never earns above the reduced accrual (odd minor units)", () => {
    // Line 3 at 50%, receipt 1 at T1, admin discount 1 at T2, receipt 1 at T3: settled 2 = new net; accrued round(2×50%) = 1.
    const tiny = base({ netMinor: 2, adminDiscounts: [{ atIso: T2, amountMinor: 1 }],
      doctorShares: [{ doctorId: 1, amountMinor: 3, currency: "YER", adminDiscounts: [{ atIso: T2, amountMinor: 1 }] }] });
    expect(one(run(tiny, [{ invoiceId: 1, amount: 1, sourceTime: T1 }, { invoiceId: 1, amount: 1, sourceTime: T3 }])))
      .toEqual({ accruedMinor: 1, earnedMinor: 1 });
    // The prefix alone is still exact: before the second receipt, the 1 earned on the first is kept.
    expect(one(run(tiny, [{ invoiceId: 1, amount: 1, sourceTime: T1 }]))).toEqual({ accruedMinor: 1, earnedMinor: 1 });
  });

  it("full settlement with odd amounts, several doctors and rates: each doctor ends exactly at their reduced accrual", () => {
    for (const [a, b, cut, first] of [[3, 3, 1, 1], [7, 5, 3, 2], [100001, 33333, 7777, 33333], [5, 1, 2, 1], [99, 2, 50, 30]]) {
      const allocation = new Map([[1, Math.floor((cut * a) / (a + b))], [2, cut - Math.floor((cut * a) / (a + b))]]);
      const invoice: CommissionInvoice = {
        id: 1, netMinor: a + b - cut, currency: "YER", createdAt: T0, adminDiscounts: [{ atIso: T2, amountMinor: cut }],
        doctorShares: [
          { doctorId: 1, amountMinor: a, currency: "YER", adminDiscounts: allocation.get(1) ? [{ atIso: T2, amountMinor: allocation.get(1)! }] : [] },
          { doctorId: 2, amountMinor: b, currency: "YER", adminDiscounts: allocation.get(2) ? [{ atIso: T2, amountMinor: allocation.get(2)! }] : [] },
        ],
      };
      const result = commissionForPatientAtEventTime([invoice], [
        { invoiceId: 1, amount: first, sourceTime: T1 }, { invoiceId: 1, amount: a + b - cut - first, sourceTime: T3 },
      ], policies({ 1: 50, 2: 33 }));
      for (const doctorId of [1, 2]) {
        const value = result.get(doctorId)?.YER ?? { accruedMinor: 0, earnedMinor: 0 };
        expect(value.earnedMinor, `case ${[a, b, cut, first]} doctor ${doctorId}`).toBe(value.accruedMinor);
      }
    }
  });

  it("zero net after a full discount with nothing collected: no commission", () => {
    expect(one(run(discounted(100000, 0), []))).toEqual({ accruedMinor: 0, earnedMinor: 0 });
  });

  it("invoices without admin discounts keep the unchanged formula", () => {
    const plain = base({ netMinor: 90000 }); // creation discount 10,000 stays on the gross share (unchanged behaviour)
    expect(one(run(plain, [{ invoiceId: 1, amount: 45000, sourceTime: T1 }]))).toEqual({ accruedMinor: 50000, earnedMinor: 25000 });
  });
});
