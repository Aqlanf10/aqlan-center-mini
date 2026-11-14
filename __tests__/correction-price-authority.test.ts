/** A financial correction changes prices and the discount only by the price grants (G4-1), judged
 * on what actually changed against the stored values (review request 6801961109 on #483). */
import { describe, expect, it } from "vitest";
import { checkCorrectionPriceAuthority, correctionMoneyChanges, describeCorrectionPriceChanges, grantsUsedByCorrection, type CorrectionPriceInput, type CorrectionPriceLine } from "../lib/correction-price-authority";

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
  describe("manual lines without a catalogue service (rule 3)", () => {
    const manual = (requested: number, stored = 10_000, reference: CorrectionPriceLine["manualReference"] = { known: true, unitMinor: 10_000 }) =>
      [line(requested, stored, { service: null, manualReference: reference })];
    const DISCOUNT = { ...NONE, discount: true };
    it("lowering is a discount measured against the fixed reference", () => {
      expect(checkCorrectionPriceAuthority(input(manual(9_500)))).toMatchObject({ ok: false, message: expect.stringContaining("صلاحية تطبيق الخصم") });
      expect(checkCorrectionPriceAuthority(input(manual(9_500), { grants: { ...NONE, increase: true } }))).toMatchObject({ ok: false });
      expect(checkCorrectionPriceAuthority(input(manual(9_000), { grants: DISCOUNT })))
        .toMatchObject({ ok: true, manualLoweredLines: 1, overrides: [{ kind: "discount", catalogMinor: 10_000, requestedMinor: 9_000, discountPercent: 10 }] });
      expect(checkCorrectionPriceAuthority(input(manual(8_000), { grants: DISCOUNT }))).toMatchObject({ ok: false, message: expect.stringContaining("يتجاوز الحد") });
      expect(checkCorrectionPriceAuthority(input(manual(2_000), { grants: { ...NONE, discountOverride: true } }))).toMatchObject({ ok: true, manualLoweredLines: 1 });
    });
    it("successive reductions are measured against the same reference, so the limit cannot be passed in steps", () => {
      // Stored 9,500 after a first 5% reduction; the reference is still 10,000.
      expect(checkCorrectionPriceAuthority(input(manual(9_000, 9_500), { grants: DISCOUNT }))).toMatchObject({ ok: true, overrides: [{ discountPercent: 10 }] });
      // 9,000 -> 8,600 is 4.4% of the stored price but 14% of the reference.
      expect(checkCorrectionPriceAuthority(input(manual(8_600, 9_000), { grants: DISCOUNT }))).toMatchObject({ ok: false, message: expect.stringContaining("يتجاوز الحد") });
    });
    it("moving back toward the reference while still below it is still a discount; reaching it is free; keeping it is not decided", () => {
      expect(checkCorrectionPriceAuthority(input(manual(9_500, 9_000)))).toMatchObject({ ok: false, message: expect.stringContaining("صلاحية تطبيق الخصم") });
      expect(checkCorrectionPriceAuthority(input(manual(9_500, 9_000), { grants: DISCOUNT }))).toMatchObject({ ok: true, overrides: [{ discountPercent: 5 }] });
      expect(checkCorrectionPriceAuthority(input(manual(10_000, 9_000)))).toMatchObject({ ok: true, overrides: [], manualLoweredLines: 0 });
      expect(checkCorrectionPriceAuthority(input(manual(7_000, 7_000)))).toMatchObject({ ok: true, overrides: [] });
    });
    it("a lowered manual line and a changed invoice discount are measured together", () => {
      expect(checkCorrectionPriceAuthority(input(manual(9_200), { discountMinor: 400, discountReason: "SYN discount", grants: DISCOUNT })))
        .toMatchObject({ ok: false, message: expect.stringContaining("مجموع الخصم") });
    });
    it("raising above the reference, or a first price on a zero line, needs the increase grant", () => {
      const INCREASE = { ...NONE, increase: true };
      expect(checkCorrectionPriceAuthority(input(manual(10_500)))).toMatchObject({ ok: false, message: expect.stringContaining("صلاحية تطبيق زيادة السعر") });
      expect(checkCorrectionPriceAuthority(input(manual(10_500), { grants: { ...NONE, discount: true, discountOverride: true } }))).toMatchObject({ ok: false });
      const raised = checkCorrectionPriceAuthority(input(manual(10_500), { grants: INCREASE }));
      expect(raised).toMatchObject({ ok: true, manualLoweredLines: 1, overrides: [{ kind: "increase", catalogMinor: 10_000, requestedMinor: 10_500, reason: "SYN correction" }] });
      expect(grantsUsedByCorrection(raised, INCREASE)).toEqual(["increase"]);
      // After an earlier reduction the reference is still the first price: 9,000 -> 10,500 is an increase of the reference.
      expect(checkCorrectionPriceAuthority(input(manual(10_500, 9_000), { grants: DISCOUNT }))).toMatchObject({ ok: false, message: expect.stringContaining("صلاحية تطبيق زيادة السعر") });
      const zero = (grants: typeof NONE) => checkCorrectionPriceAuthority(input(manual(500, 0, { known: true, unitMinor: 0 }), { grants }));
      expect(zero(NONE)).toMatchObject({ ok: false, message: expect.stringContaining("صلاحية تطبيق زيادة السعر") });
      expect(zero(INCREASE)).toMatchObject({ ok: true, overrides: [{ kind: "increase", catalogMinor: 0, requestedMinor: 500 }] });
    });
    it("a currency change or an unprovable reference needs the full price authority: increase and discount override together", () => {
      const FULL = { discount: false, discountOverride: true, increase: true };
      const cases = (grants: typeof NONE) => [
        checkCorrectionPriceAuthority(input(manual(9_000), { grants, currencyChanged: true, currency: "SAR" })),
        checkCorrectionPriceAuthority(input(manual(10_000), { grants, currencyChanged: true, currency: "SAR" })),
        checkCorrectionPriceAuthority(input(manual(9_000, 10_000, { known: false }), { grants })),
        checkCorrectionPriceAuthority(input(manual(11_000, 10_000, { known: false }), { grants })),
        checkCorrectionPriceAuthority(input([line(9_000, 10_000, { service: null })], { grants })),
        checkCorrectionPriceAuthority(input([line(9_000, 10_000, { service: null, serviceChanged: true, manualReference: { known: true, unitMinor: 10_000 } })], { grants })),
      ];
      for (const grants of [NONE, { ...NONE, increase: true }, { discount: true, discountOverride: true, increase: false }]) {
        for (const decision of cases(grants)) expect(decision).toMatchObject({ ok: false, message: expect.stringContaining("سلطة السعر الكاملة") });
      }
      for (const decision of cases(FULL)) {
        expect(decision).toMatchObject({ ok: true, fullAuthorityLines: 1 });
        expect(grantsUsedByCorrection(decision, FULL).sort()).toEqual(["discountOverride", "increase"]);
      }
      // An unchanged manual line needs nothing, even with an unknown reference.
      expect(checkCorrectionPriceAuthority(input(manual(10_000, 10_000, { known: false })))).toMatchObject({ ok: true, fullAuthorityLines: 0 });
    });
  });
  it("the audit description lists previous price, new price, reference and reason for changed values only", () => {
    const described = describeCorrectionPriceChanges(input([line(12_000), line(10_000), line(9_000, 9_500, { service: null, manualReference: { known: true, unitMinor: 10_000 } })],
      { storedDiscountMinor: 0, discountMinor: 500, discountReason: "SYN discount" }));
    expect(described).toMatchObject({ reason: "SYN correction", currency: "YER", lines: [
      { previousUnitMinor: 10_000, newUnitMinor: 12_000, reference: { kind: "catalogue", unitMinor: 10_000 } },
      { previousUnitMinor: 9_500, newUnitMinor: 9_000, reference: { kind: "recorded", unitMinor: 10_000 } },
    ], discount: { previousMinor: 0, newMinor: 500, reason: "SYN discount" } });
    expect(described.lines).toHaveLength(2);
    expect(describeCorrectionPriceChanges(input([line(10_000, 10_000, { quantity: 2 })]))).toMatchObject({ lines: [], discount: null });
  });
  it("a currency change re-decides every line and the discount in the new currency", () => {
    const sar = { ...service, priceSarMinor: 4_000 };
    const refused = checkCorrectionPriceAuthority(input([line(3_000, 10_000, { service: sar })], { currencyChanged: true, currency: "SAR" }));
    expect(refused).toMatchObject({ ok: false });
    expect(checkCorrectionPriceAuthority(input([line(4_000, 10_000, { service: sar })], { currencyChanged: true, currency: "SAR" }))).toMatchObject({ ok: true, overrides: [] });
  });
});
