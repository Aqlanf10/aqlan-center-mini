/** HTTP-only admission: preserve the existing default/range, never round a
 * supplied duration. The trusted writer retains its independent semantics. */
export function readOrthoCreateDuration(value: unknown): number | null {
  if (value == null) return 18;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const months = Number(value);
  if (!Number.isInteger(months) || months < 1 || months > 120) return null;
  if (typeof value === "number") return months;

  const text = value.trim();
  // Number-compatible radix integers cannot conceal a fractional component.
  if (/^0(?:x[\da-f]+|o[0-7]+|b[01]+)$/i.test(text)) return months;
  const match = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? match[3] ?? "";
  const digits = ((match[1] ?? "") + fraction).replace(/^0+/, "");
  const significant = digits.replace(/0+$/, "");
  const scale = Number(match[4] ?? 0) - fraction.length + digits.length - significant.length;
  const expected = String(months);
  const expectedSignificant = expected.replace(/0+$/, "");
  // Compare decimal structure, not binary floating point: e.g. a supplied
  // "18.00000000000000001" must not be admitted as 18 after Number rounding.
  return significant === expectedSignificant && scale === expected.length - expectedSignificant.length
    ? months : null;
}
