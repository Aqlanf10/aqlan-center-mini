/** Source-only planning policy. NOT authorization, persistence, or an allocator.
 * No production caller until trusted owner binding and transactional integration
 * are reviewed. Every snapshot must be read under the future allocator lock.
 */
// Existing portal and archive invariants accept at most 20 characters total (e.g. P-07000, BRW-07429).
export const MAX_PATIENT_NUMBER_LENGTH = 20;
export const PATIENT_PREFIX_PATTERN = /^[A-Z]{1,6}$/;
export const PATIENT_NUMBER_MAX = 999999999999999999n;
export interface NumberingRequest { prefix: string; next: string }
export interface PrefixSnapshot {
  prefix: string;
  /** Durable high-water, including retired/deleted/rolled-back allocations. */
  allocatedThrough: bigint;
  /** An explicitly reserved next value, including legacy is_called=false. */
  pendingNext: bigint | null;
  /** Maximum canonical historical number for THIS prefix only. */
  historicalThrough: bigint;
  /** False until canonical and ambiguous legacy identifiers were reconciled. */
  historyComplete: boolean;
  revision: string;
}
export type NumberingPlan =
  | { ok: false; reason: string }
  | { ok: true; prefix: string; next: string; preview: string; expectedRevision: string };

export function formatCanonicalPatientNumber(prefix: string, numericText: string): string {
  return `${prefix}-${numericText.padStart(5, "0")}`;
}

export function parseNumberingRequest(rawPrefix: unknown, rawNext: unknown): NumberingRequest | null {
  if (typeof rawPrefix !== "string" || typeof rawNext !== "string") return null;
  const prefixText = rawPrefix.trim();
  // Check before uppercasing; Unicode lookalikes such as ß must not expand to ASCII.
  if (!/^[A-Za-z]{1,6}$/.test(prefixText)) return null;
  const prefix = prefixText.toUpperCase();
  const next = rawNext.trim().replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x6f0));
  // Only Arabic/Persian decimal digit input is normalized; no signs or JS rounding.
  if (!PATIENT_PREFIX_PATTERN.test(prefix) || !/^[1-9][0-9]*$/.test(next) || next.length > 18) return null;
  if (formatCanonicalPatientNumber(prefix, next).length > MAX_PATIENT_NUMBER_LENGTH) return null;
  if (BigInt(next) > PATIENT_NUMBER_MAX) return null;
  return { prefix, next };
}

/** Only call with a stored canonical identifier, NEVER an import note/phone. */
export function parseCanonicalPatientNumber(stored: string): { prefix: string; number: bigint } | null {
  if (typeof stored !== "string" || stored.length > MAX_PATIENT_NUMBER_LENGTH) return null;
  const match = /^([A-Z]{1,6})-([0-9]{5,18})$/.exec(stored);
  if (!match) return null;
  const number = BigInt(match[2]);
  if (number < 1n || number > PATIENT_NUMBER_MAX) return null;
  // Reject noncanonical extra zeroes rather than silently treating history as fresh.
  if (number.toString().padStart(5, "0") !== match[2]) return null;
  return { prefix: match[1], number };
}

export function planPatientNumbering(
  request: NumberingRequest, snapshot: PrefixSnapshot, expectedRevision: string,
): NumberingPlan {
  const parsed = parseNumberingRequest(request.prefix, request.next);
  if (!parsed) return { ok: false, reason: "invalid-input" };
  if (snapshot.prefix !== parsed.prefix || !PATIENT_PREFIX_PATTERN.test(snapshot.prefix)
    || snapshot.allocatedThrough < 0n || snapshot.historicalThrough < 0n
    || snapshot.allocatedThrough > PATIENT_NUMBER_MAX || snapshot.historicalThrough > PATIENT_NUMBER_MAX
    || (snapshot.pendingNext !== null && (snapshot.pendingNext < 1n || snapshot.pendingNext > PATIENT_NUMBER_MAX))) {
    return { ok: false, reason: "invalid-snapshot" };
  }
  if (!snapshot.historyComplete) return { ok: false, reason: "history-unverified" };
  if (!snapshot.revision || snapshot.revision !== expectedRevision) return { ok: false, reason: "stale-preview" };
  const high = snapshot.allocatedThrough > snapshot.historicalThrough ? snapshot.allocatedThrough : snapshot.historicalThrough;
  const next = BigInt(parsed.next);
  if (next <= high || (snapshot.pendingNext !== null && next < snapshot.pendingNext)) {
    return { ok: false, reason: "would-reuse-or-rewind" };
  }
  return { ok: true, prefix: parsed.prefix, next: parsed.next,
    preview: formatCanonicalPatientNumber(parsed.prefix, parsed.next), expectedRevision };
}
