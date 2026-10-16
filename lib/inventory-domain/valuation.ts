import { costStates, type CostedMovement } from "../inventoryCost";
import { signedQty } from "../inventory";

export type ValuationStatus = "known" | "estimated" | "missing";
export interface Valuation {
  qty: number;
  valueMinor: number | null;
  unitCostMinor: number | null;
  costStatus: ValuationStatus;
}

/** Read-only completeness overlay. Never rewrites historical WAC/commission events.
 * An unknown purchase taints the pooled WAC until exhausted. It cannot inherit a
 * previous purchase price. Unlinked legacy returns are estimates, not proven
 * original-issue reversals. A recorded zero purchase price remains a known zero.
 */
export function inventoryValuation(movements: readonly CostedMovement[]): Valuation {
  const states = costStates(movements);
  let status: ValuationStatus = "known";
  for (let i = 0; i < movements.length; i++) {
    const movement = movements[i];
    if (!Number.isFinite(movement.qty)) throw new Error("invalid_inventory_quantity");
    const change = signedQty(movement.kind, movement.qty);
    if (change > 0) {
      const priced = movement.kind === "in" && !movement.isReturn
        && typeof movement.unitCostMinor === "number"
        && Number.isFinite(movement.unitCostMinor) && movement.unitCostMinor >= 0;
      if (!priced) {
        if (movement.isReturn && i > 0 && states[i - 1].qty > 0 && status !== "missing") status = "estimated";
        else status = "missing";
      }
    }
    if (states[i].qty === 0) status = "known";
    if (states[i].qty < 0) status = "missing";
  }
  const state = states.at(-1) ?? { qty: 0, valueMinor: 0, unitCostMinor: null };
  if (!Number.isFinite(state.valueMinor) || state.valueMinor > Number.MAX_SAFE_INTEGER) throw new Error("inventory_value_overflow");
  return {
    qty: state.qty,
    valueMinor: status === "missing" ? null : Math.round(state.valueMinor),
    unitCostMinor: status === "missing" ? null : state.unitCostMinor,
    costStatus: status,
  };
}
