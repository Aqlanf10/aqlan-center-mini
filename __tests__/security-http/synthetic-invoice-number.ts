/** Validate the exact minimum-width decimal form of a synthetic invoice sequence. */
export function parseSyntheticInvoiceNumber(value: unknown, prefix: "INV" | "FAC"): bigint | null {
  if (typeof value !== "string" || !value.startsWith(`${prefix}-`)) return null;
  const digits = value.slice(prefix.length + 1);
  if (digits.length === 0 || /[^0-9]/.test(digits)) return null;
  const sequence = BigInt(digits);
  if (sequence <= 0n || digits !== sequence.toString().padStart(5, "0")) return null;
  return sequence;
}
