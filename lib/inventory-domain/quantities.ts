/** Exact quantities at the existing inventory_movements NUMERIC(12,3) boundary.
 * Decimal text is required: accepting a JS float here would hide prior rounding.
 */
export const QUANTITY_SCALE = 1_000n;
export const MAX_QUANTITY_ATOMS = 999_999_999_999n;

export class InventoryDomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "InventoryDomainError";
  }
}

export function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new InventoryDomainError(code, message);
}

export function positiveId(value: unknown, name = "id"): asserts value is number {
  invariant(typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    "invalid_id", `${name} must be a positive safe integer`);
}

export function precisionOf(value: unknown): asserts value is number {
  invariant(typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3,
    "invalid_precision", "Quantity precision must be between zero and three decimal places");
}

/** Strict decimal grammar. Arabic digits/decimal separator are normalized, never
 * thousands separators, exponent notation, signs, NaN or partially parsed input.
 */
export function decimalRatio(input: unknown, maxPlaces = 9): Readonly<{
  numerator: bigint; denominator: bigint; canonical: string;
}> {
  invariant(typeof input === "string" && input.length <= 64, "invalid_decimal", "Use bounded decimal text");
  const text = input.trim().replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/٫/g, ".");
  invariant(/^\d+(?:\.\d+)?$/.test(text), "invalid_decimal", "Invalid decimal quantity or rate");
  const [wholeText, fractionText = ""] = text.split(".");
  const whole = wholeText.replace(/^0+(?=\d)/, "");
  const fraction = fractionText.replace(/0+$/, "");
  invariant(fraction.length <= maxPlaces, "quantity_precision", "Decimal exceeds allowed precision");
  return Object.freeze({
    numerator: BigInt(whole + fraction), denominator: 10n ** BigInt(fraction.length),
    canonical: fraction ? `${whole}.${fraction}` : whole,
  });
}

export function quantityAtoms(input: unknown, precision = 3, allowZero = false): bigint {
  precisionOf(precision);
  const decimal = decimalRatio(input, precision);
  const atoms = decimal.numerator * QUANTITY_SCALE / decimal.denominator;
  invariant(atoms <= MAX_QUANTITY_ATOMS, "quantity_overflow", "Quantity exceeds NUMERIC(12,3)");
  invariant(allowZero || atoms > 0n, "zero_quantity", "Quantity must be greater than zero");
  return atoms;
}

export function quantityText(atoms: bigint): string {
  invariant(typeof atoms === "bigint" && atoms >= 0n && atoms <= MAX_QUANTITY_ATOMS,
    "quantity_overflow", "Quantity is outside NUMERIC(12,3)");
  const whole = atoms / QUANTITY_SCALE;
  const fraction = String(atoms % QUANTITY_SCALE).padStart(3, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export interface UnitConversionSnapshot {
  readonly itemId: number;
  readonly version: number;
  readonly baseUnit: string;
  readonly enteredUnit: string;
  /** Base units for one entered unit; this is item-specific, never inferred from a label. */
  readonly baseUnitsPerEnteredUnit: string;
  readonly enteredPrecision: number;
  readonly basePrecision: number;
}

/** A detached immutable copy, suitable for storage on every source document. */
export function unitConversionSnapshot(input: UnitConversionSnapshot): Readonly<UnitConversionSnapshot> {
  positiveId(input.itemId, "itemId");
  positiveId(input.version, "conversion version");
  for (const unit of [input.baseUnit, input.enteredUnit]) {
    invariant(typeof unit === "string" && unit.trim().length > 0 && unit.length <= 80,
      "invalid_unit", "A base and entered unit are required");
  }
  precisionOf(input.enteredPrecision);
  precisionOf(input.basePrecision);
  const factor = decimalRatio(input.baseUnitsPerEnteredUnit);
  invariant(factor.numerator > 0n, "invalid_conversion", "Conversion factor must be positive");
  invariant(factor.numerator <= MAX_QUANTITY_ATOMS * factor.denominator / QUANTITY_SCALE,
    "quantity_overflow", "Conversion factor exceeds quantity storage capacity");
  invariant(input.baseUnit.trim() !== input.enteredUnit.trim() || factor.numerator === factor.denominator,
    "invalid_conversion", "The same unit must have a conversion factor of one");
  return Object.freeze({ itemId: input.itemId, version: input.version,
    baseUnit: input.baseUnit.trim(), enteredUnit: input.enteredUnit.trim(),
    baseUnitsPerEnteredUnit: factor.canonical,
    enteredPrecision: input.enteredPrecision, basePrecision: input.basePrecision });
}

export interface ConvertedQuantity {
  readonly enteredQuantity: string;
  readonly baseQuantity: string;
  readonly conversion: Readonly<UnitConversionSnapshot>;
}

export function convertQuantity(input: unknown, conversion: UnitConversionSnapshot, allowZero = false): ConvertedQuantity {
  const snapshot = unitConversionSnapshot(conversion);
  const entered = quantityAtoms(input, snapshot.enteredPrecision, allowZero);
  const factor = decimalRatio(snapshot.baseUnitsPerEnteredUnit);
  const numerator = entered * factor.numerator;
  const quantum = 10n ** BigInt(3 - snapshot.basePrecision);
  invariant(numerator % (factor.denominator * quantum) === 0n,
    "inexact_conversion", "Conversion cannot be represented exactly in the item's base unit; no silent rounding");
  const base = numerator / factor.denominator;
  invariant(base <= MAX_QUANTITY_ATOMS, "quantity_overflow", "Converted quantity exceeds NUMERIC(12,3)");
  invariant(allowZero || base > 0n, "zero_quantity", "Conversion must produce a positive quantity");
  return Object.freeze({ enteredQuantity: quantityText(entered), baseQuantity: quantityText(base), conversion: snapshot });
}

/** Never permits changing the meaning of historical quantities. A real conversion
 * migration or linked replacement item needs a separately approved integration. */
export function assertBaseUnitEdit(current: string, proposed: string, historicalMovementCount: number): void {
  invariant(Number.isSafeInteger(historicalMovementCount) && historicalMovementCount >= 0,
    "invalid_history_count", "Historical movement count must be supplied by the server");
  invariant(current === proposed || historicalMovementCount === 0,
    "historical_unit_change", "Changing a base unit with historical movements requires an approved migration");
}
