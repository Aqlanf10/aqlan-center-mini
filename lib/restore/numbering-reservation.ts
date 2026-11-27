import type { PrefixSnapshot } from "../patient-numbering-policy";
import { planRestoredNumberingFloor, type IndependentNumberingWatermark, type RestoreNumberingBinding } from "./numbering-floor-policy";

/**
 * Source-only reservation contract, NOT a production adapter or cutover gate.
 * The trusted backend must authenticate the lineage, fence every old writer,
 * serialize with ALL allocators and commit independently of the restored DB.
 * A rejected/ambiguous commit MUST NOT expose a number or roll back a committed
 * watermark. Never construct this backend from an archive or HTTP request.
 */
export interface IndependentReservationTransaction {
  readFresh(prefix: string): Promise<IndependentNumberingWatermark | null>;
  /** Atomic CAS on the complete binding, prefix and previous watermark. */
  advance(previous: IndependentNumberingWatermark, reservedThrough: bigint): Promise<boolean>;
}
export interface IndependentReservationBackend {
  /** Resolves only after durable commit; rejects on uncertain commit.
   * The binding must be authenticated and fenced for the full transaction. */
  transaction<T>(binding: RestoreNumberingBinding, work: (tx: IndependentReservationTransaction) => Promise<T>): Promise<T>;
}
export type RestoreReservationResult =
  | { ok: false; reason: string }
  | { ok: true; reserved: string; prefix: string };

/** Burns a number before any caller can see it. Does NOT create a patient,
 * authorize cutover, change a sequence, or enable numbering settings.
 * An ambiguous commit may burn a number; retry must obtain fresh evidence. */
export async function reserveRestoredNumber(
  archive: PrefixSnapshot,
  binding: RestoreNumberingBinding,
  backend: IndependentReservationBackend | null,
): Promise<RestoreReservationResult> {
  if (!backend) return { ok: false, reason: "independent-reservation-unavailable" };
  try {
    // Capture the trusted primitive-only inputs before the first asynchronous
    // boundary. Waiting for an authority lock must not change which archive
    // evidence, prefix or admitted generation this reservation evaluates.
    const snapshot: PrefixSnapshot = Object.freeze({ ...archive });
    const expected: RestoreNumberingBinding = Object.freeze({ ...binding });
    return await backend.transaction<RestoreReservationResult>(expected, async tx => {
      const witness = await tx.readFresh(snapshot.prefix);
      const plan = planRestoredNumberingFloor(snapshot, expected, witness);
      if (!plan.ok) return plan;
      if (!witness || !await tx.advance(witness, BigInt(plan.next))) {
        return { ok: false, reason: "watermark-reservation-conflict" };
      }
      return { ok: true, reserved: plan.next, prefix: plan.prefix };
    });
  } catch {
    return { ok: false, reason: "watermark-reservation-unconfirmed" };
  }
}
