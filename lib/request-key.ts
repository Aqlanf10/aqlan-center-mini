/**
 * A fresh request key for one form submission (M2 slices 72–74). The canonical server
 * keeps a receipt per (actor, key): a double press or a retry after a lost response
 * returns the first result instead of writing twice. Rotate the key after a successful
 * save. The legacy routes ignore the field.
 */
export function newRequestKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}-request`;
}
