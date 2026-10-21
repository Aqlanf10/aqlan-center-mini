import { describe, expect, it } from "vitest";
import { allocateFifoByCurrency, commissionForPatient, type CommissionInvoice } from "../lib/commission";

const at = "2026-10-02T07:00:00.000000Z";
const invoices: CommissionInvoice[] = [
  { id: 11, netMinor: 10000, currency: "YER", createdAt: at,
    doctorShares: [{ doctorId: 21, amountMinor: 10000, currency: "YER" }] },
  { id: 12, netMinor: 10000, currency: "YER", createdAt: at,
    doctorShares: [{ doctorId: 22, amountMinor: 10000, currency: "YER" }] },
];

describe("commission FIFO at equal invoice timestamps", () => {
  it("keeps partial collection with the first issued invoice regardless of input order", () => {
    const collected = { YER: 4000, SAR: 0, USD: 0 };
    const expected = new Map([[11, 4000], [12, 0]]);
    expect(allocateFifoByCurrency(invoices, collected)).toEqual(expected);
    expect(allocateFifoByCurrency([...invoices].reverse(), collected)).toEqual(expected);
    const policies = new Map([[21, 30], [22, 40]]);
    for (const order of [invoices, [...invoices].reverse()]) {
      const result = commissionForPatient(order, collected, policies);
      expect(result.get(21)?.YER.earnedMinor).toBe(1200);
      expect(result.get(22)?.YER.earnedMinor).toBe(0);
    }
  });

  it("preserves timestamp precedence over ID and keeps currencies separate", () => {
    const other: CommissionInvoice = { ...invoices[1], id: 9, createdAt: "2026-10-03T00:00:00Z" };
    const usd: CommissionInvoice = { ...invoices[0], id: 8, currency: "USD",
      doctorShares: [{ doctorId: 21, amountMinor: 10000, currency: "USD" }] };
    expect(allocateFifoByCurrency([other, usd, invoices[0]], { YER: 4000, SAR: 0, USD: 2000 }))
      .toEqual(new Map([[11, 4000], [9, 0], [8, 2000]]));
  });
});
