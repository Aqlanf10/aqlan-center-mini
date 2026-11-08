/** Check decimal integrality without losing authored fractional digits to IEEE rounding. */
function exactIntegerString(value: string): boolean {
  // Number has already checked syntax/range. Radix literals contain integer digits only.
  if (/^0[xob]/i.test(value)) return true;
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return false;
  const whole = match[2], fraction = match[3] ?? "", digits = whole + fraction;
  if (!digits.length || !/[1-9]/.test(digits)) return false;
  const rawExponent = match[4] ?? "0";
  const negative = rawExponent.startsWith("-");
  // Saturation bounds work by input size, never by an exponent-sized allocation.
  const limit = digits.length + 1;
  let exponent = 0;
  for (const digit of rawExponent.replace(/^[+-]/, "")) {
    exponent = Math.min(limit, exponent * 10 + Number(digit));
  }
  const decimalPosition = whole.length + (negative ? -exponent : exponent);
  return decimalPosition > 0 && !/[1-9]/.test(digits.slice(decimalPosition));
}

/** Explicit authored interval, not a defaulting or rounding operation. */
export function parseAdjustmentInterval(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const weeks = Number(value);
  if (!Number.isFinite(weeks) || !Number.isInteger(weeks) || weeks < 1 || weeks > 52) return null;
  if (typeof value === "string" && !exactIntegerString(value.trim())) return null;
  return weeks;
}
export const ADJUSTMENT_INTERVAL_ERROR = "أدخل عددًا صحيحًا من 1 إلى 52 أسبوعًا؛ لم يبدأ تسجيل جلسة جديدة.";
