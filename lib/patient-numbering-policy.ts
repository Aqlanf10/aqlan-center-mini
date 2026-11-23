/** Source-only planning policy. NOT authorization, persistence, or an allocator.
 * No production caller until trusted owner binding and transactional integration
 * are reviewed. Every snapshot must be read under the future allocator lock.
 */
// Existing portal accepts at most 20 characters: one letter + hyphen + 18 digits.
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

export function parseNumberingRequest(rawPrefix: unknown, rawNext: unknown): NumberingRequest | null {
  if (typeof rawPrefix !== "string" || typeof rawNext !== "string") return null;
  const prefix = rawPrefix.trim().toUpperCase();
  const next = rawNext.trim();
  // No scientific notation, signs, fractions, Unicode lookalikes or JS rounding.
  if (!/^[A-Z]$/.test(prefix) || !/^[1-9][0-9]*$/.test(next) || next.length > 18) return null;
  if (BigInt(next) > PATIENT_NUMBER_MAX) return null;
  return { prefix, next };
}

/** Only call with a stored canonical identifier, NEVER an import note/phone. */
export function parseCanonicalPatientNumber(stored: string): { prefix: string; number: bigint } | null {
  const match = /^([A-Z])-([0-9]{5,18})$/.exec(stored);
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
  if (snapshot.prefix !== parsed.prefix || !/^[A-Z]$/.test(snapshot.prefix)
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
    preview: `${parsed.prefix}-${parsed.next.padStart(5, "0")}`, expectedRevision };
}
