/** PG int8 arrives as text under the application's existing driver settings.
 * Accept its exact decimal form, never coercible arrays/floats or unsafe IDs. */
export function studyPgPositiveInteger(raw: unknown): number {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) return raw;
  if (typeof raw === "string" && /^[1-9]\d*$/.test(raw)) {
    const n = Number(raw); if (Number.isSafeInteger(n) && n > 0) return n;
  }
  throw new Error("invalid_study_pg_integer");
}
