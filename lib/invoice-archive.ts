import type { Currency } from "./money";

export type InvoiceArchiveErrorCode = "invalid" | "unauthorized" | "missing" | "conflict" | "stale" | "migration_pending" | "policy_decision_required" | "period_locked";
export interface InvoiceArchiveRefusal extends InvoiceArchiveCommand {
  kind: "version_advanced" | "durable_rejection"; invoiceId: number; patientId: number; actor: string; currentVersion: number;
}
export class InvoiceArchiveError extends Error {
  constructor(readonly code: InvoiceArchiveErrorCode, message: string, readonly refusal?: InvoiceArchiveRefusal) { super(message); }
}
export interface InvoiceArchiveCommand {
  action: "archive" | "restore";
  reason: string;
  idempotencyKey: string;
  expectedVersion: number;
}
export interface InvoiceArchiveEligibility {
  canArchive: boolean;
  code: "policy_decision_required" | "period_locked" | "migration_pending" | null;
  message: string | null;
  remainingMinor: number | null;
}
export interface InvoiceArchiveReceipt {
  eventId: string;
  invoiceId: number;
  patientId: number;
  invoiceNumber: string;
  invoiceCreatedAt: string;
  currency: Currency;
  version: number;
  action: "archive" | "restore";
  archived: boolean;
  reason: string;
  idempotencyKey: string;
  actorUserId: number;
  actor: string;
  at: string;
}
export interface InvoiceArchiveView {
  invoiceId: number;
  patientId: number;
  invoiceNumber: string;
  currency: Currency;
  status: "open" | "paid" | "cancelled";
  version: number;
  archived: boolean;
  latest: InvoiceArchiveReceipt | null;
  readiness: "ready" | "migration_pending";
  eligibility: InvoiceArchiveEligibility;
}
export interface InvoiceArchiveResult {
  receipt: InvoiceArchiveReceipt | null;
  current: InvoiceArchiveView;
  replayed: boolean;
  noop: boolean;
  acknowledgment: Pick<InvoiceArchiveCommand, "idempotencyKey" | "action" | "expectedVersion"> & { actor: string; invoiceId: number; patientId: number };
}
export const INVOICE_ARCHIVE_MIGRATION_MESSAGE = "مخطط أرشفة الفواتير غير جاهز أو غير مطابق؛ لم تتغير الفاتورة.";
export const INVOICE_ARCHIVE_POLICY_MESSAGE = "أرشفة فاتورة غير مسددة أو ذات تسوية غير مثبتة تحتاج قرار سياسة معتمد. يبقى الدين والفاتورة كما هما.";

export function parseInvoiceArchiveCommand(value: unknown): InvoiceArchiveCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvoiceArchiveError("invalid", "طلب الأرشفة غير صالح.");
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some(key => !["action", "reason", "idempotencyKey", "expectedVersion"].includes(key))
    || (source.action !== "archive" && source.action !== "restore")
    || typeof source.reason !== "string" || source.reason.trim().length < 3 || source.reason.trim().length > 300
    || typeof source.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(source.idempotencyKey)
    || typeof source.expectedVersion !== "number" || !Number.isSafeInteger(source.expectedVersion) || source.expectedVersion < 0) {
    throw new InvoiceArchiveError("invalid", "راجع إجراء الأرشفة وسببها ومفتاح الطلب ونسخة المعاينة.");
  }
  return { action: source.action, reason: source.reason.trim(), idempotencyKey: source.idempotencyKey, expectedVersion: source.expectedVersion };
}

/** Recorded paid/open/cancelled state is never substituted for actual settlement. */
export function invoiceArchiveEligibility(_status: InvoiceArchiveView["status"], remainingMinor: number | null): InvoiceArchiveEligibility {
  if (remainingMinor === null || !Number.isSafeInteger(remainingMinor) || remainingMinor < 0 || remainingMinor > 0) {
    return { canArchive: false, code: "policy_decision_required", message: INVOICE_ARCHIVE_POLICY_MESSAGE, remainingMinor };
  }
  return { canArchive: true, code: null, message: null, remainingMinor };
}
