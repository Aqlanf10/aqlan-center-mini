/** A financial correction changes prices and the discount only by the price grants (G4-1), judged
 * on what actually changed against the stored values (review request 6801961109 on #483). */
import { describe, expect, it } from "vitest";
import { checkCorrectionPriceAuthority, correctionMoneyChanges, grantsUsedByCorrection, type CorrectionPriceInput, type CorrectionPriceLine } from "../lib/correction-price-authority";

const service = { priceMinor: 10_000, priceSarMinor: null, priceUsdMinor: null, priceConfigured: true };
const NONE = { discount: false, discountOverride: false, increase: false };
const line = (requested: number, stored: number | null = 10_000, extra: Partial<CorrectionPriceLine> = {}): CorrectionPriceLine =>
  ({ description: "SYN service", service, quantity: 1, storedUnitMinor: stored, requestedUnitMinor: requested, serviceChanged: false, ...extra });
const input = (lines: CorrectionPriceLine[], extra: Partial<CorrectionPriceInput> = {}): CorrectionPriceInput => ({
  lines, storedTotalMinor: 10_000, storedDiscountMinor: 0, totalMinor: lines.reduce((sum, item) => sum + item.quantity * item.requestedUnitMinor, 0),
  discountMinor: 0, discountReason: null, reason: "SYN correction", currencyChanged: false, currency: "YER", rates: {}, maxDiscountPercent: 10, grants: NONE, ...extra });

describe("what a correction changes", () => {
  it("an unchanged price and discount change nothing, whatever the quantity", () => {
    expect(correctionMoneyChanges(input([line(10_000, 10_000, { quantity: 3 })], { storedDiscountMinor: 500, discountMinor: 500, storedTotalMinor: 10_000, totalMinor: 30_000 })))
      .toEqual({ changedLines: [false], discountChanged: false });
  });
  it("a different price, service or currency changes the line; a new line has no stored price", () => {
    expect(correctionMoneyChanges(input([line(9_000), line(10_000, 10_000, { serviceChanged: true }), line(10_000, null)])).changedLines).toEqual([true, true, true]);
    expect(correctionMoneyChanges(input([line(10_000)], { currencyChanged: true })).changedLines).toEqual([true]);
  });
  it("the discount changes by amount, by a higher share of a smaller total, or by currency; removing it is no change to decide", () => {
    const stored = { storedTotalMinor: 20_000, storedDiscountMinor: 1_000 };
    expect(correctionMoneyChanges(input([line(10_000)], { ...stored, totalMinor: 20_000, discountMinor: 1_500 })).discountChanged).toBe(true);
    expect(correctionMoneyChanges(input([line(10_000)], { ...stored, totalMinor: 10_000, discountMinor: 1_000 })).discountChanged).toBe(true);
    expect(correctionMoneyChanges(input([line(10_000)], { ...stored, totalMinor: 20_000, discountMinor: 1_000, currencyChanged: true })).discountChanged).toBe(true);
    expect(correctionMoneyChanges(input([line(10_000)], { ...stored, totalMinor: 30_000, discountMinor: 1_000 })).discountChanged).toBe(false);
    expect(correctionMoneyChanges(input([line(10_000)], { ...stored, totalMinor: 20_000, discountMinor: 0 })).discountChanged).toBe(false);
  });
});

