import { describe, expect, it } from "vitest";
import { CurrencyIntentError, evaluateWrongCurrencyAmounts, parseCorrectionAmountExact, type CurrencyCorrectionSource, type WrongCurrencyIntent } from "../lib/invoice-currency-intent";
import { CURRENCIES, MINOR_UNITS, type Currency } from "../lib/money";

const directions = CURRENCIES.flatMap(from => CURRENCIES.filter(to => from !== to).map(to => [from, to] as const));
const source = (currency: Currency = "YER"): CurrencyCorrectionSource => ({ patientId: 1, invoiceId: 10, sourceHash: "a".repeat(64), currency,
  lines: [{ itemId: 31, quantity: 2, unitPriceMinor: 1000 * MINOR_UNITS[currency] }, { itemId: 32, quantity: 1, unitPriceMinor: 250 * MINOR_UNITS[currency] }],
  totalMinor: 2250 * MINOR_UNITS[currency], discountMinor: 50 * MINOR_UNITS[currency] });
const intent = (fromCurrency: Currency = "YER", toCurrency: Currency = "SAR"): WrongCurrencyIntent => ({ version: 1, purpose: "wrong-currency", mode: "preserve-numerals", fromCurrency, toCurrency, reason: "Correct the originally agreed currency" });
const code = (fn: () => unknown, expected: string) => expect(fn).toThrowError(expect.objectContaining({ name: "CurrencyIntentError", code: expected }));

describe("exact decimal correction input, not an FX converter", () => {
  it.each([
    ["1000", "YER", 1000], ["1,000", "YER", 1000], ["١٬٠٠٠", "YER", 1000], ["۱۲۳٫۴۵", "SAR", 12345],
    ["٠٫٠١", "USD", 1], ["0", "USD", 0], ["12.0000", "YER", 12], ["12.34000", "SAR", 1234],
    [" 1,234.50 ", "USD", 123450], ["90071992547409.91", "SAR", Number.MAX_SAFE_INTEGER],
    ["9007199254740991", "YER", Number.MAX_SAFE_INTEGER],
  ] as const)("parses %s %s exactly", (input, currency, expected) => expect(parseCorrectionAmountExact(input, currency)).toBe(expected));
  it.each(["", ".", ".5", "12.", "-0", "-1", "+1", "1e3", "NaN", "Infinity", "1,23", "12,34,567", "1 000", "1_000", "1،5", "1.2.3", "--1", "1,000,", "1\n0", "9".repeat(129)])("rejects ambiguous/invalid %j", input => code(() => parseCorrectionAmountExact(input, "SAR"), "INVALID_AMOUNT"));
  it.each([null, undefined, 1, 0, NaN, Infinity, {}, []])("does not coerce input %j", input => code(() => parseCorrectionAmountExact(input, "SAR"), "INVALID_AMOUNT"));
  it.each([["1.1", "YER"], ["1.001", "SAR"], ["0.00001", "USD"]] as const)("never silently rounds %s %s", (input, currency) => code(() => parseCorrectionAmountExact(input, currency), "TARGET_PRECISION_LOSS"));
  it("rejects unknown currency and overflow", () => {
    code(() => parseCorrectionAmountExact("1", "EUR" as Currency), "INVALID_AMOUNT");
    code(() => parseCorrectionAmountExact("90071992547409.92", "SAR"), "AMOUNT_OUT_OF_RANGE");
    code(() => parseCorrectionAmountExact("9007199254740992", "YER"), "AMOUNT_OUT_OF_RANGE");
  });
});

