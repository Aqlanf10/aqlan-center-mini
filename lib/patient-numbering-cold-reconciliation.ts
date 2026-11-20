/** Unwired validation for a configured prefix namespace. Does not bootstrap,
 * activate allocation, choose a lineage, remap an ID, or call application startup. */
import { parseCanonicalPatientNumber } from "./patient-numbering-policy";
import type {
  NumberingFreshnessWitness, NumberingRecoveryPayload, NumberingRecoverySequence,
} from "./patient-numbering-recovery";

/** Supplied only by an independent fenced source authority, never derived
 * from the restored target or the same archive. No delivery provider exists. */
export interface NumberingColdReconciliationAuthority {
  expectedLineage: string;
  readCurrent(lineage: string): Promise<(NumberingFreshnessWitness & {
    legacyP: NumberingRecoverySequence;
  }) | null>;
}

type Refusal = "ambiguous-patient-identifier" | "patient-number-beyond-proven-counter" | "retired-alias-owner-conflict";
export function validateSurvivingNumberedFiles(
  state: NumberingRecoveryPayload, files: readonly Record<string, unknown>[],
): { ok: true } | { ok: false; reason: Refusal } {
  const consumed = new Map(state.counters.map(c => [c.prefix, c.isCalled ? BigInt(c.lastValue) : BigInt(c.historicalThrough)]));
  // A later reservation can reset is_called and leave historicalThrough
  // unchanged. Only the authenticated/canonical audit's BEFORE snapshot can
  // carry that prior consumed watermark; a preview/after-state reservation
  // never proves issuance. The codec pairs audit with the exact receipt,
  // validates prefix and policy progression, and disallows rewind.
  for (const { beforeState } of state.audit) {
    const earlier = BigInt(beforeState.allocatedThrough);
    const current = consumed.get(beforeState.prefix);
    if (current !== undefined && earlier > current) consumed.set(beforeState.prefix, earlier);
  }
  const aliasOwners = new Map(state.retiredAliases.map(row => [row.number[0] + "-" + BigInt(row.number.slice(2)), row.patientId]));
  for (const row of files) {
    const parsed = typeof row.number === "string" ? parseCanonicalPatientNumber(row.number) : null;
    if (!parsed || typeof row.patientId !== "string" || !/^[1-9][0-9]{0,18}$/.test(row.patientId)) {
      return { ok: false, reason: "ambiguous-patient-identifier" };
    }
    const high = consumed.get(parsed.prefix);
    if (high === undefined || parsed.number > high) {
      return { ok: false, reason: "patient-number-beyond-proven-counter" };
    }
    const aliasOwner = aliasOwners.get(parsed.prefix + "-" + parsed.number);
    if (aliasOwner !== undefined && aliasOwner !== row.patientId) {
      return { ok: false, reason: "retired-alias-owner-conflict" };
    }
  }
  return { ok: true };
}
export function nextAfterNumberingSequence(value: NumberingRecoverySequence): bigint {
  return BigInt(value.lastValue) + (value.isCalled ? 1n : 0n);
}

/** Equal next values don't make an unconsumed reservation and an issued
 * sequence value the same evidence. Both fields must be stable. */
export function sameNumberingSequence(first: NumberingRecoverySequence, second: NumberingRecoverySequence): boolean {
  return first.lastValue === second.lastValue && first.isCalled === second.isCalled;
}