describe("the decision by grants", () => {
  it("a correction that keeps every amount needs no price grant, even when the kept price is far from the catalogue", () => {
    expect(checkCorrectionPriceAuthority(input([line(2_000, 2_000), line(50_000, 50_000, { quantity: 2 })], { storedDiscountMinor: 9_000, discountMinor: 9_000, storedTotalMinor: 52_000 })))
      .toMatchObject({ ok: true, overrides: [], discount: null });
  });
  it("a price above the catalogue needs the increase grant", () => {
    expect(checkCorrectionPriceAuthority(input([line(12_000)]))).toMatchObject({ ok: false, message: expect.stringContaining("صلاحية تطبيق زيادة السعر") });
    expect(checkCorrectionPriceAuthority(input([line(12_000)], { grants: { ...NONE, discount: true, discountOverride: true } }))).toMatchObject({ ok: false });
    const allowed = checkCorrectionPriceAuthority(input([line(12_000)], { grants: { ...NONE, increase: true } }));
    expect(allowed).toMatchObject({ ok: true, overrides: [{ kind: "increase", catalogMinor: 10_000, requestedMinor: 12_000, reason: "SYN correction" }] });
    expect(grantsUsedByCorrection(allowed, { ...NONE, increase: true })).toEqual(["increase"]);
  });
  it("a price below the catalogue needs the discount grant within the limit and the override grant beyond it", () => {
    expect(checkCorrectionPriceAuthority(input([line(9_500)]))).toMatchObject({ ok: false, message: expect.stringContaining("صلاحية تطبيق الخصم") });
    expect(checkCorrectionPriceAuthority(input([line(9_500)], { grants: { ...NONE, increase: true } }))).toMatchObject({ ok: false });
    expect(checkCorrectionPriceAuthority(input([line(9_000)], { grants: { ...NONE, discount: true } }))).toMatchObject({ ok: true, overrides: [{ kind: "discount", discountPercent: 10 }] });
    expect(checkCorrectionPriceAuthority(input([line(8_900)], { grants: { ...NONE, discount: true } }))).toMatchObject({ ok: false, message: expect.stringContaining("يتجاوز الحد") });
    const beyond = checkCorrectionPriceAuthority(input([line(5_000)], { grants: { ...NONE, discountOverride: true } }));
    expect(beyond).toMatchObject({ ok: true, overrides: [{ kind: "discount", discountPercent: 50 }] });
    expect(grantsUsedByCorrection(beyond, { ...NONE, discountOverride: true })).toEqual(["discountOverride"]);
  });
  it("returning a changed price to the catalogue price is free", () => {
    expect(checkCorrectionPriceAuthority(input([line(10_000, 7_000)]))).toMatchObject({ ok: true, overrides: [] });
  });
  it("a changed invoice discount needs its reason and the discount grant, within the limit unless overridden", () => {
    const lines = [line(10_000)];
    expect(checkCorrectionPriceAuthority(input(lines, { discountMinor: 500, discountReason: "SYN discount" }))).toMatchObject({ ok: false, message: expect.stringContaining("صلاحية تطبيق الخصم") });
    expect(checkCorrectionPriceAuthority(input(lines, { discountMinor: 500, discountReason: null, grants: { ...NONE, discount: true } }))).toMatchObject({ ok: false, message: expect.stringContaining("سبب الخصم") });
    expect(checkCorrectionPriceAuthority(input(lines, { discountMinor: 1_000, discountReason: "SYN discount", grants: { ...NONE, discount: true } }))).toMatchObject({ ok: true, discount: { percent: 10 } });
    expect(checkCorrectionPriceAuthority(input(lines, { discountMinor: 1_100, discountReason: "SYN discount", grants: { ...NONE, discount: true } }))).toMatchObject({ ok: false });
    expect(checkCorrectionPriceAuthority(input(lines, { discountMinor: 6_000, discountReason: "SYN discount", grants: { ...NONE, discountOverride: true } }))).toMatchObject({ ok: true, discount: { percent: 60 } });
  });
  it("a changed line discount and a changed invoice discount are measured together against the limit", () => {
    const decision = checkCorrectionPriceAuthority(input([line(9_200)], { discountMinor: 400, discountReason: "SYN discount", grants: { ...NONE, discount: true } }));
    expect(decision).toMatchObject({ ok: false, message: expect.stringContaining("مجموع الخصم") });
  });
  it("removing the discount, changing a quantity or dropping a line needs no price grant", () => {
    expect(checkCorrectionPriceAuthority(input([line(10_000, 10_000, { quantity: 2 })], { storedTotalMinor: 30_000, storedDiscountMinor: 3_000, discountMinor: 0 })))
      .toMatchObject({ ok: true, overrides: [], discount: null });
  });
  it("a manual line without a catalogue service has no reference and stays free, as on a new invoice", () => {
    expect(checkCorrectionPriceAuthority(input([line(99_000, 10_000, { service: null })]))).toMatchObject({ ok: true, overrides: [] });
  });
  it("a currency change re-decides every line and the discount in the new currency", () => {
    const sar = { ...service, priceSarMinor: 4_000 };
    const refused = checkCorrectionPriceAuthority(input([line(3_000, 10_000, { service: sar })], { currencyChanged: true, currency: "SAR" }));
    expect(refused).toMatchObject({ ok: false });
    expect(checkCorrectionPriceAuthority(input([line(4_000, 10_000, { service: sar })], { currencyChanged: true, currency: "SAR" }))).toMatchObject({ ok: true, overrides: [] });
  });
});
