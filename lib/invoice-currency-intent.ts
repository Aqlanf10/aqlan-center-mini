import { isCurrency, MINOR_UNITS, type Currency } from "./money";

/** S1 proposal only. No production writer/reader imports this contract. Its
 * version is an amount-intent version, NOT the existing settlement/clinical
 * evidence version. In particular it does not replace v1 recovery or receipts. */
export class CurrencyIntentError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CurrencyIntentError"; }
}
function fail(code: string): never { throw new CurrencyIntentError(code); }
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  && Reflect.ownKeys(value).every(key => typeof key === "string"
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));
const keys = (value: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
/** Reject sparse/accessor/custom-iterator containers before inspecting values. */
const denseArray = (value: unknown): value is unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field || field.enumerable !== true || !Object.hasOwn(field, "value")) return false;
  }
  return true;
};
const minor = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const id = (value: unknown): value is number => minor(value) && value > 0;
const bounded = (value: bigint): number => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail("AMOUNT_OUT_OF_RANGE");
  return Number(value);
};

/** Exact decimal input, never floating-point rounding or an FX conversion.
 * Arabic/Persian digits and correctly grouped thousands are accepted. Ambiguous
 * commas, signs, exponents and interior whitespace are rejected. Extra decimal
 * zeroes are lossless; any nonzero sub-minor amount is refused. */
export function parseCorrectionAmountExact(input: unknown, currency: Currency): number {
  if (!isCurrency(currency) || typeof input !== "string" || input.length > 128) fail("INVALID_AMOUNT");
  const value = (input as string).trim()
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".").replace(/٬/g, ",");
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value)) fail("INVALID_AMOUNT");
  const [whole, fraction = ""] = value.replace(/,/g, "").split(".");
  const places = MINOR_UNITS[currency] === 1 ? 0 : 2;
  if (/[1-9]/.test(fraction.slice(places))) fail("TARGET_PRECISION_LOSS");
  return bounded(BigInt(whole) * BigInt(MINOR_UNITS[currency])
    + BigInt(fraction.slice(0, places).padEnd(places, "0") || "0"));
}

export interface CurrencyCorrectionSource {
  patientId: number; invoiceId: number; sourceHash: string; currency: Currency;
  totalMinor: number; discountMinor: number;
  lines: readonly { itemId: number; quantity: number; unitPriceMinor: number }[];
}
export type WrongCurrencyIntent = {
  version: 1; purpose: "wrong-currency"; fromCurrency: Currency; toCurrency: Currency; reason: string;
} & ({ mode: "preserve-numerals" } | {
  mode: "reviewed-target-amounts";
  lines: readonly { itemId: number; unitPrice: string }[]; discount: string;
});
export interface WrongCurrencyAmounts {
  readonly intentVersion: 1; readonly purpose: "wrong-currency";
  readonly mode: WrongCurrencyIntent["mode"]; readonly reason: string;
  readonly patientId: number; readonly invoiceId: number; readonly sourceHash: string;
  readonly fromCurrency: Currency; readonly toCurrency: Currency;
  readonly lines: readonly Readonly<{ itemId: number; quantity: number; sourceUnitPriceMinor: number; targetUnitPriceMinor: number }>[];
  readonly sourceTotalMinor: number; readonly sourceDiscountMinor: number; readonly sourceNetMinor: number;
  readonly targetTotalMinor: number; readonly targetDiscountMinor: number; readonly targetNetMinor: number;
}

/** Binds the amount interpretation to exact item IDs and source version. No
 * quantity, clinical identity, service, tooth, plan or installment is editable
 * through this contract. Caller-supplied snapshots are NOT database authority. */
