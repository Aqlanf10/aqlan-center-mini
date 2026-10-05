import { CLINIC_ZONE_FALLBACK } from "./clinicZone";
import { CLINIC_BASE_CURRENCY, isCurrency, parseAmount, type Currency } from "./money";
import { clinicDateString } from "./schedule";

export interface PreviewDraft {
  currency: Currency;
  agreedAmount: string;
  previouslyPaidAmount: string;
  historicalAsOf: string;
}

export interface OpeningSnapshot {
  currency: Currency;
  openingMinor: number;
  settledMinor: number;
  remainingMinor: number;
}

export interface PreviewReceipt {
  id: number;
  receiptNumber: string;
  invoiceId: number | null;
  planId?: number | null;
  openingCurrency?: Currency | null;
  kind: "payment" | "refund";
  amountMinor: number;
  currency: Currency;
  baseAmountMinor: number;
  method: string;
  createdAt: string;
}

export interface LegacyReconciliationPreview {
  draftState: "incomplete" | "invalid" | "valid";
  message: string | null;
  historical: null | {
    agreedMinor: number;
    previouslyPaidMinor: number;
    remainingMinor: number;
    historicalAsOf: string;
    currency: Currency;
  };
  recorded: { kind: "unavailable" | "absent" } | {
    kind: "available";
    position: OpeningSnapshot;
  };
  receipts: { kind: "unavailable" } | {
    kind: "available";
    recordedAfterCutoff: readonly PreviewReceipt[];
  };
  provenance: "unverified";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isOpeningSnapshot(value: unknown): value is OpeningSnapshot {
  return isRecord(value) && isCurrency(value.currency)
    && isSafeMinor(value.openingMinor) && isSafeMinor(value.settledMinor)
    && isSafeMinor(value.remainingMinor) && value.remainingMinor >= 0;
}

/** Reject calendar rollover and locale-dependent dates before doing any comparison. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
  const stamp = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(stamp.getTime()) && stamp.toISOString().slice(0, 10) === value;
}

function recordedPosition(
  positions: readonly OpeningSnapshot[] | undefined,
  currency: Currency,
): LegacyReconciliationPreview["recorded"] {
  if (!Array.isArray(positions)) return { kind: "unavailable" };
  const seen = new Set<Currency>();
  let selected: OpeningSnapshot | undefined;
  for (const position of positions) {
    // A malformed/duplicate payload cannot prove absence, including another currency's row.
    if (!isOpeningSnapshot(position) || seen.has(position.currency)) {
      return { kind: "unavailable" };
    }
    seen.add(position.currency);
    if (position.currency === currency) selected = position;
  }
  // These are server-supplied amounts. Never recompute net remaining or allocate the principal.
  return selected ? { kind: "available", position: { ...selected } } : { kind: "absent" };
}

function recordedClinicDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // The ledger supplies absolute ISO instants. A date-only/local timestamp has no safe zone.
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !isCalendarDate(match[1]) || Number(match[2]) > 23
    || Number(match[3]) > 59 || Number(match[4]) > 59) return null;
  const stamp = new Date(value);
  if (!Number.isFinite(stamp.getTime())) return null;
  const day = clinicDateString(stamp, CLINIC_ZONE_FALLBACK);
  return isCalendarDate(day) ? day : null;
}

function isPreviewReceipt(value: unknown): value is PreviewReceipt {
  return isRecord(value)
    && (value.invoiceId === null || (isSafeMinor(value.invoiceId) && value.invoiceId > 0))
    && (value.planId == null || (isSafeMinor(value.planId) && value.planId > 0))
    && (value.openingCurrency === null || isCurrency(value.openingCurrency))
    && isSafeMinor(value.id) && value.id > 0
    && typeof value.receiptNumber === "string" && Boolean(value.receiptNumber.trim())
    && (value.kind === "payment" || value.kind === "refund") && isCurrency(value.currency)
    && isSafeMinor(value.amountMinor) && value.amountMinor >= 0
    && isSafeMinor(value.baseAmountMinor) && value.baseAmountMinor >= 0
    && typeof value.method === "string" && Boolean(value.method.trim())
    && typeof value.createdAt === "string";
}

function recordedReceipts(
  payments: readonly PreviewReceipt[] | undefined,
  currency: Currency,
  cutoff: string,
): LegacyReconciliationPreview["receipts"] {
  if (!Array.isArray(payments)) return { kind: "unavailable" };
  const recordedAfterCutoff: PreviewReceipt[] = [];
  const seen = new Set<number>();
  for (const payment of payments) {
    if (!isPreviewReceipt(payment)) return { kind: "unavailable" };
    if (payment.openingCurrency === null) continue;
    if (payment.openingCurrency !== currency) continue;
    // Missing target fields stay unknown; only explicit null excludes a competing target.
    if (payment.invoiceId !== null || payment.planId !== null || seen.has(payment.id)
      || (payment.currency !== currency && currency !== CLINIC_BASE_CURRENCY)) {
      return { kind: "unavailable" };
    }
    seen.add(payment.id);
    const recordedDay = recordedClinicDate(payment.createdAt);
    if (recordedDay === null) return { kind: "unavailable" };
    // Strictly after the selected clinic day, not the UTC day or actual cash receipt date.
    if (recordedDay > cutoff) recordedAfterCutoff.push({ ...payment });
  }
  return { kind: "available", recordedAfterCutoff };
}

/**
 * Read-only comparison of one typed historical agreement with the existing ledger payload.
 * The ONLY derived money is agreed minus historically paid. Receipts never change that number.
 * An opening may aggregate multiple agreements. Equal amounts do not establish ownership.
 * Archive records and opening revision history are not inputs: provenance is always unverified.
 * Nothing here proposes a replacement opening, verifies a linkage, or prepares a financial write.
 */
export function previewLegacyReconciliation({ draft, today, positions, payments }: {
  draft: PreviewDraft;
  /** Current clinic calendar day, supplied explicitly so comparison never reads a clock. */
  today: string;
  positions?: readonly OpeningSnapshot[];
  payments?: readonly PreviewReceipt[];
}): LegacyReconciliationPreview {
  const result: LegacyReconciliationPreview = {
    draftState: "invalid",
    message: "بيانات المقارنة غير صالحة.",
    historical: null,
    recorded: { kind: "unavailable" },
    receipts: { kind: "unavailable" },
    provenance: "unverified",
  };
  if (!isRecord(draft) || !isCurrency(draft.currency)) {
    return { ...result, message: "اختر عملة معروفة للمقارنة." };
  }
  result.recorded = recordedPosition(positions, draft.currency);
  if (typeof today !== "string" || !isCalendarDate(today)) {
    return { ...result, message: "تعذّر التحقق من تاريخ اليوم في العيادة؛ المقارنة غير متاحة." };
  }
  if (typeof draft.agreedAmount !== "string" || typeof draft.previouslyPaidAmount !== "string"
    || typeof draft.historicalAsOf !== "string") return result;
  const agreed = draft.agreedAmount.trim();
  const paid = draft.previouslyPaidAmount.trim();
  const historicalAsOf = draft.historicalAsOf.trim();
  if (!agreed || !paid || !historicalAsOf) {
    return { ...result, draftState: "incomplete", message: "أكمل مبلغ الاتفاق والمدفوع سابقًا وتاريخ المعلومات للمقارنة." };
  }
  if (!isCalendarDate(historicalAsOf)) {
    return { ...result, message: "أدخل تاريخًا تقويميًا صحيحًا للمعلومات التاريخية." };
  }
  if (historicalAsOf > today) {
    return { ...result, message: "المعلومات التي تحمل تاريخًا مستقبليًا غير مدعومة؛ اختر اليوم أو تاريخًا سابقًا." };
  }
  const agreedMinor = parseAmount(agreed, draft.currency);
  const previouslyPaidMinor = parseAmount(paid, draft.currency);
  if (agreedMinor === null || previouslyPaidMinor === null) {
    return { ...result, message: "أدخل مبالغ صحيحة وغير سالبة ضمن الحدود الآمنة." };
  }
  if (previouslyPaidMinor > agreedMinor) {
    return { ...result, message: "المدفوع سابقًا أكبر من الاتفاق؛ الرصيد الدائن التاريخي يحتاج مراجعة مستقلة." };
  }
  return {
    ...result,
    draftState: "valid",
    message: null,
    historical: {
      agreedMinor,
      previouslyPaidMinor,
      remainingMinor: agreedMinor - previouslyPaidMinor,
      historicalAsOf,
      currency: draft.currency,
    },
    receipts: recordedReceipts(payments, draft.currency, historicalAsOf),
  };
}
