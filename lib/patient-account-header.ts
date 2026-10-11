import { CURRENCIES, type Currency } from "./money";

export interface PatientAccountHeaderBalance { currency: Currency; balanceMinor: number }

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Projection only. The server's canonical ledger already includes openings and
 * settled invoice payments. Never add plan/agreement/work values to this total.
 * Missing currencies are unavailable, never inferred to be zero or converted. */
export function readPatientAccountHeader(financial: unknown, canSeeFinancial: boolean): PatientAccountHeaderBalance[] | null {
  if (!canSeeFinancial || !record(financial) || !record(financial.byCurrency)) return null;
  const buckets = financial.byCurrency;
  if (Object.keys(buckets).length !== CURRENCIES.length) return null;
  const result: PatientAccountHeaderBalance[] = [];
  for (const currency of CURRENCIES) {
    const bucket = buckets[currency];
    if (!record(bucket) || typeof bucket.balanceMinor !== "number" || !Number.isSafeInteger(bucket.balanceMinor)) return null;
    result.push({ currency, balanceMinor: bucket.balanceMinor });
  }
  return result;
}