export function evaluateWrongCurrencyAmounts(sourceValue: unknown, intentValue: unknown): WrongCurrencyAmounts {
  if (!record(sourceValue) || !keys(sourceValue, ["patientId", "invoiceId", "sourceHash", "currency", "totalMinor", "discountMinor", "lines"])
    || !id(sourceValue.patientId) || !id(sourceValue.invoiceId) || !isCurrency(sourceValue.currency)
    || typeof sourceValue.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceValue.sourceHash)
    || !minor(sourceValue.totalMinor) || !minor(sourceValue.discountMinor) || sourceValue.discountMinor > sourceValue.totalMinor
    || !denseArray(sourceValue.lines) || !sourceValue.lines.length || sourceValue.lines.length > 200
    || !Array.from(sourceValue.lines).every(row => record(row) && keys(row, ["itemId", "quantity", "unitPriceMinor"])
      && id(row.itemId) && id(row.quantity) && minor(row.unitPriceMinor))) fail("INVALID_SOURCE");
  const source = sourceValue as unknown as CurrencyCorrectionSource;
  if (new Set(source.lines.map(row => row.itemId)).size !== source.lines.length) fail("INVALID_SOURCE");
  const sourceTotal = bounded(source.lines.reduce((sum, row) => sum + BigInt(row.quantity) * BigInt(row.unitPriceMinor), 0n));
  if (sourceTotal !== source.totalMinor) fail("INVALID_SOURCE_TOTAL");
  if (!record(intentValue) || intentValue.version !== 1 || intentValue.purpose !== "wrong-currency"
    || !isCurrency(intentValue.fromCurrency) || !isCurrency(intentValue.toCurrency)
    || intentValue.fromCurrency !== source.currency || intentValue.toCurrency === source.currency
    || typeof intentValue.reason !== "string" || !intentValue.reason.trim() || intentValue.reason.length > 1000
    || (intentValue.mode !== "preserve-numerals" && intentValue.mode !== "reviewed-target-amounts")) fail("INVALID_INTENT");
  const shared = ["version", "purpose", "fromCurrency", "toCurrency", "reason", "mode"];
  if (!keys(intentValue as Record<string, unknown>, intentValue.mode === "preserve-numerals" ? shared : [...shared, "lines", "discount"])) fail("INVALID_INTENT");
  const intent = intentValue as unknown as WrongCurrencyIntent;
  const targetPrices = new Map<number, number>();
  let targetDiscount: number;
  if (intent.mode === "preserve-numerals") {
    const preserve = (value: number) => {
      const scaled = BigInt(value) * BigInt(MINOR_UNITS[intent.toCurrency]);
      const divisor = BigInt(MINOR_UNITS[source.currency]);
      if (scaled % divisor !== 0n) fail("TARGET_PRECISION_LOSS");
      return bounded(scaled / divisor);
    };
    for (const row of source.lines) targetPrices.set(row.itemId, preserve(row.unitPriceMinor));
    targetDiscount = preserve(source.discountMinor);
  } else {
    if (!denseArray(intent.lines) || intent.lines.length !== source.lines.length
      || !Array.from(intent.lines).every(row => record(row) && keys(row, ["itemId", "unitPrice"]) && id(row.itemId)
        && typeof row.unitPrice === "string" && source.lines.some(item => item.itemId === row.itemId))
      || new Set(intent.lines.map(row => row.itemId)).size !== source.lines.length) fail("INVALID_TARGET_LINES");
    for (const row of intent.lines) targetPrices.set(row.itemId, parseCorrectionAmountExact(row.unitPrice, intent.toCurrency));
    targetDiscount = parseCorrectionAmountExact(intent.discount, intent.toCurrency);
  }
  const lines = source.lines.map(row => Object.freeze({ itemId: row.itemId, quantity: row.quantity,
    sourceUnitPriceMinor: row.unitPriceMinor, targetUnitPriceMinor: targetPrices.get(row.itemId)! }));
  const targetTotal = bounded(lines.reduce((sum, row) => sum + BigInt(row.quantity) * BigInt(row.targetUnitPriceMinor), 0n));
  if (targetDiscount > targetTotal) fail("DISCOUNT_EXCEEDS_TOTAL");
  return Object.freeze({ intentVersion: 1, purpose: "wrong-currency", mode: intent.mode, reason: intent.reason.trim(),
    patientId: source.patientId, invoiceId: source.invoiceId, sourceHash: source.sourceHash,
    fromCurrency: source.currency, toCurrency: intent.toCurrency, lines: Object.freeze(lines),
    sourceTotalMinor: sourceTotal, sourceDiscountMinor: source.discountMinor, sourceNetMinor: sourceTotal - source.discountMinor,
    targetTotalMinor: targetTotal, targetDiscountMinor: targetDiscount, targetNetMinor: targetTotal - targetDiscount });
}
