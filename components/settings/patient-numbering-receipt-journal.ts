import { isNumberingRequestId } from "../../lib/patient-numbering-settings-contract";

/** Tab-scoped only. Never store the preview credential, reason, actor or
 * clinical payload. The ID is not authorization to view a receipt. */
const key = "aqlan:numbering:pending-receipt:v1";
export type NumberingReceiptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type PendingRead = { ok: true; requestId: string | null } | { ok: false };

export function readPendingNumberingReceipt(storage: NumberingReceiptStorage | null): PendingRead {
  if (!storage) return { ok: false };
  try {
    const requestId = storage.getItem(key);
    return requestId === null || isNumberingRequestId(requestId) ? { ok: true, requestId } : { ok: false };
  } catch { return { ok: false }; }
}
export function rememberNumberingReceipt(storage: NumberingReceiptStorage | null, requestId: string): "first" | "retry" | "hold" {
  const current = readPendingNumberingReceipt(storage);
  if (!storage || !current.ok || !isNumberingRequestId(requestId)) return "hold";
  if (current.requestId !== null) return current.requestId === requestId ? "retry" : "hold";
  try {
    storage.setItem(key, requestId);
    const recorded = readPendingNumberingReceipt(storage);
    return recorded.ok && recorded.requestId === requestId ? "first" : "hold";
  } catch { return "hold"; }
}
export function clearNumberingReceipt(storage: NumberingReceiptStorage | null, requestId: string): boolean {
  const before = readPendingNumberingReceipt(storage);
  if (!storage || !before.ok || before.requestId !== requestId) return false;
  try {
    storage.removeItem(key);
    const after = readPendingNumberingReceipt(storage);
    return after.ok && after.requestId === null;
  } catch { return false; }
}
