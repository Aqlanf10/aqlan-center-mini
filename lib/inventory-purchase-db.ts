import { PURCHASE_RESET_FENCE } from "./clinic-reset";
import { createHash } from "node:crypto";
import {
  createInventoryMovementInTransaction, ensureSchema, getPool,
  type InventoryMovement, type InventoryMovementInput,
} from "./db";
import type { SessionPayload } from "./auth";
import { revalidateSessionInTransaction } from "./session";
import { canHandleMoney, canManageInventory, isAdmin } from "./roles";
import { withTransaction } from "./transactions";
import { inventoryMovementForRead } from "./inventory-domain/presentation";
import {
  canonicalPurchaseRequest, INVENTORY_PURCHASE_PROTOCOL, isPurchaseKey, isPurchaseRecord,
} from "./inventory-purchase-protocol";

type Rejection = { message: string; httpStatus: 400 | 404 | 409 };
type Snapshot = { movement: InventoryMovement; balance: number };
type ReceiptRow = {
  actor_user_id: number; fingerprint_version: number; request_digest: string;
  outcome: "committed" | "rejected"; movement_id: number | null; result_version: number;
  result_snapshot: unknown;
};
type Command = {
  session: SessionPayload; requestKey: string; itemId: number; purchase: Record<string, unknown>;
} & ({ input: InventoryMovementInput; rejection?: never } | { input?: never; rejection: Rejection });

const conflict = { httpStatus: 409, body: { message: "تعارض في هوية طلب الشراء. احتفظ بالطلب المحفوظ وراجع الإدارة." } };
const denied = { httpStatus: 401, body: { message: "انتهت الجلسة. سجّل الدخول من جديد." } };
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nullableId = (value: unknown) => value === null || integer(value);
const nullableString = (value: unknown) => value === null || typeof value === "string";

/** Fail closed on an invalid stored receipt; never fall through into a new write. */
function snapshot(value: unknown, movementId: number): Snapshot {
  if (!isPurchaseRecord(value) || Object.keys(value).sort().join(",") !== "balance,movement"
    || typeof value.balance !== "number" || !Number.isFinite(value.balance) || !isPurchaseRecord(value.movement)) {
    throw new Error("Invalid stored purchase receipt");
  }
  const movement = value.movement;
  const names = ["id","itemId","kind","qty","expiryDate","reason","visitId","createdBy","createdAt","unitCostMinor","isReturn","partyId","payableId"];
  if (Object.keys(movement).sort().join(",") !== names.sort().join(",")
    || movement.id !== movementId || !integer(movement.itemId) || movement.kind !== "in"
    || typeof movement.qty !== "number" || !Number.isFinite(movement.qty) || movement.qty <= 0
    || !nullableString(movement.expiryDate) || !nullableString(movement.reason) || movement.visitId !== null
    || typeof movement.createdBy !== "string" || typeof movement.createdAt !== "string"
    || !Number.isFinite(Date.parse(movement.createdAt)) || movement.isReturn !== false
    || !(movement.unitCostMinor === null || typeof movement.unitCostMinor === "number" && Number.isSafeInteger(movement.unitCostMinor) && movement.unitCostMinor >= 0)
    || !nullableId(movement.partyId) || !nullableId(movement.payableId)) throw new Error("Invalid stored purchase movement");
  return {
    balance: value.balance,
    movement: { ...movement, createdAt: new Date(movement.createdAt) } as unknown as InventoryMovement,
  };
}

function rejectionSnapshot(value: unknown): Rejection {
  if (!isPurchaseRecord(value) || Object.keys(value).sort().join(",") !== "httpStatus,message"
    || typeof value.message !== "string" || !value.message || value.message.length > 500
    || ![400,404,409].includes(value.httpStatus as number)) throw new Error("Invalid stored purchase refusal");
  return value as Rejection;
}

function allowlistedSnapshot(result: Snapshot): Snapshot {
  const m = result.movement;
  return { balance: result.balance, movement: {
    id: m.id, itemId: m.itemId, kind: m.kind, qty: m.qty, expiryDate: m.expiryDate,
    reason: m.reason, visitId: m.visitId, createdBy: m.createdBy, createdAt: m.createdAt,
    unitCostMinor: m.unitCostMinor, isReturn: m.isReturn, partyId: m.partyId ?? null, payableId: m.payableId ?? null,
  } };
}

