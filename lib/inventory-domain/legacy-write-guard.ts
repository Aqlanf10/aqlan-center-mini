import type { DbClient } from "../db";

/** Temporary safety boundary, not the lot-aware operational stock adapter. */
export class InventoryTrackingRequired extends Error {
  readonly code = "inventory_tracking_required";
  constructor() {
    super("هذه المادة متتبعة بالدفعة والموقع. تعذّر تنفيذ الحركة القديمة قبل اكتمال ربط الصرف المتتبع؛ لم تُحفظ العملية.");
    this.name = "InventoryTrackingRequired";
  }
}

export class InventoryBusy extends Error {
  readonly code = "inventory_busy";
  constructor() {
    super("توجد عملية مخزون متزامنة. لم تُحفظ الزيارة أو الفاتورة؛ احتفظ بالمدخلات وأعد المحاولة بعد اكتمال العملية.");
    this.name = "InventoryBusy";
  }
}

export class InventorySchemaNotReady extends Error {
  readonly code = "inventory_schema_not_ready";
  constructor() {
    super("تعذّر التحقق من جاهزية تتبع المخزون. لم تُحفظ العملية.");
    this.name = "InventorySchemaNotReady";
  }
}

// This server writer helper intentionally has no runtime import from db.ts.
// Non-exact/off values return before even inspecting proposal-table readiness.
export function legacyInventoryGuardEnabled(): boolean {
  return process.env.INVENTORY_INTEGRATION_ENABLED === "true";
}

/** Caller already holds all item locks. This MUST be a separate awaited query
 * after acquiring them, so a first lot committed during the lock wait is visible. */
export async function legacyInventoryWriteRefusal(client: DbClient, itemIds: number[]): Promise<InventoryTrackingRequired | null> {
  if (!legacyInventoryGuardEnabled() || itemIds.length === 0) return null;
  const schema = await client.query<{ ready: boolean }>("SELECT to_regclass('stock_lots') IS NOT NULL AS ready");
  if (!schema.rows[0]?.ready) throw new InventorySchemaNotReady();
  const tracked = await client.query<{ tracked: boolean }>("SELECT EXISTS(SELECT 1 FROM stock_lots WHERE item_id=ANY($1::int[])) AS tracked", [itemIds]);
  return tracked.rows[0]?.tracked ? new InventoryTrackingRequired() : null;
}

/** Signing already holds clinical locks. Until the universal adapter uses one
 * lock order, never wait here while custody may hold an item and need a visit.
 * No automatic retry: 55P03 becomes an explicit rollback/refusal, all other
 * database failures retain their original identity. */
export async function guardLegacyClinicalMaterials(client: DbClient, itemIds: number[]): Promise<void> {
  if (!legacyInventoryGuardEnabled() || itemIds.length === 0) return;
  const ids = [...new Set(itemIds)].sort((a, b) => a - b);
  try {
    await client.query("SELECT id FROM inventory_items WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE NOWAIT", [ids]);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "55P03") throw new InventoryBusy();
    throw error;
  }
  const refusal = await legacyInventoryWriteRefusal(client, ids);
  if (refusal) throw refusal;
}
