/** Browser recovery evidence only. Authentication, authorisation and financial
 * truth always come from the server. No session token is persisted here.
 *
 * A read/write IndexedDB transaction claims one unresolved command per actor and
 * patient before the first network write. It survives reload and arbitrates
 * competing tabs. A revision tombstone prevents a draft opened before another
 * tab's completed operation from silently starting a second operation.
 */
export interface FinancialCommandScope { actor: string; patientId: number }
export interface FinancialCommand {
  kind: "invoice" | "debt" | "invoice-correction" | "historical-correction" | "receipt-correction";
  key: string;
  /** Immutable first intent, including its receipt expectations. */
  original: string;
  /** Current recovery state; original intent must never be replaced. */
  payload: string;
}
export interface FinancialJournal { revision: number; command: FinancialCommand | null }
export interface FinancialRecoveryControl {
  ready: boolean;
  revision: number;
  error: string | null;
  reserve: (command: FinancialCommand, revision: number) => Promise<boolean>;
  acknowledge: (command: FinancialCommand) => Promise<void>;
}
type StoredJournal = FinancialJournal & { scope: string };
const DATABASE = "aqlan-financial-command-recovery";
const STORE = "patient-commands";
const MAX_BYTES = 1024 * 1024;
const kinds = new Set(["invoice", "debt", "invoice-correction", "historical-correction", "receipt-correction"]);
export class FinancialRecoveryError extends Error {
  constructor(public readonly code: "unavailable" | "invalid" | "changed") {
    super(code === "changed" ? "تغيّر الطلب المالي في نافذة أخرى. راجع الطلب المحفوظ قبل بدء عملية جديدة."
      : "تعذّر حفظ أو قراءة طلب العملية بأمان في هذا المتصفح. لم يُرسل طلب جديد؛ أعد المحاولة دون مسح بيانات المتصفح.");
    this.name = "FinancialRecoveryError";
  }
}
function scopeKey(scope: FinancialCommandScope): string {
  if (!scope.actor || typeof scope.actor !== "string" || scope.actor.length > 200
    || !Number.isSafeInteger(scope.patientId) || scope.patientId <= 0) throw new FinancialRecoveryError("invalid");
  return JSON.stringify([scope.actor, scope.patientId]);
}
function validateCommand(value: unknown): value is FinancialCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as FinancialCommand;
  if (!kinds.has(command.kind) || typeof command.key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(command.key)) return false;
  return [command.original, command.payload].every(text => {
    if (typeof text !== "string" || !text.length || text.length > MAX_BYTES) return false;
    try { const parsed: unknown = JSON.parse(text); return !!parsed && typeof parsed === "object"; } catch { return false; }
  });
}
function readStored(value: unknown, scope: string): StoredJournal {
  if (value === undefined) return { scope, revision: 0, command: null };
  if (!value || typeof value !== "object") throw new FinancialRecoveryError("invalid");
  const row = value as StoredJournal;
  if (row.scope !== scope || !Number.isSafeInteger(row.revision) || row.revision < 0
    || (row.command !== null && !validateCommand(row.command))) throw new FinancialRecoveryError("invalid");
  return row;
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new FinancialRecoveryError("unavailable"));
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DATABASE, 1); } catch { return reject(new FinancialRecoveryError("unavailable")); }
    let abandoned = false;
    const timeout = setTimeout(() => { abandoned = true; reject(new FinancialRecoveryError("unavailable")); }, 5000);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE, { keyPath: "scope" }); };
    request.onerror = () => { clearTimeout(timeout); reject(new FinancialRecoveryError("unavailable")); };
    request.onblocked = () => { abandoned = true; clearTimeout(timeout); reject(new FinancialRecoveryError("unavailable")); };
    request.onsuccess = () => {
      clearTimeout(timeout);
      if (abandoned) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}
async function transaction(scope: FinancialCommandScope, change?: (row: StoredJournal) => StoredJournal): Promise<FinancialJournal> {
  const key = scopeKey(scope);
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      // Never acknowledge persistence on request.onsuccess: the transaction can
      // still abort (quota, tab shutdown, storage error) before it commits.
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
      tx.oncomplete = () => resolve({ revision: result.revision, command: result.command });
      tx.onerror = () => { /* onabort supplies one failure for the transaction. */ };
      tx.onabort = () => reject(failure ?? new FinancialRecoveryError("unavailable"));
    });
  } catch (error) {
    throw error instanceof FinancialRecoveryError ? error : new FinancialRecoveryError("unavailable");
  } finally { db.close(); }
}
export function readFinancialJournal(scope: FinancialCommandScope): Promise<FinancialJournal> { return transaction(scope); }

/** Returns the existing command when another tab won; callers must not send their
 * proposed body unless the returned key and immutable original match it. */
export function reserveFinancialCommand(scope: FinancialCommandScope, revision: number, command: FinancialCommand): Promise<FinancialJournal> {
  if (!validateCommand(command)) return Promise.reject(new FinancialRecoveryError("invalid"));
  return transaction(scope, current => {
    if (current.command) {
      if (current.command.key !== command.key || current.command.kind !== command.kind) return current;
      if (current.command.original !== command.original) throw new FinancialRecoveryError("changed");
      return { ...current, command };
    }
    if (current.revision !== revision) throw new FinancialRecoveryError("changed");
    return { ...current, command };
  });
}
/** Only after a fully validated receipt. Missing/denied/failed reads never clear
 * an uncertain command. Keep the revision, discard sensitive command contents. */
export function acknowledgeFinancialCommand(scope: FinancialCommandScope, command: FinancialCommand): Promise<FinancialJournal> {
  return transaction(scope, current => {
    if (!current.command || current.command.key !== command.key || current.command.kind !== command.kind
      || current.command.original !== command.original) throw new FinancialRecoveryError("changed");
    return { scope: current.scope, revision: current.revision + 1, command: null };
  });
}
