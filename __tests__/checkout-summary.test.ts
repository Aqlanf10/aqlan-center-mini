import { describe, expect, it } from "vitest";
import { buildCheckoutSummary, walkoutLineClass } from "../lib/checkout-summary";

/** (P0-G) الشبّاك: تصنيف السطر من الخادم، والملخص بكل عملة على حدة. */
describe("(P0-G) walkoutLineClass", () => {
  it("invoiced → NEW_BILLABLE, included → INCLUDED, otherwise NO_CHARGE", () => {
    expect(walkoutLineClass({ invoiced: true, included: false })).toBe("NEW_BILLABLE");
    expect(walkoutLineClass({ invoiced: false, included: true })).toBe("INCLUDED");
    expect(walkoutLineClass({ invoiced: false, included: false })).toBe("NO_CHARGE");
  });
});

describe("(P0-G) buildCheckoutSummary", () => {
  it("legacy patient: old 320,000 + filling 15,000 → current 335,000, due now = 15,000 + suggested 30,000", () => {
    const [line] = buildCheckoutSummary({
      previous: { YER: 320_000 }, current: { YER: 335_000 },
      invoice: { currency: "YER", netMinor: 15_000, paidMinor: 0 },
      paymentsToday: [], legacy: [{ currency: "YER", suggestedMinor: 30_000, remainingMinor: 320_000 }],
    });
    expect(line).toMatchObject({
      currency: "YER", previousBalanceMinor: 320_000, newBillableMinor: 15_000, currentBalanceMinor: 335_000,
      todayRemainingMinor: 15_000, legacySuggestedMinor: 30_000, dueNowMinor: 45_000,
    });
  });

  it("keeps currencies apart and never asks more than the current balance", () => {
    const lines = buildCheckoutSummary({
      previous: { YER: 0, SAR: 100 }, current: { YER: 5_000, SAR: 100 },
      invoice: { currency: "YER", netMinor: 10_000, paidMinor: 5_000 },
      paymentsToday: [{ currency: "YER", netMinor: 5_000 }],
      legacy: [{ currency: "SAR", suggestedMinor: 500, remainingMinor: 100 }],
    });
    expect(lines.map((one) => [one.currency, one.dueNowMinor, one.legacySuggestedMinor])).toEqual([["YER", 5_000, 0], ["SAR", 100, 100]]);
  });

  it("an included visit with nothing owed shows nothing", () => {
    expect(buildCheckoutSummary({ previous: {}, current: {}, invoice: null, paymentsToday: [], legacy: [] })).toEqual([]);
  });
});
