import { inventoryRecoveryIdentity } from "./inventory-command-recovery";
import { payloadIdentity } from "./inventory-domain/procurement";
import { validateReferenceInput } from "./inventory-domain/reference-validation";
import type {
  ReferenceAuthority,
  ReferenceIntent,
  ReferenceReply,
} from "./inventory-reference-protocol";

type Saved = { revision: number; intent: ReferenceIntent | null };
const key = (a: ReferenceAuthority) => JSON.stringify([a.realmId, a.subjectId]);
export function decodeReferenceJournal(
  value: unknown,
  authority: ReferenceAuthority,
): Saved {
  // Only an absent IDB key is empty. Existing unrecognized bytes never mean an
  // empty journal and are never overwritten with a fresh nonce.
  if (value === undefined) return { revision: 0, intent: null };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("reference_storage_invalid");
  const saved = value as Saved;
  if (
    Object.keys(saved).length !== 2 ||
    !Object.hasOwn(saved, "revision") ||
    !Object.hasOwn(saved, "intent") ||
    !Number.isSafeInteger(saved.revision) ||
    saved.revision < 0
  )
    throw new Error("reference_storage_invalid");
  if (saved.intent !== null) {
    const i = saved.intent;
    try {
      if (
        !i ||
        typeof i !== "object" ||
        Object.keys(i).length !== 4 ||
        !["protocol", "authority", "nonce", "input"].every((k) =>
          Object.hasOwn(i, k),
        ) ||
        i.protocol !== "inventory-reference-v1" ||
        typeof i.nonce !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          i.nonce,
        ) ||
        !i.authority ||
        Object.keys(i.authority).length !== 3 ||
        !["realmId", "subjectId", "generation"].every((k) => {
          const v = i.authority[k as keyof ReferenceAuthority];
          return (
            typeof v === "string" &&
            v.length > 0 &&
            v.length <= 240 &&
            v.trim() === v
          );
        }) ||
        key(i.authority) !== key(authority)
      )
        throw new Error();
      validateReferenceInput(i.input);
    } catch {
      throw new Error("reference_storage_invalid");
    }
  }
  return saved;
}
async function access(
  a: ReferenceAuthority,
  change?: (old: Saved) => Saved,
): Promise<Saved> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    let abandoned = false;
    const request = indexedDB.open("aqlan-inventory-reference-recovery", 1);
    const timer = setTimeout(() => {
      abandoned = true;
      reject(new Error("reference_storage_unavailable"));
    }, 5000);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("commands");
    request.onerror = request.onblocked = () => {
      clearTimeout(timer);
      abandoned = true;
      reject(new Error("reference_storage_unavailable"));
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (abandoned) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      "commands",
      change ? "readwrite" : "readonly",
      change ? { durability: "strict" } : undefined,
    );
    const store = tx.objectStore("commands"),
      request = store.get(key(a));
    let result: Saved, failure: unknown;
    request.onsuccess = () => {
      try {
        const old = decodeReferenceJournal(request.result, a);
        result = change ? change(old) : old;
        if (change) store.put(result, key(a));
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onabort = () => {
      db.close();
      reject(failure ?? new Error("reference_storage_unavailable"));
    };
    tx.onerror = () => {};
  });
}
export const readReferenceCommand = (a: ReferenceAuthority) => access(a);
export const reserveReferenceCommand = (
  intent: ReferenceIntent,
  revision: number,
) =>
  access(intent.authority, (old) => {
    if (old.intent) {
      if (
        inventoryRecoveryIdentity(old.intent) !==
        inventoryRecoveryIdentity(intent)
      )
        throw new Error("reference_command_pending");
      return old;
    }
    if (old.revision !== revision) throw new Error("reference_command_changed");
    return { ...old, intent };
  });
export function isReferenceTerminal(
  intent: ReferenceIntent,
  value: unknown,
): value is ReferenceReply {
  try {
    return validReferenceTerminal(intent, value);
  } catch {
    return false;
  }
}
function validReferenceTerminal(
  intent: ReferenceIntent,
  value: unknown,
): value is ReferenceReply {
  if (!value || typeof value !== "object") return false;
  const ack = value as ReferenceReply;
  if (
    inventoryRecoveryIdentity(ack.intent) !== inventoryRecoveryIdentity(intent)
  )
    return false;
  const identity = ack.identity;
  if (
    !identity ||
    identity.scope !== "reference.setup" ||
    identity.realmId !== intent.authority.realmId ||
    identity.subjectId !== intent.authority.subjectId ||
    !/^reference:[0-9a-f]{64}$/.test(identity.operationKey) ||
    !Number.isSafeInteger(identity.actorUserId) ||
    identity.actorUserId <= 0 ||
    typeof identity.username !== "string" ||
    !identity.username ||
    !/^[0-9a-f]{64}$/.test(identity.payloadDigest)
  )
    return false;
  if (ack.status === "retired")
    return typeof ack.reason === "string" && ack.reason.trim().length >= 3;
  if (
    ack.status !== "committed" ||
    !ack.result ||
    Array.isArray(ack.result) ||
    typeof ack.result.replayed !== "boolean" ||
    ack.result.action !== intent.input.action ||
    typeof ack.result.id !== "string" ||
    !Number.isSafeInteger(ack.result.version) ||
    ack.result.version <= 0
  )
    return false;
  switch (intent.input.action) {
    case "item.create":
      return /^[1-9][0-9]*$/.test(ack.result.id) && ack.result.version === 1;
    case "location.create":
      return ack.result.id === intent.input.id && ack.result.version === 1;
    case "unit.revise":
      return (
        ack.result.id === String(intent.input.itemId) &&
        ack.result.version === intent.input.expectedVersion + 1
      );
    case "policy.revise":
      return (
        /^[0-9a-f-]{36}$/.test(ack.result.id) &&
        ack.result.version === intent.input.expectedVersion + 1
      );
  }
}
export async function acknowledgeReferenceCommand(
  intent: ReferenceIntent,
  ack: unknown,
) {
  if (!isReferenceTerminal(intent, ack))
    throw new Error("reference_acknowledgement_invalid");
  const hash = async (text: string) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
      ),
      (v) => v.toString(16).padStart(2, "0"),
    ).join("");
  if (
    ack.identity.payloadDigest !== (await hash(payloadIdentity(intent))) ||
    ack.identity.operationKey !==
      `reference:${await hash(JSON.stringify([intent.authority.realmId, intent.authority.subjectId, intent.nonce]))}`
  )
    throw new Error("reference_acknowledgement_invalid");
  return access(intent.authority, (old) => {
    if (!old.intent) return old;
    if (
      inventoryRecoveryIdentity(old.intent) !==
      inventoryRecoveryIdentity(intent)
    )
      throw new Error("reference_command_changed");
    return { revision: old.revision + 1, intent: null };
  });
}