describe("explicit, disjoint wrong-currency intentions", () => {
  it.each(directions)("preserves intended numerals, not minor counts, %s → %s", (from, to) => {
    const result = evaluateWrongCurrencyAmounts(source(from), intent(from, to));
    expect(result).toMatchObject({ fromCurrency: from, toCurrency: to, mode: "preserve-numerals", targetTotalMinor: 2250 * MINOR_UNITS[to], targetDiscountMinor: 50 * MINOR_UNITS[to], targetNetMinor: 2200 * MINOR_UNITS[to] });
    expect(result.lines.map(row => [row.itemId, row.quantity, row.targetUnitPriceMinor])).toEqual([[31, 2, 1000 * MINOR_UNITS[to]], [32, 1, 250 * MINOR_UNITS[to]]]);
    expect(result).not.toHaveProperty("exchangeRate");
  });
  it.each(directions)("uses only explicitly reviewed target prices for %s → %s", (from, to) => {
    const result = evaluateWrongCurrencyAmounts(source(from), { ...intent(from, to), mode: "reviewed-target-amounts", lines: [{ itemId: 32, unitPrice: "200" }, { itemId: 31, unitPrice: "700" }], discount: "100" });
    expect(result).toMatchObject({ mode: "reviewed-target-amounts", targetTotalMinor: 1600 * MINOR_UNITS[to], targetDiscountMinor: 100 * MINOR_UNITS[to], targetNetMinor: 1500 * MINOR_UNITS[to] });
    expect(result.lines.map(row => row.itemId)).toEqual([31, 32]);
  });
  it.each(["SAR", "USD"] as const)("refuses per-line and discount precision loss to YER from %s", currency => {
    const value = source(currency);
    value.lines = [{ itemId: 31, quantity: 2, unitPriceMinor: 10050 }]; value.totalMinor = 20100; value.discountMinor = 0;
    code(() => evaluateWrongCurrencyAmounts(value, intent(currency, "YER")), "TARGET_PRECISION_LOSS");
    value.lines = [{ itemId: 31, quantity: 1, unitPriceMinor: 10000 }]; value.totalMinor = 10000; value.discountMinor = 50;
    code(() => evaluateWrongCurrencyAmounts(value, intent(currency, "YER")), "TARGET_PRECISION_LOSS");
    expect(evaluateWrongCurrencyAmounts(value, { ...intent(currency, "YER"), mode: "reviewed-target-amounts", lines: [{ itemId: 31, unitPrice: "101" }], discount: "1" })).toMatchObject({ targetNetMinor: 100 });
  });
  it("keeps safe integer limit exact, refuses scaling and summed overflow", () => {
    const value = { ...source("SAR"), totalMinor: Number.MAX_SAFE_INTEGER, discountMinor: 0, lines: [{ itemId: 31, quantity: 1, unitPriceMinor: Number.MAX_SAFE_INTEGER }] };
    expect(evaluateWrongCurrencyAmounts(value, intent("SAR", "USD")).targetNetMinor).toBe(Number.MAX_SAFE_INTEGER);
    code(() => evaluateWrongCurrencyAmounts({ ...value, currency: "YER" }, intent()), "AMOUNT_OUT_OF_RANGE");
    code(() => evaluateWrongCurrencyAmounts(source(), { ...intent(), mode: "reviewed-target-amounts", lines: [{ itemId: 31, unitPrice: "90071992547409.91" }, { itemId: 32, unitPrice: "0" }], discount: "0" }), "AMOUNT_OUT_OF_RANGE");
  });
  it.each([
    { mode: "fx-convert" }, { version: 2 }, { purpose: "conversion" }, { fromCurrency: "USD" }, { toCurrency: "YER" },
    { toCurrency: "EUR" }, { reason: " " }, { exchangeRate: 530 }, { lines: [], discount: "0" }, { approved: true },
  ])("rejects unknown/mixed intent %j", change => code(() => evaluateWrongCurrencyAmounts(source(), { ...intent(), ...change }), "INVALID_INTENT"));
  it.each([
    [{ itemId: 31, unitPrice: "1" }], [{ itemId: 31, unitPrice: "1" }, { itemId: 31, unitPrice: "1" }],
    [{ itemId: 31, unitPrice: "1" }, { itemId: 99, unitPrice: "1" }], [{ itemId: 31, unitPrice: "1", quantity: 3 }, { itemId: 32, unitPrice: "1" }],
    [{ itemId: 31, unitPrice: 1 }, { itemId: 32, unitPrice: "1" }],
  ].map(lines => [lines] as const))("requires exact item membership and forbids identity/quantity edits %j", lines => code(() => evaluateWrongCurrencyAmounts(source(), { ...intent(), mode: "reviewed-target-amounts", lines, discount: "0" }), "INVALID_TARGET_LINES"));
  it("rejects source inconsistency and malformed source", () => {
    code(() => evaluateWrongCurrencyAmounts({ ...source(), totalMinor: 1 }, intent()), "INVALID_SOURCE");
    code(() => evaluateWrongCurrencyAmounts({ ...source(), totalMinor: 2251 }, intent()), "INVALID_SOURCE_TOTAL");
    for (const change of [{ lines: [] }, { patientId: 0 }, { totalMinor: NaN }, { discountMinor: -1 }, { sourceHash: "x" }, { currency: "EUR" }, { currency: null }]) {
      code(() => evaluateWrongCurrencyAmounts({ ...source(), ...change }, intent()), "INVALID_SOURCE");
    }
    code(() => evaluateWrongCurrencyAmounts({ ...source(), lines: [source().lines[0], source().lines[0]] }, intent()), "INVALID_SOURCE");
  });
  it("requires reviewed discount within total and rejects implicit rounding", () => {
    const value = { ...intent(), mode: "reviewed-target-amounts", lines: [{ itemId: 31, unitPrice: "1" }, { itemId: 32, unitPrice: "1" }], discount: "3.01" };
    code(() => evaluateWrongCurrencyAmounts(source(), value), "DISCOUNT_EXCEEDS_TOTAL");
    code(() => evaluateWrongCurrencyAmounts(source(), { ...value, discount: "0.001" }), "TARGET_PRECISION_LOSS");
  });
  it("retains source facts, returns detached frozen facts and stable intent distinctions", () => {
    const original = source(), before = structuredClone(original), input = intent();
    const result = evaluateWrongCurrencyAmounts(original, input);
    expect(original).toEqual(before); expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.lines)).toBe(true); expect(Object.isFrozen(result.lines[0])).toBe(true);
    original.lines = [];
    expect(result.lines).toHaveLength(2);
    const reviewed = evaluateWrongCurrencyAmounts(before, { ...input, mode: "reviewed-target-amounts", lines: [{ itemId: 31, unitPrice: "1000" }, { itemId: 32, unitPrice: "250" }], discount: "50" });
    expect(reviewed.targetNetMinor).toBe(result.targetNetMinor); expect(reviewed.mode).not.toBe(result.mode);
    expect(() => { throw new CurrencyIntentError("EXAMPLE"); }).toThrow(CurrencyIntentError);
  });
});

it("rejects sparse arrays, non-data records, and coercible modes without reading a getter", () => {
  code(() => evaluateWrongCurrencyAmounts({ ...source(), totalMinor: 0, discountMinor: 0, lines: new Array(1) }, intent()), "INVALID_SOURCE");
  code(() => evaluateWrongCurrencyAmounts(source(), { ...intent(), mode: "reviewed-target-amounts", lines: new Array(2), discount: "0" }), "INVALID_TARGET_LINES");
  code(() => evaluateWrongCurrencyAmounts(source(), { ...intent(), mode: { toString: () => "reviewed-target-amounts" }, lines: [], discount: "0" }), "INVALID_INTENT");
  code(() => evaluateWrongCurrencyAmounts(Object.create(source()), intent()), "INVALID_SOURCE");
  const getter = { ...source() }; let read = false;
  Object.defineProperty(getter, "patientId", { enumerable: true, get: () => { read = true; return 1; } });
  code(() => evaluateWrongCurrencyAmounts(getter, intent()), "INVALID_SOURCE"); expect(read).toBe(false);
  code(() => evaluateWrongCurrencyAmounts({ ...source(), discountMinor: -0 }, intent()), "INVALID_SOURCE");
});
