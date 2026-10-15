import type { InventoryMovement } from "../db";
import { InventoryDomainError } from "./quantities";

export const DEFAULT_SAFE_INVENTORY_ERROR_MESSAGE =
  "تعذّر تنفيذ العملية. راجع المدخلات والصلاحية.";

const SENSITIVE_KEY_PATTERN =
  /(?:pass(?:word)?|secret|token|api_?key|private_?key|access_?key|client_?secret|auth(?:orization)?|cookie|session|database_?url|connection_?string|dsn|stack|sql|raw_?error|credential)/i;

const FINANCIAL_KEY_PATTERN =
  /^(unitcostminor|unitpriceminor|payableid|baseamountminor|valueceiling|quote|supplierinvoicenumber|invoicenumber|costsnapshot|purchaseprice|secretprice)$/i;

const SENSITIVE_TEXT_PATTERN =
  /(?:postgres(?:ql)?:\/\/\S+|bearer\s+[a-z0-9._~+/-]+=*|basic\s+[a-z0-9._~+/-]+=*|(?:api_?key|access_?token|refresh_?token|secret|password|private_?key|session_?token|aqlan_session)\s*[:=]\s*\S+|password\s+authentication\s+failed[^\n,;)"]*|(?:permission\s+denied|violates\s+(?:unique|foreign\s+key|check)\s+constraint|relation\s+"[^"]+"\s+does\s+not\s+exist)[^\n,;)"']*)/gi;

const UNSAFE_ERROR_DIAGNOSTIC_PATTERN =
  /(?:postgres(?:ql)?:\/\/|bearer\s+|basic\s+|api_?key|access_?token|refresh_?token|private_?key|client_?secret|session_?token|aqlan_session|password\s+authentication\s+failed|permission\s+denied|duplicate\s+key\s+value|violates\s+(?:unique|foreign\s+key|check|not-null)\s+constraint|null\s+value\s+in\s+column|relation\s+"[^"]+"|column\s+"[^"]+"|table\s+"[^"]+"|constraint\s+"[^"]+"|schema\s+"[^"]+"|\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|HAVING|GROUP\s+BY|ORDER\s+BY|pg_catalog|pg_advisory|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|syntax\s+error\s+at\s+or\s+near)\b)/i;

const ALLOWLISTED_DOMAIN_ERROR_MESSAGES: Record<string, string> = {
  schema_not_ready: "دورة المشتريات بانتظار اعتماد ترحيل المخطط. لم تُسجّل العملية.",
  actor_forbidden: "لا تملك صلاحية تنفيذ هذه العملية.",
  operation_forbidden: "تتطلب هذه العملية صلاحية الإدارة.",
  custody_forbidden: "العهدة المحددة لا تخص هذا الطبيب أو غير مصرح بها.",
  clinical_context_forbidden: "لا تملك صلاحية ربط الاستهلاك بهذا الملف السريري.",
  clinical_context_mismatch: "بيانات المريض أو الزيارة أو الإجراء غير متطابقة أو غير موجودة.",
  invalid_waste_approval: "يتطلب إثبات التالف في العهدة اعتمادًا إداريًا مستقلًا وصالحًا.",
  lot_not_in_custody_location: "الدفعة المحددة لم يسبق استلامها في موقع العهدة هذا.",
  package_history_mismatch: "كميات إغلاق العبوة لا تطابق السجل الفعلي لحركة الدفعة في العهدة.",
  unposted_settlement_adjustment: "لا يمكن خصم تسوية غير مرحّلة ماليًا من المقارنة السنوية.",
  settlement_source_mismatch: "أرقام الاستهلاك المرسلة لا تطابق السجل الفعلي المؤكد في النظام.",
  unresolved_historical_lineage: "يتعذر ربط الصرف التاريخي بدفعة سابقة مؤكدة دون تخمين بأثر رجعي.",
  negative_legacy_balance: "الرصيد التاريخي لا يكفي لتسوية حركات الصرف دون تخمين رصيد افتتاحي.",
  already_reconciled: "تمت تسوية الحركات التاريخية لهذا البند بالفعل.",
  stale_version: "تغيرت نسخة المستند. أعد التحميل وراجع التغييرات قبل الحفظ.",
  idempotency_conflict: "مفتاح العملية مستخدم لطلب مختلف. استخدم مفتاحًا جديدًا لعملية جديدة.",
  invalid_transition: "لا يمكن تنفيذ هذا الانتقال في الحالة الحالية للمستند.",
  source_overallocated: "الكمية المطلوبة تتجاوز الرصيد المعتمد المتبقي في طلب الشراء.",
  overdelivery: "الكمية الواصلة تتجاوز المتبقي في أمر الشراء دون قرار معالجة فائض معتمد.",
  receipt_already_invoiced: "تمت مطابقة جزء الاستلام هذا في فاتورة مورد سابقة.",
  quarantine_overresolved: "كمية معالجة الحجر تتجاوز الكمية المحجورة المتبقية.",
  quarantine_release_expired: "لا يمكن الإفراج عن دفعة منتهية الصلاحية أو دون الحد الأدنى للصلاحية.",
  invalid_resolution_date: "تاريخ قرار معالجة الحجر غير صالح أو في المستقبل.",
  duplicate_consumption: "حركة الاستهلاك أو الإرجاع مسجلة مسبقًا لهذا المفتاح.",
  package_or_evidence_already_closed: "تم إغلاق هذه العبوة أو استخدام مستند الإثبات مسبقًا.",
  transfer_overacknowledged: "الكمية المؤكدة تتجاوز الكمية المرسلة في التحويل.",
  duplicate_settlement_adjustment: "تم إدراج تسوية مكررة في المقارنة السنوية.",
  not_found: "السجل المطلوب غير موجود.",
  invalid_body: "بيانات الطلب غير صالحة.",
  invalid_lines: "بنود المستند غير صالحة أو تتجاوز الحد المسموح.",
  invalid_document: "معرّف المستند وإصداره مطلوبان.",
  invalid_operation_key: "مفتاح العملية مطلوب.",
  invalid_command: "الأمر المطلوب غير مدعوم.",
  invalid_approval: "بيانات الاعتماد غير مكتملة.",
  invalid_quantity: "الكمية المدخلة غير صالحة.",
  invalid_unit_conversion: "بيانات تحويل الوحدة غير صالحة.",
  invalid_location: "الموقع المخزني غير صالح لهذه العملية.",
  invalid_lot: "الدفعة المحددة غير صالحة أو غير متاحة للصرف.",
  insufficient_lot_balance: "رصيد الدفعة المتاح لا يكفي للكمية المطلوبة.",
  expired_lot_dispatch: "لا يمكن صرف دفعة منتهية الصلاحية أو محجورة.",
};

const ALLOWLISTED_PUBLIC_ARABIC_MESSAGES = new Set<string>([
  "كمية الصرف أكبر من المتاح",
  "الكمية غير صالحة",
  "البند غير موجود",
  "الزيارة غير موجودة",
  ...Object.values(ALLOWLISTED_DOMAIN_ERROR_MESSAGES),
]);

function scrubText(value: string): string {
  const scrubbed = value.replace(SENSITIVE_TEXT_PATTERN, "[REDACTED]");
  SENSITIVE_TEXT_PATTERN.lastIndex = 0;
  if (UNSAFE_ERROR_DIAGNOSTIC_PATTERN.test(scrubbed)) {
    return "[REDACTED]";
  }
  return scrubbed;
}

function isUnsafeErrorText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (UNSAFE_ERROR_DIAGNOSTIC_PATTERN.test(trimmed)) return true;
  SENSITIVE_TEXT_PATTERN.lastIndex = 0;
  const hit = SENSITIVE_TEXT_PATTERN.test(trimmed);
  SENSITIVE_TEXT_PATTERN.lastIndex = 0;
  return hit;
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

/**
 * Allowlist-based public error message resolver.
 * Never allows raw error.message to act as its own fallback or leak DB/auth/constraint internals.
 */
export function safeInventoryErrorMessage(
  error: unknown,
  fallbackMessage: string = DEFAULT_SAFE_INVENTORY_ERROR_MESSAGE,
): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const trimmed = raw.trim();
  const callerPassedRawAsFallback =
    Boolean(trimmed) && fallbackMessage.trim() === trimmed;
  const safeFallback =
    !callerPassedRawAsFallback && !isUnsafeErrorText(fallbackMessage)
      ? fallbackMessage.trim()
      : DEFAULT_SAFE_INVENTORY_ERROR_MESSAGE;

  if (!trimmed || isUnsafeErrorText(trimmed)) {
    if (error instanceof InventoryDomainError && ALLOWLISTED_DOMAIN_ERROR_MESSAGES[error.code]) {
      return ALLOWLISTED_DOMAIN_ERROR_MESSAGES[error.code];
    }
    return safeFallback;
  }

  if (error instanceof InventoryDomainError) {
    if (ALLOWLISTED_DOMAIN_ERROR_MESSAGES[error.code]) {
      return ALLOWLISTED_DOMAIN_ERROR_MESSAGES[error.code];
    }
    if (/^[a-z0-9_]+$/.test(error.code) && trimmed.length <= 240) {
      return trimmed;
    }
    return safeFallback;
  }

  if (ALLOWLISTED_PUBLIC_ARABIC_MESSAGES.has(trimmed)) {
    return trimmed;
  }

  return safeFallback;
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
