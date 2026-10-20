/** A nested envelope deliberately has no top-level kind: older servers must
 * reject it, never silently execute a keyed purchase as an unkeyed movement. */
export const INVENTORY_PURCHASE_PROTOCOL = "inventory-purchase-v1" as const;
export const INVENTORY_PURCHASE_KEY_HEADER = "Idempotency-Key";

export function isPurchaseKey(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isPurchaseRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const purchaseFields = new Set([
  "kind", "qty", "expiryDate", "reason", "visitId", "patientId", "unitCost",
  "isReturn", "supplierPartyId", "supplierDueDate",
]);

export function purchaseEnvelope(value: unknown): Record<string, unknown> | null {
  if (!isPurchaseRecord(value) || Object.keys(value).length !== 2
    || value.protocol !== INVENTORY_PURCHASE_PROTOCOL || !isPurchaseRecord(value.purchase)) return null;
  const document = value.purchase;
  if (Object.keys(document).some(key => !purchaseFields.has(key))
    || document.kind !== "in" || (document.isReturn !== undefined && document.isReturn !== false && document.isReturn !== null)
    || (document.visitId !== undefined && document.visitId !== null)
    || (document.patientId !== undefined && document.patientId !== null)) return null;
  return document;
}

/** Canonical JSON v1. Sort object keys but preserve JSON types, all submitted
 * fields, nulls and array ordering. Never hash normalized database input.
 * Non-JSON values are rejected, rather than silently erased/coerced. */
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPurchaseRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  throw new Error("Invalid purchase document");
}

export function canonicalPurchaseRequest(itemId: number, purchase: Record<string, unknown>): string {
  if (!Number.isInteger(itemId) || itemId <= 0 || itemId > 2_147_483_647) throw new Error("Invalid purchase item");
  return canonical({ operation: "inventory-purchase", version: 1, itemId, purchase });
}

/** Old financial clients must reload rather than silently bypass deduplication.
 * Unpriced item-opening receipts and unrelated movement kinds stay compatible. */
export function isUnwrappedFinancialPurchase(source: Record<string, unknown>): boolean {
  return source.kind === "in" && source.isReturn !== true
    && ((source.supplierPartyId !== undefined && source.supplierPartyId !== null && source.supplierPartyId !== "")
      || (source.unitCost !== undefined && source.unitCost !== null && source.unitCost !== ""));
}

/** PostgreSQL text is UTF-8. Preserve the existing 300 UTF-16-unit boundary,
 * but make replacement of a split/lone surrogate deterministic before storage
 * and acknowledgment comparison. The request fingerprint still uses raw JSON. */
export function normalizePurchaseReason(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return new TextDecoder().decode(new TextEncoder().encode(value.trim().slice(0, 300)));
}
