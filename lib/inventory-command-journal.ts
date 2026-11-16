import { isInventoryRecoveryCommand, isInventoryOperationKey, isInventoryCommandScope, INVENTORY_RECOVERY_STORAGE, INVENTORY_RECOVERY_CHANGED, verifyInventoryRecoveryCommand, type InventoryRecoveryCommand, type InventoryCommandScope } from "./inventory-command-recovery";

/** Separate from direct-purchase recovery. One unresolved operation per
 * authenticated actor/workspace; contains no cookies or session tokens. */
type InventoryCommandScopeLocal = InventoryCommandScope;
export interface InventoryCommandJournal { revision: number; command: InventoryRecoveryCommand | null }
type Acknowledged = { key: string; digest: string };
type StoredJournal = InventoryCommandJournal & { scope: string; acknowledged?: Acknowledged };
const DATABASE = "aqlan-inventory-command-recovery";
const STORE = "inventory-commands";
export class InventoryCommandRecoveryError extends Error {
  constructor(public readonly code: "unavailable" | "invalid" | "changed") {
    super(code === "changed" ? INVENTORY_RECOVERY_CHANGED : INVENTORY_RECOVERY_STORAGE);
    this.name = "InventoryCommandRecoveryError";
  }
}
function scopeKey(scope: InventoryCommandScopeLocal): string {
  if (!isInventoryCommandScope(scope)) throw new InventoryCommandRecoveryError("invalid");
  return JSON.stringify([scope.actorUserId, scope.workspace]);
}
const same = (left: Acknowledged | undefined, right: Acknowledged) => left?.key === right.key && left.digest === right.digest;
const identity = (command: InventoryRecoveryCommand): Acknowledged => ({ key: command.key, digest: command.digest });
function readStored(value: unknown, key: string): StoredJournal {
  if (value === undefined) return { scope: key, revision: 0, command: null };
  if (!value || typeof value !== "object") throw new InventoryCommandRecoveryError("invalid");
  const row = value as StoredJournal;
  if (row.scope !== key || !Number.isSafeInteger(row.revision) || row.revision < 0
    || row.command !== null && (!isInventoryRecoveryCommand(row.command) || scopeKey(row.command) !== key)) throw new InventoryCommandRecoveryError("invalid");
  if (row.acknowledged !== undefined && (!row.acknowledged || !isInventoryOperationKey(row.acknowledged.key)
    || typeof row.acknowledged.digest !== "string" || !/^[a-f0-9]{64}$/.test(row.acknowledged.digest))) throw new InventoryCommandRecoveryError("invalid");
  return row;
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new InventoryCommandRecoveryError("unavailable"));
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DATABASE, 1); } catch { return reject(new InventoryCommandRecoveryError("unavailable")); }
    let abandoned = false;
    const timer = setTimeout(() => { abandoned = true; reject(new InventoryCommandRecoveryError("unavailable")); }, 5000);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE, { keyPath: "scope" }); };
    request.onerror = () => { clearTimeout(timer); reject(new InventoryCommandRecoveryError("unavailable")); };
    request.onblocked = () => { abandoned = true; clearTimeout(timer); reject(new InventoryCommandRecoveryError("unavailable")); };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (abandoned) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}
async function transaction(scope: InventoryCommandScopeLocal, change?: (row: StoredJournal) => StoredJournal): Promise<InventoryCommandJournal> {
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
      tx.onabort = () => reject(failure ?? new InventoryCommandRecoveryError("unavailable"));
    });
  } catch (error) { throw error instanceof InventoryCommandRecoveryError ? error : new InventoryCommandRecoveryError("unavailable"); }
  finally { db.close(); }
}
async function validate(scope: InventoryCommandScopeLocal, command: InventoryRecoveryCommand): Promise<void> {
  if (!isInventoryRecoveryCommand(command) || scopeKey(command) !== scopeKey(scope) || command.actor !== scope.actor || !await verifyInventoryRecoveryCommand(command)) throw new InventoryCommandRecoveryError("invalid");
}
export async function readInventoryCommandJournal(scope: InventoryCommandScopeLocal): Promise<InventoryCommandJournal> {
  const saved = await transaction(scope);
  if (saved.command) await validate(scope, saved.command);
  return saved;
}
export async function reserveInventoryRecoveryCommand(scope: InventoryCommandScopeLocal, revision: number, command: InventoryRecoveryCommand): Promise<InventoryCommandJournal> {
  await validate(scope, command); // Crypto must finish before opening the IDB transaction.
  if (!Number.isSafeInteger(revision) || revision < 0) throw new InventoryCommandRecoveryError("invalid");
  return transaction(scope, current => {
    if (current.command) {
      if (current.command.key !== command.key) return current;
      if (current.command.body !== command.body || current.command.digest !== command.digest) throw new InventoryCommandRecoveryError("changed");
      return current;
    }
    // A stale tab may replay its exact acknowledged command, but never replace
    // it with a new key after another tab retired the operation.
    if (current.revision !== revision && !same(current.acknowledged, identity(command))) throw new InventoryCommandRecoveryError("changed");
    return { ...current, command };
  });
}
export async function acknowledgeInventoryRecoveryCommand(scope: InventoryCommandScopeLocal, command: InventoryRecoveryCommand): Promise<InventoryCommandJournal> {
  await validate(scope, command);
  return transaction(scope, current => {
    const ack = identity(command);
    if (!current.command && same(current.acknowledged, ack)) return current;
    if (!current.command || current.command.key !== command.key || current.command.body !== command.body || current.command.digest !== command.digest) throw new InventoryCommandRecoveryError("changed");
    return { scope: current.scope, revision: current.revision + (same(current.acknowledged, ack) ? 0 : 1), command: null, acknowledged: ack };
  });
}
