import type { InventoryMovement } from "../db";

const SENSITIVE_KEY_PATTERN = /^(password|password_?hash|cookie|session_?token|token|secret|authorization|database_?url|connection_?string|stack|sql|raw_?error)$/i;
const FINANCIAL_KEY_PATTERN = /^(unitcostminor|unitpriceminor|payableid|baseamountminor|valueceiling|quote|supplierinvoicenumber|invoicenumber)$/i;
const SENSITIVE_TEXT_PATTERN = /(?:postgres(?:ql)?:\/\/\S+|bearer\s+[a-z0-9._~+/-]+=*|aqlan_session=\S+|password=\S+)/gi;

function scrubText(value: string): string {
  return value.replace(SENSITIVE_TEXT_PATTERN, "[REDACTED]");
}

function sanitizeValue(value: unknown, includeFinancials: boolean, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, includeFinancials, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) continue;
      if (!includeFinancials && FINANCIAL_KEY_PATTERN.test(key)) continue;
      out[key] = sanitizeValue(entry, includeFinancials, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Ensures audit log payloads never persist credentials, connection strings, or unauthorized financial fields. */
export function sanitizeInventoryAuditDetails(
  details: Record<string, unknown>,
  options: { includeFinancials?: boolean } = {},
): Record<string, unknown> {
  const includeFinancials = options.includeFinancials ?? true;
  return sanitizeValue(details, includeFinancials, 0) as Record<string, unknown>;
}

/** Prevents internal SQL/connection/stack details from leaking through user-facing error responses. */
export function safeInventoryErrorMessage(error: unknown, fallbackMessage: string): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const trimmed = raw.trim();
  if (!trimmed) return fallbackMessage;
  if (
    SENSITIVE_TEXT_PATTERN.test(trimmed) ||
    /\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|pg_catalog|ECONNREFUSED|ENOTFOUND|relation\s+"[^"]+"\s+does\s+not\s+exist|syntax\s+error\s+at\s+or\s+near)\b/i.test(trimmed)
  ) {
    SENSITIVE_TEXT_PATTERN.lastIndex = 0;
    return fallbackMessage;
  }
  SENSITIVE_TEXT_PATTERN.lastIndex = 0;
  return trimmed;
}

/** Operational response is an allowlist: added financial properties stay private. */
export function inventoryMovementForRead(movement: InventoryMovement, pricesAllowed: boolean) {
  if (pricesAllowed) return movement;
  return {
    id: movement.id, itemId: movement.itemId, kind: movement.kind, qty: movement.qty,
    expiryDate: movement.expiryDate, reason: movement.reason, visitId: movement.visitId,
    createdBy: movement.createdBy, createdAt: movement.createdAt, isReturn: movement.isReturn,
  };
}

