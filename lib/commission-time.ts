/**
 * Reattach PostgreSQL's six fractional digits before comparing commission events.
 * The native Date keeps the existing calendar/timezone/extended-year behavior;
 * the query-local US projection keeps precision that the driver otherwise loses.
 */
export function commissionTimestampIso(timestamp: Date, microsecondFraction: string): string {
  if (!/^\d{6}$/.test(microsecondFraction)) {
    throw new RangeError("Invalid commission timestamp microseconds");
  }
  return timestamp.toISOString().replace(/\.\d{3}Z$/, `.${microsecondFraction}Z`);
}

/** Exact microsecond comparison; never coerce the full epoch-microsecond key to Number. */
export function commissionTimeKey(atIso: string): bigint {
  const milliseconds = Date.parse(atIso);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError("Invalid commission event timestamp");
  }
  // Retain valid legacy Date inputs at their former millisecond precision. ISO
  // event strings additionally retain the three sub-millisecond database digits.
  const fraction = /[T ]\d{2}:\d{2}:\d{2}\.(\d+)(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.exec(atIso)?.[1] ?? "";
  const subMillisecond = fraction.padEnd(6, "0").slice(3, 6);
  return BigInt(milliseconds) * 1000n + BigInt(subMillisecond);
}
