/** Dormant procurement/custody recovery protocol. Never authentication, a stock
 * ledger, or a replacement for the server's actor-scoped operation journal. */
export const INVENTORY_RECOVERY_PROTOCOL = "inventory-command-v1";
export const INVENTORY_RECOVERY_UNCERTAIN = "تعذّر تأكيد النتيجة. أعد تأكيد العملية المحفوظة نفسها؛ لا تنشئ عملية بديلة أو تمسح بيانات المتصفح.";
export const INVENTORY_RECOVERY_STORAGE = "تعذّر حفظ أو قراءة العملية بأمان. لم يبدأ إرسال طلب جديد؛ أعد تحميل الصفحة دون مسح بيانات المتصفح.";
export const INVENTORY_RECOVERY_CHANGED = "تغيّرت العملية المحفوظة في نافذة أخرى. أعد تحميل الصفحة وراجع العملية قبل المتابعة.";
export const INVENTORY_RECOVERY_SESSION = "تغيّرت الجلسة أو تعذّر التحقق منها. سجّل الدخول بالحساب الذي بدأ العملية لاستعادتها.";
export type InventoryWorkspace = "requests" | "administration" | "operations" | "custody";
export interface InventoryCommandScope { actor: string; actorUserId: number; workspace: InventoryWorkspace }
export interface InventoryRecoveryCommand extends InventoryCommandScope { key: string; body: string; digest: string }
export interface InventoryRecoveryAcknowledgement { protocol: typeof INVENTORY_RECOVERY_PROTOCOL; actorUserId: number; key: string; digest: string; status: "committed" }
export const inventoryRecoveryRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keyPattern = /^[A-Za-z0-9_.:-]{8,120}$/;
export const isInventoryOperationKey = (value: unknown): value is string => typeof value === "string" && keyPattern.test(value);
export const isInventoryRecoveryDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const commands = new Set(["request.submit", "request.revise", "request.approve", "order.issue", "order.amend", "receipt.post", "quarantine.resolve", "invoice.match", "legacy.reconcile", "custody.dispatch", "custody.acknowledge", "custody.consume", "custody.return_to_store", "custody.stocktake", "custody.close_package", "custody.propose_settlement", "custody.object_settlement", "custody.approve_waste"]);
export function isInventoryCommandScope(value: unknown): value is InventoryCommandScope {
  return inventoryRecoveryRecord(value) && typeof value.actor === "string" && value.actor.length > 0 && value.actor.length <= 200
    && Number.isSafeInteger(value.actorUserId) && Number(value.actorUserId) > 0
    && ["requests", "administration", "operations", "custody"].includes(String(value.workspace));
}
/** Exact JSON values with deterministic object ordering. Presence and types are
 * significant; never coerce currencies, quantities, IDs or mutable prices. */
