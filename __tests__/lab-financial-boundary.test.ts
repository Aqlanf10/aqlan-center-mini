import { describe, expect, it } from "vitest";
import { savedLabPayableSnapshot } from "../lib/lab-financial-boundary";
const snapshot = { cost_minor: "2500", cost_currency: "USD", exchange_rate: "531.125", base_amount_minor: "13001" };
describe("saved lab financial snapshot", () => {
  it("preserves actual currency, rate and historical base without revaluation", () => {
    expect(savedLabPayableSnapshot(snapshot)).toEqual({ costMinor: 2500, currency: "USD", exchangeRate: 531.125, baseAmountMinor: 13001 });
  });
  it.each([
    { cost_currency: null }, { cost_currency: "invalid" }, { exchange_rate: null }, { exchange_rate: "" },
    { exchange_rate: "0" }, { exchange_rate: "1.0000001" }, { base_amount_minor: null },
    { base_amount_minor: "-1" }, { cost_minor: "-1" }, { cost_minor: "0" }, { cost_currency: "YER", exchange_rate: "531" },
  ])("refuses missing or ambiguous money %j", invalid => {
    expect(() => savedLabPayableSnapshot({ ...snapshot, ...invalid })).toThrow("راجع عملة تكلفة المختبر");
  });
});
