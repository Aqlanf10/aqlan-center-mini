import type { HrPayrollDisbursementView } from "./hr-payroll-shared";
import type { Currency } from "./money";

export interface PendingPayrollPayment {
  clientRequestId: string;
  itemId: number;
  amountMinor: number;
  remainingBefore: number;
  completed?: boolean;
  components: { salaryMinor: number; commissionMinor: number };
  paymentMethod: string;
  referenceNumber: string | null;
  notes: string | null;
}
type PayrollIdentity = { id: number; staffId: number; currency: Currency };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const instant = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const normalized = (value: string | null) => value?.trim() || null;

/** Stored requests are evidence of an uncertain operation, never a new item selection. */
export function readPendingPayrollPayment(value: unknown, itemId: number): PendingPayrollPayment | null {
  if (!record(value) || value.itemId !== itemId || !positive(itemId)
    || typeof value.clientRequestId !== "string" || value.clientRequestId.trim() !== value.clientRequestId
    || value.clientRequestId.length < 8 || value.clientRequestId.length > 100
    || !positive(value.amountMinor) || !nonnegative(value.remainingBefore) || value.amountMinor > value.remainingBefore
    || (value.completed !== undefined && typeof value.completed !== "boolean")
    || !record(value.components) || !nonnegative(value.components.salaryMinor) || !nonnegative(value.components.commissionMinor)
    || value.components.salaryMinor + value.components.commissionMinor !== value.amountMinor
    || value.paymentMethod !== "cash"
    || !(value.referenceNumber === null || (typeof value.referenceNumber === "string" && value.referenceNumber.length <= 100))
    || !(value.notes === null || (typeof value.notes === "string" && value.notes.length <= 1000))) return null;
  return value as unknown as PendingPayrollPayment;
}

/** Confirm the actual item, request, native currency and underlying vouchers. HTTP status alone is insufficient. */
export function readPayrollDisbursement(
  value: unknown, item: PayrollIdentity, request: PendingPayrollPayment,
): HrPayrollDisbursementView | null {
  if (!record(value) || !positive(value.id) || value.itemId !== item.id || value.itemId !== request.itemId
    || value.staffId !== item.staffId || !positive(value.staffId) || value.currency !== item.currency
    || value.clientRequestId !== request.clientRequestId || value.amountMinor !== request.amountMinor
    || value.paymentMethod !== request.paymentMethod || value.referenceNumber !== normalized(request.referenceNumber)
    || value.notes !== normalized(request.notes) || typeof value.disbursedBy !== "string" || !value.disbursedBy.trim()
    || !instant(value.disbursedAt) || !positive(value.expenseId) || !Array.isArray(value.parts)
    || value.parts.length < 1 || value.parts.length > 2) return null;
  const seen = new Set<string>(), vouchers = new Set<number>();
  let salary = 0, commission = 0;
  for (const part of value.parts) {
    if (!record(part) || (part.component !== "salary" && part.component !== "commission")
      || !positive(part.amountMinor) || !positive(part.expenseId) || !positive(part.payableId)
      || seen.has(part.component) || vouchers.has(part.expenseId)) return null;
    seen.add(part.component); vouchers.add(part.expenseId);
    if (part.component === "salary") salary += part.amountMinor; else commission += part.amountMinor;
  }
  if (!vouchers.has(value.expenseId) || salary !== request.components.salaryMinor
    || commission !== request.components.commissionMinor || salary + commission !== request.amountMinor) return null;
  const active = value.reversedAt === null && value.reversedBy === null && value.reversalReason === null;
  const reversed = instant(value.reversedAt) && typeof value.reversedBy === "string" && !!value.reversedBy.trim()
    && typeof value.reversalReason === "string" && !!value.reversalReason.trim();
  if (!active && !reversed) return null;
  return value as unknown as HrPayrollDisbursementView;
}

export function readPayrollPaymentConfirmation(
  payload: unknown, item: PayrollIdentity, request: PendingPayrollPayment,
): HrPayrollDisbursementView | null {
  if (!record(payload) || payload.success !== true) return null;
  const result = readPayrollDisbursement(payload.disbursement, item, request);
  return result?.reversedAt === null ? result : null;
}

export function readPayrollReversalConfirmation(
  payload: unknown, original: HrPayrollDisbursementView, reason: string,
): HrPayrollDisbursementView | null {
  if (!record(payload) || payload.success !== true) return null;
  const request: PendingPayrollPayment = { itemId: original.itemId, amountMinor: original.amountMinor,
    clientRequestId: original.clientRequestId ?? "", remainingBefore: original.amountMinor,
    paymentMethod: original.paymentMethod, referenceNumber: original.referenceNumber, notes: original.notes,
    components: { salaryMinor: 0, commissionMinor: 0 } };
  for (const part of original.parts) {
    if (part.component === "salary") request.components.salaryMinor += part.amountMinor;
    else request.components.commissionMinor += part.amountMinor;
  }
  const result = readPayrollDisbursement(payload.disbursement,
    { id: original.itemId, staffId: original.staffId, currency: original.currency }, request);
  if (!result || result.id !== original.id || !result.reversedAt || result.reversalReason !== reason.trim()
    || result.parts.length !== original.parts.length
    || result.parts.some(part => !original.parts.some(old => old.component === part.component
      && old.expenseId === part.expenseId && old.payableId === part.payableId && old.amountMinor === part.amountMinor))) return null;
  return result;
}
