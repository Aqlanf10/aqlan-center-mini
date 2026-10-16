import { ensureSchema, getPool, getInventoryItemDetail } from "../db";
import type { CostedMovement } from "../inventoryCost";
import { inventoryValuation, type Valuation } from "./valuation";

/** New inventory read boundary; old supplier/payable links remain unchanged. */
export async function inventoryDetailWithLinks(id: number) {
  const detail = await getInventoryItemDetail(id);
  if (!detail) return null;
  const { rows } = await getPool().query<{ id: number; party_id: number | null; payable_id: number | null }>(
    "SELECT id, party_id, payable_id FROM inventory_movements WHERE item_id = $1", [id],
  );
  const links = new Map(rows.map(row => [row.id, row]));
  return { ...detail, movements: detail.movements.map(movement => ({
    ...movement, partyId: links.get(movement.id)?.party_id ?? null,
    payableId: links.get(movement.id)?.payable_id ?? null,
  })) };
}

export interface ValuedInventoryItem extends Valuation {
  id: number; name: string; category: string; unit: string;
}
export async function readInventoryValuation() {
  await ensureSchema();
  const { rows } = await getPool().query<{
    id: number; name: string; category: string; unit: string; kind: CostedMovement["kind"];
    qty: string; unit_cost_minor: string | null; is_return: boolean | null;
  }>(`SELECT i.id, i.name, i.category, i.unit, m.kind, m.qty, m.unit_cost_minor, m.is_return
      FROM inventory_items i JOIN inventory_movements m ON m.item_id = i.id
      WHERE i.is_active ORDER BY i.id, m.id`);
  const grouped = new Map<number, { meta: Pick<ValuedInventoryItem, "id" | "name" | "category" | "unit">; movements: CostedMovement[] }>();
  for (const row of rows) {
    const entry = grouped.get(row.id) ?? { meta: { id: row.id, name: row.name, category: row.category, unit: row.unit }, movements: [] };
    entry.movements.push({ kind: row.kind, qty: Number(row.qty), unitCostMinor: row.unit_cost_minor === null ? null : Number(row.unit_cost_minor), isReturn: Boolean(row.is_return) });
    grouped.set(row.id, entry);
  }
  const items: ValuedInventoryItem[] = [...grouped.values()].map(entry => ({ ...entry.meta, ...inventoryValuation(entry.movements) }));
  items.sort((a, b) => (b.valueMinor ?? -1) - (a.valueMinor ?? -1) || a.id - b.id);
  const withoutCost = items.filter(item => item.qty !== 0 && item.costStatus === "missing").length;
  const estimated = items.filter(item => item.qty !== 0 && item.costStatus === "estimated").length;
  const knownTotalMinor = items.filter(item => item.costStatus === "known").reduce((total, item) => total + (item.valueMinor ?? 0), 0);
  if (!Number.isSafeInteger(knownTotalMinor)) throw new Error("inventory_value_overflow");
  return { items, withoutCost, estimated, knownTotalMinor, totalMinor: withoutCost || estimated ? null : knownTotalMinor };
}
