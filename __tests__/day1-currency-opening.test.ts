import { describe, expect, it } from "vitest";
import { catalogPriceIn, catalogPricesByCurrency, foreignRatesFromSettings } from "../lib/service-pricing";
import { openingBalanceAccess, parseOpeningInput } from "../lib/opening-access";
import { readForeignPrices } from "../lib/service-foreign-prices";
import { SETTING_DEFAULTS, validateSetting, type SettingsMap } from "../lib/settings";

/** (DAY1 — ملاحظات أول يوم تشغيل) سعر الخدمة بعملة الزيارة، وصلاحية الرصيد السابق. */

const service = { priceMinor: 30000, priceSarMinor: null, priceUsdMinor: null };
const rates = { SAR: 140, USD: 530 };

describe("service price in the visit currency (owner: per-currency prices, else converted)", () => {
  it("uses the owner's own SAR/USD price when set", () => {
    const own = { ...service, priceSarMinor: 25000, priceUsdMinor: 5000 };
    expect(catalogPriceIn(own, "SAR", rates)).toEqual({ minor: 25000, source: "catalog" });
    expect(catalogPriceIn(own, "USD", rates)).toEqual({ minor: 5000, source: "catalog" });
    expect(catalogPriceIn(own, "YER", rates)).toEqual({ minor: 30000, source: "catalog" });
  });

  it("converts the YER price at the saved rate to whole riyals/dollars when no own price", () => {
    // 30,000 ÷ 140 = 214.29 → 214 ريالًا سعوديًا؛ ÷ 530 = 56.6 → 57 دولارًا.
    expect(catalogPriceIn(service, "SAR", rates)).toEqual({ minor: 21400, source: "converted" });
    expect(catalogPriceIn(service, "USD", rates)).toEqual({ minor: 5700, source: "converted" });
  });

  it("has no price without an own price or a valid rate", () => {
    expect(catalogPriceIn(service, "SAR", {})).toEqual({ minor: null, source: "none" });
    expect(catalogPriceIn(service, "USD", { USD: 0 })).toEqual({ minor: null, source: "none" });
  });

  it("reads the rates from settings and prices every currency", () => {
    const settings = { ...SETTING_DEFAULTS, "finance.rate.SAR": "150", "finance.rate.USD": "bad" } as SettingsMap;
    expect(foreignRatesFromSettings(settings)).toEqual({ SAR: 150, USD: null });
    expect(catalogPricesByCurrency(service, foreignRatesFromSettings(settings))).toEqual({
      YER: { minor: 30000, source: "catalog" },
      SAR: { minor: 20000, source: "converted" },
      USD: { minor: null, source: "none" },
    });
  });

  it("parses the catalog's SAR/USD fields: absent keeps, empty clears, bad amount refused in Arabic", () => {
    expect(readForeignPrices({})).toEqual({ ok: true, patch: {} });
    expect(readForeignPrices({ priceSar: "250", priceUsd: "" })).toEqual({ ok: true, patch: { priceSarMinor: 25000, priceUsdMinor: null } });
    expect(readForeignPrices({ priceUsd: "abc" })).toMatchObject({ ok: false, message: expect.stringContaining("بالدولار") });
  });
});

describe("previous balance (owner: reception adds, admin edits)", () => {
  it("admin adds and edits; reception only adds while the setting is on; others nothing", () => {
    expect(openingBalanceAccess("admin", false)).toEqual({ add: true, edit: true });
    expect(openingBalanceAccess("reception", true)).toEqual({ add: true, edit: false });
    expect(openingBalanceAccess("reception", false)).toEqual({ add: false, edit: false });
    for (const role of ["doctor", "cashier", "accountant", null]) {
      expect(openingBalanceAccess(role, true)).toEqual({ add: false, edit: false });
    }
  });

  it("parses amount, currency, date and note with Arabic errors", () => {
    expect(parseOpeningInput({ amount: "150", currency: "SAR", note: " تقويم 2024 " }, "2026-09-26"))
      .toEqual({ ok: true, value: { currency: "SAR", amountMinor: 15000, asOfDate: "2026-09-26", note: "تقويم 2024" } });
    expect(parseOpeningInput({ amount: "50000" }, "2026-09-26")).toMatchObject({ ok: true, value: { currency: "YER", amountMinor: 50000 } });
    expect(parseOpeningInput({ amount: "0" }, "2026-09-26")).toMatchObject({ ok: false });
    expect(parseOpeningInput({ amount: "10", currency: "EUR" }, "2026-09-26")).toMatchObject({ ok: false, message: expect.stringContaining("عملة") });
    expect(parseOpeningInput({ amount: "10", asOfDate: "2026-10-01" }, "2026-09-26")).toMatchObject({ ok: false, message: expect.stringContaining("المستقبل") });
  });

  it("the reception switch defaults on and accepts only true/false", () => {
    expect(SETTING_DEFAULTS["finance.reception_adds_opening_balance"]).toBe("true");
    expect(validateSetting("finance.reception_adds_opening_balance", "false")).toBeNull();
    expect(validateSetting("finance.reception_adds_opening_balance", "yes")).not.toBeNull();
  });
});
