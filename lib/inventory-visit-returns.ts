import {
  createInventoryMovementInTransaction,
  ensureSchema,
  getPool,
  type DbClient,
  type InventoryMovement,
} from "./db";
import { quantityAtoms } from "./inventory-domain/quantities";
import { withTransaction } from "./transactions";

export interface VisitMaterialReturnLine {
  id: number;
  itemId: number;
  itemName: string;
  unit: string;
  qty: number;
  reason: string | null;
  createdBy: string;
  createdAt: string;
}

export async function listVisitMaterialReturnsWith(q: Pick<DbClient, "query">, visitId: number): Promise<VisitMaterialReturnLine[]> {
  const { rows } = await q.query<{
    id: number;
    item_id: number;
    item_name: string;
    unit: string;
    qty: string;
    reason: string | null;
    created_by: string;
    created_at: Date;
  }>(
    `SELECT m.id, m.item_id, i.name AS item_name, i.unit, m.qty, m.reason, m.created_by, m.created_at
       FROM inventory_movements m
       JOIN inventory_items i ON i.id = m.item_id
      WHERE m.visit_id = $1 AND m.kind = 'in' AND m.is_return = TRUE
      ORDER BY m.id`,
    [visitId],
  );
  return rows.map((row) => ({
    id: row.id,
    itemId: row.item_id,
    itemName: row.item_name,
    unit: row.unit,
    qty: Number(row.qty),
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function listVisitMaterialReturns(visitId: number): Promise<VisitMaterialReturnLine[]> {
  await ensureSchema();
  return listVisitMaterialReturnsWith(getPool(), visitId);
}

export type ReturnVisitMaterialResult =
  | { ok: true; movement: InventoryMovement; balance: number }
  | { ok: false; status: 400 | 404 | 409; message: string };

export async function returnVisitMaterialInTransaction(client: DbClient, input: {
  visitId: number;
  itemId: number;
  qty: number;
  reason?: string | null;
  createdBy: string;
}): Promise<ReturnVisitMaterialResult> {
  let requestedAtoms: bigint;
  try {
    requestedAtoms = quantityAtoms(String(input.qty));
  } catch {
    return { ok: false, status: 400, message: "الكمية المطلوب ردّها غير صالحة." };
  }
  if (requestedAtoms <= 0n) {
    return { ok: false, status: 400, message: "اكتب كمية أكبر من صفر لردّها للمخزن." };
  }

  const { rows: visitRows } = await client.query<{ id: number; patient_id: number | null }>(
    `SELECT id, patient_id FROM visits WHERE id = $1 FOR SHARE`,
    [input.visitId],
  );
  const visit = visitRows[0];
  if (!visit) {
    return { ok: false, status: 404, message: "الزيارة غير موجودة." };
  }

  const { rows: itemRows } = await client.query<{ id: number }>(
    `SELECT id FROM inventory_items WHERE id = $1 FOR UPDATE`,
    [input.itemId],
  );
  if (!itemRows[0]) {
    return { ok: false, status: 404, message: "بند المخزون غير موجود." };
  }

  const { rows: movRows } = await client.query<{ kind: string; is_return: boolean; qty: string }>(
    `SELECT kind, COALESCE(is_return, FALSE) AS is_return, qty::text AS qty
       FROM inventory_movements
      WHERE visit_id = $1 AND item_id = $2
      FOR UPDATE`,
    [input.visitId, input.itemId],
  );

  let netConsumedAtoms = 0n;
  for (const row of movRows) {
    const atoms = quantityAtoms(row.qty);
    if (row.kind === "out") {
      netConsumedAtoms += atoms;
    } else if (row.kind === "in" && row.is_return) {
      netConsumedAtoms -= atoms;
    }
  }

  if (netConsumedAtoms <= 0n) {
    return { ok: false, status: 409, message: "لا توجد كمية مصروفة متبقية من هذه المادة على الزيارة لردّها." };
  }
  if (requestedAtoms > netConsumedAtoms) {
    return { ok: false, status: 409, message: "الكمية المطلوب ردّها تتجاوز صافي ما صُرف على هذه الزيارة." };
  }

  const cleanNote = typeof input.reason === "string" ? input.reason.trim() : "";
  const movementReason = cleanNote
    ? `ردّ مادة من الزيارة — ${cleanNote}`.slice(0, 300)
    : "ردّ مادة فائضة من الزيارة";

  const result = await createInventoryMovementInTransaction(client, {
    itemId: input.itemId,
    kind: "in",
    isReturn: true,
    qty: input.qty,
    visitId: input.visitId,
    patientId: visit.patient_id,
    reason: movementReason,
    createdBy: input.createdBy,
  });
  if (!result.ok) {
    return { ok: false, status: 409, message: result.message };
  }
  return { ok: true, movement: result.movement, balance: result.balance };
}

export async function returnVisitMaterial(input: {
  visitId: number;
  itemId: number;
  qty: number;
  reason?: string | null;
  createdBy: string;
}): Promise<ReturnVisitMaterialResult> {
  await ensureSchema();
  let requestedAtoms: bigint;
  try {
    requestedAtoms = quantityAtoms(String(input.qty));
  } catch {
    return { ok: false, status: 400, message: "الكمية المطلوب ردّها غير صالحة." };
  }
  if (requestedAtoms <= 0n) {
    return { ok: false, status: 400, message: "اكتب كمية أكبر من صفر لردّها للمخزن." };
  }

  return withTransaction(getPool(), (client) => returnVisitMaterialInTransaction(client, input));
}
