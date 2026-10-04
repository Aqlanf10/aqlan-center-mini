import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { LabOrderPricingConflict, resolveAutomaticLabPrice } from "../lib/lab-order-pricing";
import { withDefaults, type SettingsMap } from "../lib/settings";
import { getSettingsInTransaction, type DbClient } from "../lib/db";

const settings = (values: Record<string, string> = {}): SettingsMap => ({
  ...withDefaults({}), "finance.rate.USD": "531.125", "finance.rate.SAR": "141.25", ...values,
});
const input = { costMinor: "2500", costCurrency: "USD", quantity: 3,
  baseCurrency: "YER" as const, settings: settings() };

describe("automatic lab price snapshot", () => {
  it.each([
    ["USD", 531.125, 39834], ["SAR", 141.25, 10594], ["YER", 1, 7500],
  ])("resolves %s using canonical minor units, configured rate and quantity", (currency, rate, base) => {
    expect(resolveAutomaticLabPrice({ ...input, costCurrency: currency })).toEqual({
      costMinor: 7500, costCurrency: currency, exchangeRate: rate, baseAmountMinor: base,
    });
  });
  it("allows a legitimate zero rule only with valid currency/FX", () => {
    expect(resolveAutomaticLabPrice({ ...input, costMinor: 0 })).toMatchObject({ costMinor: 0, baseAmountMinor: 0 });
    expect(() => resolveAutomaticLabPrice({ ...input, costMinor: 0,
      settings: settings({ "finance.rate.USD": "" }) })).toThrow(LabOrderPricingConflict);
  });
  it.each(["", " ", "0", "-1", "NaN", "Infinity", "invalid", "0.0000001", "1.0000004", "1000001"])(
    "fails closed on unusable/storageless configured FX %j", raw => {
      expect(() => resolveAutomaticLabPrice({ ...input, settings: settings({ "finance.rate.USD": raw }) }))
        .toThrow(expect.objectContaining({ code: "lab_order_exchange_rate_invalid" }));
    });
  it.each([undefined, null])("does not invent absent FX from %s", raw => {
    const missing = { ...settings(), "finance.rate.USD": raw } as unknown as SettingsMap;
    expect(() => resolveAutomaticLabPrice({ ...input, settings: missing })).toThrow(LabOrderPricingConflict);
  });
  it.each(["EUR", "", null, undefined])("rejects unknown automatic currency %j", costCurrency => {
    expect(() => resolveAutomaticLabPrice({ ...input, costCurrency }))
      .toThrow(expect.objectContaining({ code: "lab_order_automatic_price_invalid" }));
  });
  it.each(["SAR", "USD"] as const)("does not invent automatic cross-FX into %s", baseCurrency => {
    expect(() => resolveAutomaticLabPrice({ ...input, baseCurrency })).toThrow(LabOrderPricingConflict);
  });
  it.each([-1, 0.5, NaN, Infinity, "", " ", "-1", "0.5", "9007199254740993", null, undefined])(
    "rejects unsafe raw rule minor units %j", costMinor => {
      expect(() => resolveAutomaticLabPrice({ ...input, costMinor })).toThrow(LabOrderPricingConflict);
    });
  it.each([0, -1, 1.5, Infinity])("rejects invalid quantity %s", quantity => {
    expect(() => resolveAutomaticLabPrice({ ...input, quantity })).toThrow(LabOrderPricingConflict);
  });
  it("rejects quantity overflow and converted base overflow", () => {
    expect(() => resolveAutomaticLabPrice({ ...input, costMinor: Number.MAX_SAFE_INTEGER, quantity: 2 }))
      .toThrow(LabOrderPricingConflict);
    expect(() => resolveAutomaticLabPrice({ ...input, costMinor: Number.MAX_SAFE_INTEGER, quantity: 1 }))
      .toThrow(LabOrderPricingConflict);
  });
  it("retains representable six-decimal rates without normalizing them", () => {
    expect(resolveAutomaticLabPrice({ ...input, settings: settings({ "finance.rate.USD": "531.123456" }) }))
      .toMatchObject({ exchangeRate: 531.123456, baseAmountMinor: 39834 });
  });
});

describe("transaction settings opt-in is one raw snapshot with default compatibility", () => {
  const clientFor = (rows: { key: string; value: unknown }[]) => {
    const query = vi.fn().mockResolvedValue({ rows });
    return { query, release: vi.fn() } as unknown as DbClient & { query: typeof query };
  };
  it.each([undefined, null, "", " ", "bad", "0", "-1"])("keeps unusable stored FX %j visible only in strict mode", async value => {
    const rows = value === undefined ? [] : [{ key: "finance.rate.USD", value }];
    const client = clientFor(rows);
    const ordinary = await getSettingsInTransaction(client);
    expect(ordinary).toEqual(withDefaults(Object.fromEntries(rows.map(row => [row.key, row.value])) as Record<string, string>));
    const strict = await getSettingsInTransaction(client, { requireStoredExchangeRates: true });
    expect(strict["finance.rate.USD"]).toBe(value ?? "");
    expect(strict["finance.rate.SAR"]).toBe("");
    expect(strict["clinic.name"]).toBe(ordinary["clinic.name"]);
    expect(() => resolveAutomaticLabPrice({ ...input, settings: strict })).toThrow(LabOrderPricingConflict);
    expect(client.query.mock.calls).toEqual([["SELECT key, value FROM settings"], ["SELECT key, value FROM settings"]]);
    expect(client.release).not.toHaveBeenCalled();
  });
  it("keeps stored FX exactly and does not mutate/cache returned snapshots", async () => {
    const client = clientFor([{ key: "finance.rate.SAR", value: "143.125" }, { key: "finance.rate.USD", value: "537.5" }]);
    const strict = await getSettingsInTransaction(client, { requireStoredExchangeRates: true });
    strict["finance.rate.SAR"] = "0";
    expect((await getSettingsInTransaction(client))["finance.rate.SAR"]).toBe("143.125");
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});

describe("canonical creator source contract (supplemental to owned PostgreSQL)", () => {
  const source = readFileSync("lib/db.ts", "utf8");
  const create = source.slice(source.indexOf("export async function createLabOrder(input:"), source.indexOf("export async function updateLabOrderAccounting("));
  it("only opts in after a rule was selected, preserving needed/manual/no-rule paths", () => {
    expect(create).toContain('resolvedCost == null && resolvedPartyId && input.labServiceId && input.status !== "needed"');
    expect(create.indexOf("getSettingsInTransaction(client, { requireStoredExchangeRates: true })"))
      .toBeGreaterThan(create.indexOf("if (priceRes.rows[0])"));
    expect(create).toContain("let resolvedExchangeRate = input.exchangeRate");
    expect(create).toContain("baseAmount, resolvedExchangeRate,");
    expect(create).toContain("resolvedCost, resolvedCurrency, resolvedExchangeRate, baseAmount,");
    expect(create).toContain('await client.query("ROLLBACK").catch(() => {})');
  });
});
