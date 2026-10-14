import { invariant, positiveId, quantityAtoms, quantityText } from "./quantities";

/** This is a locked read projection of existing movement allocations, not a
 * second stock ledger. The writer must re-read it inside its transaction. */
export interface LotAvailability {
  lotId: number;
  itemId: number;
  locationId: number;
  branchId: number;
  sourceMovementId: number;
  receivedSequence: number;
  status: "accepted" | "quarantined" | "recalled" | "rejected";
  expiryRequired: boolean;
  expiryDate: string | null;
  remainingQuantity: string;
  reservedQuantity: string;
  traceability: "recorded" | "legacy_unknown";
}
function day(value: string): string {
  invariant(/^\d{4}-\d{2}-\d{2}$/.test(value), "invalid_day", "Use an exact calendar date");
  const date = new Date(`${value}T00:00:00Z`);
  invariant(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value, "invalid_day", "Invalid calendar date");
  return value;
}

/** FEFO selects only eligible, unreserved stock. WAC continues to value issues.
 * No inference of a historical lot/visit link is made. Expiry day itself is
 * eligible, matching existing expiryState; earlier dates are expired.
 */
export function planValidLotIssue(input: {
  itemId: number; locationId: number; branchId: number; today: string;
  quantity: string; precision: number; lots: readonly LotAvailability[];
}) {
  positiveId(input.itemId); positiveId(input.locationId); positiveId(input.branchId);
  day(input.today);
  let need = quantityAtoms(input.quantity, input.precision);
  const ids = new Set<number>();
  const available = input.lots.map(lot => {
    for (const id of [lot.lotId, lot.itemId, lot.locationId, lot.branchId, lot.sourceMovementId, lot.receivedSequence]) positiveId(id);
    invariant(!ids.has(lot.lotId), "duplicate_lot", "A lot may appear only once in an issue projection"); ids.add(lot.lotId);
    invariant(lot.itemId === input.itemId && lot.locationId === input.locationId && lot.branchId === input.branchId,
      "lot_scope_mismatch", "Lot item, location and branch must match the issue scope");
    const remaining = quantityAtoms(lot.remainingQuantity, input.precision, true);
    const reserved = quantityAtoms(lot.reservedQuantity, input.precision, true);
    invariant(reserved <= remaining, "invalid_reservation", "Reserved quantity exceeds remaining stock");
    if (lot.expiryDate !== null) day(lot.expiryDate);
    invariant(["accepted", "quarantined", "recalled", "rejected"].includes(lot.status), "invalid_lot_status", "Invalid lot status");
    return { lot, available: remaining - reserved };
  }).filter(({ lot, available }) => available > 0n && lot.status === "accepted"
    && (!lot.expiryRequired || lot.expiryDate !== null)
    && (lot.expiryDate === null || lot.expiryDate >= input.today))
    .sort((a, b) => (a.lot.expiryDate ?? "9999-12-31").localeCompare(b.lot.expiryDate ?? "9999-12-31")
      || a.lot.receivedSequence - b.lot.receivedSequence || a.lot.lotId - b.lot.lotId);
  const allocations: { lotId: number; sourceMovementId: number; quantity: string; traceability: LotAvailability["traceability"] }[] = [];
  for (const entry of available) {
    if (need === 0n) break;
    const take = entry.available < need ? entry.available : need;
    allocations.push({ lotId: entry.lot.lotId, sourceMovementId: entry.lot.sourceMovementId, quantity: quantityText(take), traceability: entry.lot.traceability });
    need -= take;
  }
  invariant(need === 0n, "insufficient_valid_stock", "Valid unreserved stock is insufficient; expired or quarantined lots cannot fill the shortage");
  return allocations;
}
