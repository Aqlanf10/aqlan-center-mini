import { canonicalPurchaseRequest, INVENTORY_PURCHASE_PROTOCOL, isPurchaseKey, purchaseEnvelope, normalizePurchaseReason } from "./inventory-purchase-protocol";
import { validateMovement } from "./inventory";
import { CLINIC_BASE_CURRENCY, parseAmount } from "./money";
import { quantityAtoms, QUANTITY_SCALE } from "./inventory-domain/quantities";
import { proportionalCostMinor } from "./inventory-domain/treatment-cost";

/** Browser recovery identity, never authentication or financial authority. */
export interface PurchaseCommand {
  actor: string;
  actorUserId: number;
  itemId: number;
  key: string;
  body: string;
  digest: string;
}
export interface PurchaseAcknowledgment {
  status: "committed";
  actorUserId: number;
  requestKey: string;
  requestDigest: string;
  itemId: number;
  movementId: number;
  replayed: boolean;
  payableCreated: boolean;
  balance: number;
}
export interface PurchaseRejection {
  status: "rejected";
  actorUserId: number;
  requestKey: string;
  requestDigest: string;
  itemId: number;
  replayed: boolean;
  message: string;
}
export type PurchaseReceipt = PurchaseAcknowledgment | PurchaseRejection;
export const PURCHASE_UNCERTAIN = "لم يصل تأكيد موثوق للشراء. قد يكون سُجّل؛ أعد محاولة الطلب المحفوظ نفسه، ولا تُسجّل شراءً بديلًا أو تمسح بيانات المتصفح.";
export const PURCHASE_STORAGE_ERROR = "تعذّر حفظ أو قراءة طلب الشراء بأمان في هذا المتصفح. لم يبدأ إرسال طلب جديد؛ أعد المحاولة دون مسح بيانات المتصفح.";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (value: unknown) => {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/** Catch ordinary input mistakes before reserving an immutable command. The
 * server repeats all checks, including mutable item/supplier eligibility. */
export function purchaseInputError(purchase: Record<string, unknown>): string | null {
  if (purchase.kind !== "in" || purchase.isReturn === true) return "هذا المسار مخصّص لشراء المخزون فقط.";
  const qty = Number(purchase.qty);
  const check = validateMovement("in", qty, null, 0);
  if (!check.ok) return check.message ?? "اكتب كمية صحيحة.";
  if (qty > 1_000_000) return "الكمية خارج المدى المعقول.";
  let price: number | null = null;
  if (purchase.unitCost !== undefined && purchase.unitCost !== null && purchase.unitCost !== "") {
    if (typeof purchase.unitCost !== "string" || !purchase.unitCost.trim()) return "ثمن الوحدة رقمٌ غير صالح.";
    price = parseAmount(purchase.unitCost, CLINIC_BASE_CURRENCY);
    if (price === null) return "ثمن الوحدة رقمٌ غير صالح.";
    try { proportionalCostMinor(price, Number(quantityAtoms(String(qty))), Number(QUANTITY_SCALE)); }
    catch { return "قيمة الشراء تتجاوز المدى المالي الآمن."; }
  }
  const supplier = purchase.supplierPartyId;
  if (supplier !== undefined && supplier !== null && supplier !== "") {
    const id = typeof supplier === "number" ? supplier : typeof supplier === "string" && /^\d+$/.test(supplier) ? Number(supplier) : NaN;
    if (!positiveId(id) || id > 2_147_483_647) return "رقم المورّد غير صالح.";
    if (price === null || price <= 0) return "اكتب ثمن الوحدة لتُسجَّل فاتورة المورّد.";
  }
  for (const date of [purchase.expiryDate, purchase.supplierDueDate]) {
    if (date !== undefined && date !== null && date !== "" && !validDate(date)) return "اكتب تاريخًا صحيحًا.";
  }
  if (normalizePurchaseReason(purchase.reason)?.includes("\u0000")) return "الملاحظة تحتوي على محرف غير صالح؛ احذفه قبل الشراء.";
  if (normalizePurchaseReason(purchase.reason)?.startsWith("خصم تلقائي —")) return "هذا الوسم محجوز للخصم التلقائي؛ اكتب سببًا آخر.";
  return null;
}

export function purchaseDocument(body: string): Record<string, unknown> | null {
  try {
    return purchaseEnvelope(JSON.parse(body));
  } catch { return null; }
}
export async function purchaseDigest(itemId: number, purchase: Record<string, unknown>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalPurchaseRequest(itemId, purchase)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function createPurchaseCommand(actor: string, actorUserId: number, itemId: number, purchase: Record<string, unknown>): Promise<PurchaseCommand> {
  // Serialize before hashing: omitted undefined properties are not submitted.
  const body = JSON.stringify({ protocol: INVENTORY_PURCHASE_PROTOCOL, purchase });
  const document = purchaseDocument(body);
  if (!actor || !positiveId(actorUserId) || !positiveId(itemId) || !document) throw new Error("Invalid purchase command");
  return { actor, actorUserId, itemId, body, key: crypto.randomUUID(), digest: await purchaseDigest(itemId, document) };
}
export function isPurchaseCommand(value: unknown): value is PurchaseCommand {
  if (!object(value)) return false;
  return typeof value.actor === "string" && value.actor.length > 0 && value.actor.length <= 200
    && positiveId(value.actorUserId) && positiveId(value.itemId) && isPurchaseKey(value.key) && typeof value.body === "string"
    && value.body.length > 0 && value.body.length <= 1024 * 1024 && purchaseDocument(value.body) !== null
    && typeof value.digest === "string" && /^[a-f0-9]{64}$/.test(value.digest);
}
export async function verifyPurchaseCommand(command: PurchaseCommand): Promise<boolean> {
  if (!isPurchaseCommand(command)) return false;
  return command.digest === await purchaseDigest(command.itemId, purchaseDocument(command.body)!);
}

/** Only a matching committed receipt can retire browser recovery. Deliberately
 * return no financial/supplier fields from the projected movement. */
export function readPurchaseAcknowledgment(payload: unknown, command: PurchaseCommand): PurchaseAcknowledgment | null {
  if (!object(payload) || payload.protocol !== INVENTORY_PURCHASE_PROTOCOL || payload.status !== "committed"
    || payload.actorUserId !== command.actorUserId || payload.requestKey !== command.key || payload.requestDigest !== command.digest || payload.itemId !== command.itemId
    || !positiveId(payload.movementId) || typeof payload.replayed !== "boolean" || typeof payload.payableCreated !== "boolean"
    || !object(payload.result) || payload.result.ok !== true || typeof payload.result.balance !== "number" || !Number.isFinite(payload.result.balance)
    || !object(payload.result.movement)) return null;
  const movement = payload.result.movement, purchase = purchaseDocument(command.body);
  if (!purchase || movement.id !== payload.movementId || movement.itemId !== command.itemId || movement.kind !== "in"
    || movement.qty !== Number(purchase.qty) || movement.isReturn !== false || movement.createdBy !== command.actor
    || movement.visitId !== null || typeof movement.createdAt !== "string" || !Number.isFinite(Date.parse(movement.createdAt))
    || !(movement.expiryDate === null || typeof movement.expiryDate === "string" && DATE.test(movement.expiryDate))
    || !(movement.reason === null || typeof movement.reason === "string")) return null;
  const expectedExpiry = typeof purchase.expiryDate === "string" && DATE.test(purchase.expiryDate) ? purchase.expiryDate : null;
  const expectedReason = normalizePurchaseReason(purchase.reason);
  if (movement.expiryDate !== expectedExpiry || movement.reason !== expectedReason) return null;
  const expectedPayable = purchase.supplierPartyId !== undefined && purchase.supplierPartyId !== null && purchase.supplierPartyId !== "";
  if (payload.payableCreated !== expectedPayable) return null;
  const financeFields = ["unitCostMinor", "partyId", "payableId"] as const;
  if (financeFields.some(field => Object.prototype.hasOwnProperty.call(movement, field))) {
    // Reception may omit the complete financial projection. If any admin
    // fields are supplied, all must agree with the acknowledged command.
    if (!financeFields.every(field => Object.prototype.hasOwnProperty.call(movement, field))) return null;
    const expectedPrice = typeof purchase.unitCost === "string" && purchase.unitCost.trim()
      ? parseAmount(purchase.unitCost, CLINIC_BASE_CURRENCY) : null;
    const expectedSupplier = expectedPayable ? Number(purchase.supplierPartyId) : null;
    if (movement.unitCostMinor !== expectedPrice || movement.partyId !== expectedSupplier
      || (expectedPayable ? !positiveId(movement.payableId) : movement.payableId !== null)) return null;
  }
  return { status: "committed", actorUserId: command.actorUserId, requestKey: command.key, requestDigest: command.digest, itemId: command.itemId, movementId: payload.movementId,
    replayed: payload.replayed, payableCreated: payload.payableCreated, balance: payload.result.balance };
}

/** A terminal rejection is authoritative only because the server persists it
 * under the same key lock before returning this matching envelope. */
export function readPurchaseReceipt(payload: unknown, command: PurchaseCommand): PurchaseReceipt | null {
  const committed = readPurchaseAcknowledgment(payload, command);
  if (committed) return committed;
  if (!object(payload) || payload.protocol !== INVENTORY_PURCHASE_PROTOCOL || payload.status !== "rejected"
    || payload.actorUserId !== command.actorUserId || payload.requestKey !== command.key || payload.requestDigest !== command.digest || payload.itemId !== command.itemId
    || typeof payload.replayed !== "boolean" || typeof payload.message !== "string" || !payload.message.trim()
    || payload.message.length > 2000 || "movementId" in payload || "result" in payload || "payableCreated" in payload) return null;
  return { status: "rejected", actorUserId: command.actorUserId, requestKey: command.key, requestDigest: command.digest, itemId: command.itemId,
    replayed: payload.replayed, message: payload.message };
}
