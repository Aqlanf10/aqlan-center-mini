import { payloadIdentity } from "./inventory-domain/procurement";
import {
  inventoryRecoveryIdentity,
  inventoryRecoveryDigest,
} from "./inventory-command-recovery";
import {
  SUPPLIER_PROTOCOL,
  type SupplierIntent,
  type SupplierAdmission,
  type SupplierAcknowledgement,
  type SupplierRejectedIntent,
} from "./inventory-supplier-protocol";
export interface SupplierSavedCommand {
  intent: SupplierIntent;
  admission?: SupplierAdmission;
}
const DB = "aqlan-inventory-supplier-recovery",
  STORE = "intents";
function id(command: SupplierSavedCommand) {
  return JSON.stringify([
    command.intent.authority.realmId,
    command.intent.authority.subjectId,
    command.intent.nonce,
  ]);
}
function open() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined")
      return reject(new Error("supplier_storage_unavailable"));
    let abandoned = false;
    const timer = setTimeout(() => {
      abandoned = true;
      reject(new Error("supplier_storage_unavailable"));
    }, 5000);
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE))
        r.result.createObjectStore(STORE);
    };
    r.onsuccess = () => {
      clearTimeout(timer);
      if (abandoned) {
        r.result.close();
        return;
      }
      r.result.onversionchange = () => r.result.close();
      resolve(r.result);
    };
    r.onerror = () => {
      clearTimeout(timer);
      reject(new Error("supplier_storage_unavailable"));
    };
    r.onblocked = () => {
      abandoned = true;
      clearTimeout(timer);
      reject(new Error("supplier_storage_unavailable"));
    };
  });
}
async function transaction<T>(
  mode: IDBTransactionMode,
  work: (
    store: IDBObjectStore,
    done: (value: T) => void,
    fail: (error: Error) => void,
  ) => void,
): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(
      STORE,
      mode,
      mode === "readwrite" ? { durability: "strict" } : undefined,
    );
    let value: T, error: Error;
    tx.oncomplete = () => {
      db.close();
      resolve(value);
    };
    tx.onabort = () => {
      db.close();
      reject(error ?? new Error("supplier_storage_unavailable"));
    };
    tx.onerror = () => {};
    work(
      tx.objectStore(STORE),
      (v) => {
        value = v;
      },
      (e) => {
        error = e;
        tx.abort();
      },
    );
  });
}
export async function listSupplierCommands(realmId: string, subjectId: string) {
  return transaction<SupplierSavedCommand[]>("readonly", (s, done, fail) => {
    const r = s.getAll();
    r.onsuccess = () => {
      const rows = r.result as SupplierSavedCommand[];
      if (
        rows.some(
          (x) =>
            !x?.intent ||
            x.intent.protocol !== SUPPLIER_PROTOCOL ||
            !x.intent.authority ||
            typeof x.intent.nonce !== "string",
        )
      ) {
        fail(new Error("supplier_storage_invalid"));
        return;
      }
      done(
        rows.filter(
          (x) =>
            x.intent.authority.realmId === realmId &&
            x.intent.authority.subjectId === subjectId,
        ),
      );
    };
  });
}
/** Persist before the first admission request; same nonce/body can never be replaced. */
export async function saveSupplierCommand(command: SupplierSavedCommand) {
  return transaction<void>("readwrite", (s, done, fail) => {
    const key = id(command),
      r = s.get(key);
    r.onsuccess = () => {
      const old = r.result as SupplierSavedCommand | undefined;
      if (
        old &&
        (inventoryRecoveryIdentity(old.intent) !==
          inventoryRecoveryIdentity(command.intent) ||
          (old.admission &&
            (!command.admission ||
              inventoryRecoveryIdentity(old.admission) !==
                inventoryRecoveryIdentity(command.admission))))
      ) {
        fail(new Error("supplier_saved_changed"));
        return;
      }
      s.put(command, key);
      done(undefined);
    };
  });
}
function completeAcknowledgement(
  command: SupplierSavedCommand,
  ack: SupplierAcknowledgement,
) {
  if (!ack || typeof ack !== "object") return false;
  if (ack.status === "retired")
    return (
      typeof ack.reason === "string" &&
      ack.reason.trim().length >= 3 &&
      ack.reason.length <= 2000
    );
  if (ack.status !== "committed") return false;
  const r = ack.result;
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    r.invoiceId !== command.intent.input.invoiceId ||
    typeof r.replayed !== "boolean" ||
    r.stockEffects !== 0 ||
    r.cashEffects !== 0
  )
    return false;
  const positiveId = (v: unknown) =>
    Number.isSafeInteger(v) && (v as number) > 0;
  if (command.intent.action === "revise")
    return (
      r.version === command.intent.input.expectedVersion + 1 &&
      typeof r.digest === "string" &&
      /^[0-9a-f]{64}$/.test(r.digest) &&
      ["matched", "needs_review"].includes(r.status as string) &&
      r.payableEffects === 0
    );
  if (command.intent.action === "post")
    return (
      r.status === "posted" &&
      positiveId(r.payableId) &&
      [0, 1].includes(r.payableEffects as number)
    );
  return (
    r.status === "cancelled" &&
    positiveId(r.payableId) &&
    positiveId(r.adjustmentId) &&
    [0, 1].includes(r.adjustmentEffects as number)
  );
}
export async function acknowledgeSupplierCommand(
  command: SupplierSavedCommand,
  ack: SupplierAcknowledgement,
) {
  const a = command.admission;
  if (
    !a ||
    !completeAcknowledgement(command, ack) ||
    ack.digest !== a.digest ||
    inventoryRecoveryIdentity(ack.envelope) !==
      inventoryRecoveryIdentity(a.envelope)
  )
    throw new Error("supplier_acknowledgement_mismatch");
  if (ack.status === "committed" && command.intent.action === "revise") {
    const document = command.intent.input.document;
    if (!document) throw new Error("supplier_acknowledgement_mismatch");
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(payloadIdentity(document)),
    );
    const expected = Array.from(new Uint8Array(bytes), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    if (ack.result?.digest !== expected)
      throw new Error("supplier_acknowledgement_mismatch");
  }
  return transaction<void>("readwrite", (s, done, fail) => {
    const key = id(command),
      r = s.get(key);
    r.onsuccess = () => {
      if (
        r.result &&
        inventoryRecoveryIdentity(r.result) !==
          inventoryRecoveryIdentity(command)
      ) {
        fail(new Error("supplier_saved_changed"));
        return;
      }
      s.delete(key);
      done(undefined);
    };
  });
}

/** A generic HTTP refusal never reaches this path; require exact durable nonce proof. */
export async function acknowledgeSupplierRejection(
  command: SupplierSavedCommand,
  ack: SupplierRejectedIntent,
) {
  if (
    command.admission ||
    !ack ||
    ack.status !== "rejected" ||
    !ack.intent ||
    typeof ack.intent !== "object" ||
    ack.code !== "supplier_invoice_intent_pending" ||
    typeof ack.reason !== "string" ||
    ack.reason.trim().length < 3 ||
    ack.reason.length > 2000 ||
    inventoryRecoveryIdentity(ack.intent) !==
      inventoryRecoveryIdentity(command.intent) ||
    ack.digest !== (await inventoryRecoveryDigest({ ...command.intent }))
  )
    throw new Error("supplier_acknowledgement_mismatch");
  return transaction<void>("readwrite", (s, done, fail) => {
    const key = id(command),
      r = s.get(key);
    r.onsuccess = () => {
      if (
        r.result &&
        inventoryRecoveryIdentity(r.result) !==
          inventoryRecoveryIdentity(command)
      ) {
        fail(new Error("supplier_saved_changed"));
        return;
      }
      s.delete(key);
      done(undefined);
    };
  });
}
