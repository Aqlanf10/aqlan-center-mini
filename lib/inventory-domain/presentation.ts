import type { InventoryMovement } from "../db";

/** Operational response is an allowlist: added financial properties stay private. */
export function inventoryMovementForRead(movement: InventoryMovement, pricesAllowed: boolean) {
  if (pricesAllowed) return movement;
  return {
    id: movement.id, itemId: movement.itemId, kind: movement.kind, qty: movement.qty,
    expiryDate: movement.expiryDate, reason: movement.reason, visitId: movement.visitId,
    createdBy: movement.createdBy, createdAt: movement.createdAt, isReturn: movement.isReturn,
  };
}