/** One durable outcome per key. A terminal refusal is also retained: merely
 * observing absence cannot safely retire a request that is still in transit.
 * Current authentication always precedes both replay and business validation. */
export async function createInventoryPurchase(command: Command) {
  if (!isPurchaseKey(command.requestKey)) throw new Error("Invalid purchase key");
  const requestKey = command.requestKey.toLowerCase();
  const requestDigest = createHash("sha256").update(canonicalPurchaseRequest(command.itemId, command.purchase)).digest("hex");
  await ensureSchema();
  return withTransaction(getPool(), async client => {
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [PURCHASE_RESET_FENCE]);
    const session = await revalidateSessionInTransaction(command.session, client);
    if (!session || !canManageInventory(session.role)) return denied;
    if (command.input?.supplierPartyId != null && !canHandleMoney(session.role)) return denied;
    // Lock namespace is distinct from inventory item and other financial keys.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`inventory-purchase:${requestKey}`]);
    const { rows: [receipt] } = await client.query<ReceiptRow>(
      `SELECT actor_user_id, fingerprint_version, request_digest, outcome, movement_id, result_version, result_snapshot
       FROM inventory_purchase_receipts WHERE request_key=$1::uuid`, [requestKey],
    );
    const identity = { protocol: INVENTORY_PURCHASE_PROTOCOL, requestKey, requestDigest, itemId: command.itemId, actorUserId: session.userId };
    const response = (outcome: "committed" | "rejected", data: unknown, movementId: number | null, replayed: boolean) => {
      if (outcome === "rejected") {
        const rejected = rejectionSnapshot(data);
        return { httpStatus: rejected.httpStatus, body: { ...identity, status: "rejected" as const, replayed, message: rejected.message } };
      }
      if (!movementId) throw new Error("Missing committed purchase movement");
      const original = snapshot(data, movementId);
      if (original.movement.itemId !== command.itemId) throw new Error("Mismatched stored purchase item");
      return {
        httpStatus: 201,
        body: { ...identity, status: "committed" as const, replayed, movementId,
          payableCreated: original.movement.payableId !== null,
          result: { ok: true as const, balance: original.balance, movement: inventoryMovementForRead(original.movement, isAdmin(session.role)) } },
      };
    };
    if (receipt) {
      if (receipt.actor_user_id !== session.userId || receipt.fingerprint_version !== 1
        || receipt.result_version !== 1 || receipt.request_digest !== requestDigest) return conflict;
      return response(receipt.outcome, receipt.result_snapshot, receipt.movement_id, true);
    }
    let result: Snapshot | Rejection;
    let outcome: "committed" | "rejected";
    let movementId: number | null = null;
    if (command.rejection) {
      outcome = "rejected"; result = rejectionSnapshot(command.rejection);
    } else {
      if (command.input.itemId !== command.itemId || command.input.kind !== "in" || command.input.isReturn
        || command.input.patientId != null || command.input.visitId != null) throw new Error("Unsupported keyed purchase");
      const written = await createInventoryMovementInTransaction(client, { ...command.input, createdBy: session.username });
      if (!written.ok) {
        outcome = "rejected"; result = { httpStatus: 409, message: written.message };
      } else {
        outcome = "committed"; movementId = written.movement.id; result = allowlistedSnapshot(written);
      }
    }
    // Snapshot only, never request JSON. Receipt, stock, payable and audit share
    // this transaction and its single COMMIT; an insert failure rolls back all.
    const encoded = JSON.stringify(result);
    await client.query(
      `INSERT INTO inventory_purchase_receipts
       (request_key,actor_user_id,fingerprint_version,request_digest,outcome,movement_id,result_version,result_snapshot)
       VALUES ($1::uuid,$2,1,$3,$4,$5,1,$6::jsonb)`,
      [requestKey, session.userId, requestDigest, outcome, movementId, encoded],
    );
    return response(outcome, JSON.parse(encoded), movementId, false);
  });
}
