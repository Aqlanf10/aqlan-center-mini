/** Source-only planning policy. NOT authorization, persistence, or an allocator.
 * No production caller until trusted owner binding and transactional integration
 * are reviewed. Every snapshot must be read under the future allocator lock.
 */
export const PATIENT_NUMBER_MAX = 999999999999999999n;
export const PATIENT_PREFIX_PATTERN = /^[A-Z]{1,6}$/;

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

export function parseNumberingRequest(rawPrefix: unknown, rawNext: unknown): NumberingRequest | null {
  if (typeof rawPrefix !== "string" || typeof rawNext !== "string") return null;
  const trimmedPrefix = rawPrefix.trim();
  // Check ASCII before case conversion: dotless i, sharp s and long s fold to I/SS/S.
  if (!/^[A-Za-z]{1,6}$/.test(trimmedPrefix)) return null;
  const prefix = trimmedPrefix.toUpperCase();
  const next = rawNext.trim();
  // No scientific notation, signs, fractions, Unicode lookalikes or JS rounding.
  if (!PATIENT_PREFIX_PATTERN.test(prefix) || !/^[1-9][0-9]*$/.test(next) || next.length > 18) return null;
  if (BigInt(next) > PATIENT_NUMBER_MAX) return null;
  return { prefix, next };
}

/** Only call with a stored canonical identifier, NEVER an import note/phone. */
export function parseCanonicalPatientNumber(stored: unknown): { prefix: string; number: bigint } | null {
  if (typeof stored !== "string") return null;
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
  // Runtime callers can cross a serialization boundary; never coerce an
  // unverified watermark into a valid allocation floor.
  if (snapshot.prefix !== parsed.prefix || !PATIENT_PREFIX_PATTERN.test(snapshot.prefix)
    || typeof snapshot.allocatedThrough !== "bigint" || typeof snapshot.historicalThrough !== "bigint"
    || (snapshot.pendingNext !== null && typeof snapshot.pendingNext !== "bigint")
    || snapshot.allocatedThrough < 0n || snapshot.historicalThrough < 0n
    || snapshot.allocatedThrough > PATIENT_NUMBER_MAX || snapshot.historicalThrough > PATIENT_NUMBER_MAX
    || (snapshot.pendingNext !== null && (snapshot.pendingNext < 1n || snapshot.pendingNext > PATIENT_NUMBER_MAX))) {
    return { ok: false, reason: "invalid-snapshot" };
  }
  if (snapshot.historyComplete !== true) return { ok: false, reason: "history-unverified" };
  if (typeof snapshot.revision !== "string" || snapshot.revision.trim().length === 0
    || snapshot.revision !== expectedRevision) return { ok: false, reason: "stale-preview" };
  const high = snapshot.allocatedThrough > snapshot.historicalThrough ? snapshot.allocatedThrough : snapshot.historicalThrough;
  const next = BigInt(parsed.next);
  if (next <= high || (snapshot.pendingNext !== null && next < snapshot.pendingNext)) {
    return { ok: false, reason: "would-reuse-or-rewind" };
  }
  return { ok: true, prefix: parsed.prefix, next: parsed.next,
    preview: `${parsed.prefix}-${parsed.next.padStart(5, "0")}`, expectedRevision };
}
