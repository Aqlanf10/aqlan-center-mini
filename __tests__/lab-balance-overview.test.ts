import { describe, expect, it } from "vitest";
import { LAB_BALANCE_VIEW, projectLabBalanceOverview, readLabBalanceOverview, sumLabNetBalances } from "../lib/lab-balance-overview";

const observedAt = "2026-10-03T12:00:00.000Z";
const party = (id = 1) => ({ id, kind: "lab", name: `Lab ${id}`, currency: "YER", phone: null, isActive: false, note: "private omitted" });
const due = (partyId = 1, currency = "USD", dueMinor = -525) => ({ partyId, kind: "lab", name: "canonical name", currency, dueMinor, transactions: ["never serialize"] });
const overview = () => projectLabBalanceOverview([party(), party(2)], [due(), due(1, "SAR", 2000), due(2, "USD", 525)], observedAt);

describe("canonical lab balance projection, without a second ledger formula", () => {
  it("preserves lab signed buckets, original currencies, inactive labs and minimal identity only", () => {
    const result = projectLabBalanceOverview([party(), party(2)], [due(), due(1, "SAR", 2000), { ...due(9), kind: "supplier" }], observedAt);
    expect(result).toEqual({ version: LAB_BALANCE_VIEW, observedAt, labs: [
      { partyId: 1, partyName: "Lab 1", preferredCurrency: "YER", phone: null, partyNetBalance: {
        state: "ready", scope: "whole_party", byCurrency: [{ currency: "SAR", netMinor: 2000 }, { currency: "USD", netMinor: -525 }],
      } },
      { partyId: 2, partyName: "Lab 2", preferredCurrency: "YER", phone: null, partyNetBalance: { state: "ready", scope: "whole_party", byCurrency: [] } },
    ] });
    expect(JSON.stringify(result)).not.toMatch(/private omitted|transactions|unsettledCostMinor|isActive/);
  });
  it("adds only same-currency buckets and retains zero-net cancellation without erasing signed party rows", () => {
    const result = overview();
    expect(sumLabNetBalances(result.labs)).toEqual([{ currency: "SAR", netMinor: 2000 }, { currency: "USD", netMinor: 0 }]);
    expect(result.labs[0].partyNetBalance.byCurrency).toContainEqual({ currency: "USD", netMinor: -525 });
    expect(result.labs[1].partyNetBalance.byCurrency).toContainEqual({ currency: "USD", netMinor: 525 });
  });
  it("allows a complete empty catalog and successful empty balance lists, not absent data", () => {
    expect(projectLabBalanceOverview([], [], observedAt).labs).toEqual([]);
    expect(sumLabNetBalances(projectLabBalanceOverview([party()], [], observedAt).labs)).toEqual([]);
    expect(() => projectLabBalanceOverview([party()], undefined, observedAt)).toThrow();
    expect(() => projectLabBalanceOverview(undefined, [], observedAt)).toThrow();
  });
  it.each([NaN, Infinity, -Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1, "525", null, undefined])("rejects unsafe canonical minor %j", (value) => {
    expect(() => projectLabBalanceOverview([party()], [{ ...due(), dueMinor: value }], observedAt)).toThrow();
  });
  it.each([
    [due(8)], [due(), due()], [{ ...due(), currency: "EUR" }], [{ ...due(), partyId: 0 }],
    [{ ...due(), partyId: "1" }], [{ ...due(), kind: null }],
  ])("fails closed on malformed or unjoined canonical lab data %j", (...rows) => {
    expect(() => projectLabBalanceOverview([party()], rows, observedAt)).toThrow();
  });
  it("rejects duplicate catalog identities and unsafe same-currency totals", () => {
    expect(() => projectLabBalanceOverview([party(), party()], [], observedAt)).toThrow();
    expect(() => projectLabBalanceOverview([party(), party(2)], [due(1, "USD", Number.MAX_SAFE_INTEGER), due(2, "USD", 1)], observedAt)).toThrow();
  });
});

describe("financial response admission", () => {
  it.each([null, {}, { labs: [] }, { version: LAB_BALANCE_VIEW, observedAt, labs: null }])("does not decode missing/malformed responses as zero: %j", (value) => {
    expect(() => readLabBalanceOverview(value)).toThrow();
  });
  it("validates every row, bucket state, currency, minor value and duplicate before returning ready", () => {
    const result = overview();
    const invalid = [
      { ...result, version: "old" }, { ...result, observedAt: "not a date" },
      { ...result, labs: [result.labs[0], result.labs[0]] },
      ...[undefined, { state: "unavailable" }, { state: "ready", scope: "first_page", byCurrency: [] },
        { state: "ready", scope: "whole_party", byCurrency: [{ currency: "USD", netMinor: null }] },
        { state: "ready", scope: "whole_party", byCurrency: [{ currency: "USD", netMinor: 1 }, { currency: "USD", netMinor: 2 }] },
      ].map((partyNetBalance) => ({ ...result, labs: [{ ...result.labs[0], partyNetBalance }] })),
    ];
    for (const value of invalid) expect(() => readLabBalanceOverview(value)).toThrow();
    expect(readLabBalanceOverview(result)).toEqual(result);
  });
});