export function inventoryRecoveryIdentity(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(inventoryRecoveryIdentity).join(",")}]`;
  if (inventoryRecoveryRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${inventoryRecoveryIdentity(value[key])}`).join(",")}}`;
  throw new Error("Invalid inventory recovery JSON");
}
export function inventoryRecoveryDocument(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return inventoryRecoveryRecord(value) && typeof value.command === "string" && commands.has(value.command)
      && isInventoryOperationKey(value.operationKey) ? value : null;
  } catch { return null; }
}
export async function inventoryRecoveryDigest(document: Record<string, unknown>): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(inventoryRecoveryIdentity(document)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function createInventoryRecoveryCommand(scope: InventoryCommandScope, command: string, input: Record<string, unknown>): Promise<InventoryRecoveryCommand> {
  if (!isInventoryCommandScope(scope) || !commands.has(command) || "command" in input || "operationKey" in input) throw new Error("Invalid inventory recovery command");
  // Copy synchronously, before any awaited work: later edits cannot alter this send.
  const key = crypto.randomUUID(), body = JSON.stringify({ ...input, command, operationKey: key });
  if (new TextEncoder().encode(body).length > 256 * 1024) throw new Error("Inventory recovery command too large");
  return { ...scope, key, body, digest: await inventoryRecoveryDigest(JSON.parse(body)) };
}
export function isInventoryRecoveryCommand(value: unknown): value is InventoryRecoveryCommand {
  if (!isInventoryCommandScope(value)) return false;
  const row = value as InventoryRecoveryCommand;
  if (!isInventoryOperationKey(row.key) || !isInventoryRecoveryDigest(row.digest) || typeof row.body !== "string" || !row.body || row.body.length > 256 * 1024) return false;
  return inventoryRecoveryDocument(row.body)?.operationKey === row.key;
}
export async function verifyInventoryRecoveryCommand(value: InventoryRecoveryCommand): Promise<boolean> {
  return isInventoryRecoveryCommand(value) && value.digest === await inventoryRecoveryDigest(inventoryRecoveryDocument(value.body)!);
}
export function readInventoryRecoveryAcknowledgement(payload: unknown, command: InventoryRecoveryCommand): Record<string, unknown> | null {
  if (!inventoryRecoveryRecord(payload) || !inventoryRecoveryRecord(payload.recovery) || typeof payload.replayed !== "boolean") return null;
  const ack = payload.recovery;
  if (ack.protocol !== INVENTORY_RECOVERY_PROTOCOL || ack.status !== "committed" || ack.actorUserId !== command.actorUserId || ack.key !== command.key || ack.digest !== command.digest) return null;
  return payload;
}

export const inventoryRecoveryEnglish: Record<string, string> = {
  [INVENTORY_RECOVERY_UNCERTAIN]: "The result is unconfirmed. Re-confirm the saved operation itself; do not create a replacement or clear browser data.",
  [INVENTORY_RECOVERY_STORAGE]: "The operation could not be stored or read safely. No new request was sent; reload without clearing browser data.",
  [INVENTORY_RECOVERY_CHANGED]: "The saved operation changed in another window. Reload and review it before continuing.",
  [INVENTORY_RECOVERY_SESSION]: "The session changed or could not be verified. Sign in as the account that started this operation to recover it.",
  "تعذّر تجهيز العملية. راجع المدخلات وحاول مرة أخرى.": "The operation could not be prepared. Check the inputs and try again.",
  "تم تأكيد العملية المحفوظة. راجع سجل العهدة لمعرفة أثرها.": "The saved operation was confirmed. Review the custody record for its effect.",
};
const titles: Record<string, [string, string]> = {
  "request.submit": ["طلب شراء", "Purchase request"], "request.revise": ["تعديل طلب شراء", "Purchase request revision"],
  "request.approve": ["قرار طلب شراء", "Purchase request decision"], "order.issue": ["أمر شراء", "Purchase order"], "order.amend": ["تعديل أمر شراء", "Purchase order amendment"],
  "receipt.post": ["استلام مواد", "Goods receipt"], "quarantine.resolve": ["قرار فحص المواد المحجورة", "Quarantine decision"], "invoice.match": ["مطابقة فاتورة مورد", "Supplier invoice match"],
  "legacy.reconcile": ["تخصيص المخزون التاريخي", "Historical stock allocation"], "custody.dispatch": ["تحويل عهدة", "Custody transfer"], "custody.acknowledge": ["إقرار استلام عهدة", "Custody acknowledgement"],
  "custody.consume": ["استهلاك عهدة", "Custody consumption"], "custody.return_to_store": ["إرجاع عهدة إلى المخزن", "Custody return to store"], "custody.stocktake": ["جرد عهدة", "Custody stocktake"],
  "custody.close_package": ["إغلاق عبوة", "Package closure"], "custody.propose_settlement": ["اقتراح مراجعة تسوية عهدة", "Custody settlement review proposal"],
  "custody.object_settlement": ["اعتراض على تسوية عهدة", "Custody settlement objection"], "custody.approve_waste": ["اعتماد هالك عهدة", "Custody waste approval"],
};
/** Read-only human summary of the exact saved command, not today's form values.
 * No financial total is inferred from quantities, quotes or service labels. */
export function describeInventoryRecoveryCommand(command: InventoryRecoveryCommand | null, locale: "ar" | "en"): string {
  if (!command) return "";
  const body = inventoryRecoveryDocument(command.body);
  if (!body) return "";
  const english = locale === "en";
  let title = titles[String(body.command)]?.[english ? 1 : 0] ?? "";
  const document = Object.values(body).find(inventoryRecoveryRecord);
  if (!document) return title;
  if (body.command === "custody.consume" && document.kind === "approved_waste") title = english ? "Approved custody waste" : "هالك عهدة معتمد";
  const values = [english ? `Saved operation: ${title}` : `العملية المحفوظة: ${title}`];
  const reference = document.id ?? document.requestId ?? document.orderId;
  if (typeof reference === "string") values.push(`${english ? "Reference" : "المرجع"}: ${reference.slice(0,120)}`);
  const quantity = document.quantity ?? document.countedQuantity;
  if (typeof quantity === "string") values.push(`${english ? "Quantity" : "الكمية"}: ${quantity.slice(0,64)}`);
  if (Array.isArray(document.lines)) values.push(`${english ? "Lines" : "البنود"}: ${document.lines.length}`);
  if (typeof document.reason === "string" && document.reason.trim()) values.push(`${english ? "Reason" : "السبب"}: ${document.reason.trim().slice(0,200)}`);
  return values.join(" · ");
}
