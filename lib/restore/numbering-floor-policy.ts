import { PATIENT_NUMBER_MAX, planPatientNumbering, type PrefixSnapshot, type NumberingPlan } from "../patient-numbering-policy";

/**
 * Pure recovery planning only. NOT an allocation fence or an authorization
 * decision. The future adapter must obtain fresh evidence from an independent
 * durable store while excluding every old writer generation. Neither the
 * witness nor the expected binding may come from the restored archive or HTTP.
 * A successful plan does not permit cutover, setval or issuance.
 */
export interface RestoreNumberingBinding {
  lineage: string;
  generation: string;
}
export interface IndependentNumberingWatermark extends RestoreNumberingBinding {
  prefix: string;
  /** Includes all previously reserved numbers, even unused or rolled back. */
  reservedThrough: bigint;
}
const identifier = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(v);
const bounded = (v: unknown): v is bigint =>
  typeof v === "bigint" && v >= 0n && v <= PATIENT_NUMBER_MAX;

export function planRestoredNumberingFloor(
  archive: PrefixSnapshot,
  expected: RestoreNumberingBinding,
  witness: IndependentNumberingWatermark | null,
): NumberingPlan {
  if (!witness) return { ok: false, reason: "independent-watermark-unavailable" };
  if (!identifier(expected.lineage) || !identifier(expected.generation)
    || witness.lineage !== expected.lineage || witness.generation !== expected.generation
    || witness.prefix !== archive.prefix) {
    return { ok: false, reason: "watermark-binding-mismatch" };
  }
  if (!bounded(witness.reservedThrough) || !bounded(archive.allocatedThrough)
    || !bounded(archive.historicalThrough)
    || (archive.pendingNext !== null && (!bounded(archive.pendingNext) || archive.pendingNext === 0n))) {
    return { ok: false, reason: "invalid-snapshot" };
  }
  // A supposedly authoritative external record must cover every consumed
  // archive number. Do not conceal stale evidence by merely taking max().
  if (witness.reservedThrough < archive.allocatedThrough
    || witness.reservedThrough < archive.historicalThrough) {
    return { ok: false, reason: "watermark-behind-archive" };
  }
  if (witness.reservedThrough === PATIENT_NUMBER_MAX) {
    return { ok: false, reason: "numbering-exhausted" };
  }
  let next = witness.reservedThrough + 1n;
  if (archive.pendingNext !== null && archive.pendingNext > next) next = archive.pendingNext;
  // Reuse the canonical format, history completeness and bounds policy.
  return planPatientNumbering({ prefix: archive.prefix, next: next.toString() },
    { ...archive, allocatedThrough: witness.reservedThrough }, archive.revision);
}
