import { isPurchaseCommand, PURCHASE_STORAGE_ERROR, verifyPurchaseCommand, type PurchaseCommand } from "./inventory-purchase-command";
import { isPurchaseKey } from "./inventory-purchase-protocol";

/** Purchase-specific recovery. This is not a stock ledger and stores no session
 * token. One unresolved exact command per browser principal and inventory item. */
export interface PurchaseScope { actor: string; actorUserId: number; itemId: number }
export interface PurchaseJournal { revision: number; command: PurchaseCommand | null }
type Acknowledged = { key: string; digest: string };
type StoredJournal = PurchaseJournal & { scope: string; acknowledged?: Acknowledged };
const DATABASE = "aqlan-inventory-purchase-recovery";
const STORE = "purchase-commands";
export class PurchaseRecoveryError extends Error {
  constructor(public readonly code: "unavailable" | "invalid" | "changed") {
    super(code === "changed" ? "تغيّر طلب الشراء في نافذة أخرى. راجع الطلب المحفوظ أو أغلق تفاصيل البند وأعد فتحها قبل شراء جديد." : PURCHASE_STORAGE_ERROR);
    this.name = "PurchaseRecoveryError";
  }
}
function scopeKey(scope: PurchaseScope): string {
  if (!scope.actor || typeof scope.actor !== "string" || scope.actor.length > 200 || !Number.isSafeInteger(scope.actorUserId) || scope.actorUserId <= 0 || !Number.isSafeInteger(scope.itemId) || scope.itemId <= 0) throw new PurchaseRecoveryError("invalid");
  return JSON.stringify([scope.actorUserId, scope.itemId]);
}
const same = (left: Acknowledged | undefined, right: Acknowledged) => left?.key === right.key && left.digest === right.digest;
const identity = (command: PurchaseCommand): Acknowledged => ({ key: command.key, digest: command.digest });
function readStored(value: unknown, key: string): StoredJournal {
  if (value === undefined) return { scope: key, revision: 0, command: null };
  if (!value || typeof value !== "object") throw new PurchaseRecoveryError("invalid");
  const row = value as StoredJournal;
  if (row.scope !== key || !Number.isSafeInteger(row.revision) || row.revision < 0
    || row.command !== null && (!isPurchaseCommand(row.command) || scopeKey(row.command) !== key)) throw new PurchaseRecoveryError("invalid");
  if (row.acknowledged !== undefined && (!row.acknowledged || !isPurchaseKey(row.acknowledged.key)
    || typeof row.acknowledged.digest !== "string" || !/^[a-f0-9]{64}$/.test(row.acknowledged.digest))) throw new PurchaseRecoveryError("invalid");
  return row;
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new PurchaseRecoveryError("unavailable"));
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DATABASE, 1); } catch { return reject(new PurchaseRecoveryError("unavailable")); }
    let abandoned = false;
    const timer = setTimeout(() => { abandoned = true; reject(new PurchaseRecoveryError("unavailable")); }, 5000);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE, { keyPath: "scope" }); };
    request.onerror = () => { clearTimeout(timer); reject(new PurchaseRecoveryError("unavailable")); };
    request.onblocked = () => { abandoned = true; clearTimeout(timer); reject(new PurchaseRecoveryError("unavailable")); };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (abandoned) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}
async function transaction(scope: PurchaseScope, change?: (row: StoredJournal) => StoredJournal): Promise<PurchaseJournal> {
  const key = scopeKey(scope), db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, change ? "readwrite" : "readonly", change ? { durability: "strict" } : undefined);
      const store = tx.objectStore(STORE);
      let result: StoredJournal;
      let failure: unknown;
      const request = store.get(key);
      request.onsuccess = () => {
        try {
          const current = readStored(request.result, key);
          result = change ? change(current) : current;
          if (change) store.put(result);
        } catch (error) { failure = error; tx.abort(); }
      };
      // Request success is NOT persistence. A subsequent quota/close error may
      // still abort the transaction; no caller can send before oncomplete.
      tx.oncomplete = () => resolve({ revision: result.revision, command: result.command });
      tx.onerror = () => {};
      tx.onabort = () => reject(failure ?? new PurchaseRecoveryError("unavailable"));
    });
  } catch (error) { throw error instanceof PurchaseRecoveryError ? error : new PurchaseRecoveryError("unavailable"); }
  finally { db.close(); }
}
async function validate(scope: PurchaseScope, command: PurchaseCommand): Promise<void> {
  if (!isPurchaseCommand(command) || scopeKey(command) !== scopeKey(scope) || command.actor !== scope.actor || !await verifyPurchaseCommand(command)) throw new PurchaseRecoveryError("invalid");
}
export async function readPurchaseJournal(scope: PurchaseScope): Promise<PurchaseJournal> {
  const saved = await transaction(scope);
  if (saved.command) await validate(scope, saved.command);
  return saved;
}
export async function reservePurchaseCommand(scope: PurchaseScope, revision: number, command: PurchaseCommand): Promise<PurchaseJournal> {
  await validate(scope, command); // Crypto must finish before opening the IDB transaction.
  if (!Number.isSafeInteger(revision) || revision < 0) throw new PurchaseRecoveryError("invalid");
  return transaction(scope, current => {
    if (current.command) {
      if (current.command.key !== command.key) return current;
      if (current.command.body !== command.body || current.command.digest !== command.digest) throw new PurchaseRecoveryError("changed");
      return current;
    }
    // A stale tab may replay its exact acknowledged command, but never replace
    // it with a new key after another tab retired the purchase.
    if (current.revision !== revision && !same(current.acknowledged, identity(command))) throw new PurchaseRecoveryError("changed");
    return { ...current, command };
  });
}
export async function acknowledgePurchaseCommand(scope: PurchaseScope, command: PurchaseCommand): Promise<PurchaseJournal> {
  await validate(scope, command);
  return transaction(scope, current => {
    const ack = identity(command);
    if (!current.command && same(current.acknowledged, ack)) return current;
    if (!current.command || current.command.key !== command.key || current.command.body !== command.body || current.command.digest !== command.digest) throw new PurchaseRecoveryError("changed");
    return { scope: current.scope, revision: current.revision + (same(current.acknowledged, ack) ? 0 : 1), command: null, acknowledged: ack };
  });
}
