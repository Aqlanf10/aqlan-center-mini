import { isCurrency, type Currency } from "./money";
import { isRefundBaseBudgetValid } from "./refund-base-allocation";
import { CurrencyIntentError, evaluateWrongCurrencyAmounts } from "./invoice-currency-intent";

/** A separate, non-activated arithmetic proposal. These identifiers do not
 * grant v1/v2 settlement evidence, a clinical seal, or write authority. */
export const CURRENCY_PREVIEW_POLICY = "wrong-currency-preview/1" as const;
export const CURRENCY_PREVIEW_GATES = Object.freeze([
  "DATABASE_OWNED_COMPLETE_LINEAGE_AND_ITEM_SNAPSHOT",
  "GLOBAL_RECEIPT_AND_REFUND_MEMBERSHIP_UNDER_PERMANENT_FENCES",
  "IMMUTABLE_FULL_RECEIPT_ROWS_AND_RECORDED_ROUNDING_POLICY",
  "VERSIONED_APPEND_ONLY_SETTLEMENT_EVIDENCE_AND_READERS",
  "CLINICAL_PLAN_COMMISSION_AND_INSTALLMENT_OWNERSHIP",
  "LIVE_AUTHORIZATION_PERIOD_LOCKS_AND_POST_LOCK_SOURCE_RECHECK",
  "ATOMIC_WRITER_ITEM_PAIRS_AND_VERSIONED_RETRY_ACKNOWLEDGMENT",
] as const);
function fail(code: string): never { throw new CurrencyIntentError(code); }
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  && Reflect.ownKeys(value).every(key => typeof key === "string"
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));
/** Reject sparse/accessor/custom-iterator containers before inspecting values. */
const denseArray = (value: unknown): value is unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field || field.enumerable !== true || !Object.hasOwn(field, "value")) return false;
  }
  return true;
};
const minor = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const id = (value: unknown): value is number => minor(value) && value > 0;
const ids = (value: unknown): value is number[] => denseArray(value) && value.every(id) && new Set(value).size === value.length;
const sameIds = (left: readonly number[], right: readonly number[]) => left.length === right.length && left.every(value => right.includes(value));
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const safe = (value: bigint) => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail("SETTLEMENT_OUT_OF_RANGE");
  return Number(value);
};
const negate = (value: number) => value === 0 ? 0 : -value;
const nullableText = (value: unknown) => value === null || typeof value === "string";
const utcMicroseconds = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);

/** Full flat payment row from the future authoritative adapter. BIGINT money
 * must already have been checked as safe integers, and NUMERIC rate retained as
 * text. Extra persisted columns are retained, not silently dropped. An adapter
 * must independently establish that this is a COMPLETE row from its snapshot. */
export interface CurrencyPreviewReceipt extends Record<string, string | number | null> {
  id: number; receipt_number: string; patient_id: number; invoice_id: number;
  plan_id: null; opening_currency: null; shift_id: number;
  kind: "payment" | "refund"; reversal_of_id: number | null;
  amount_minor: number; currency: Currency; base_amount_minor: number; base_currency: "YER";
  exchange_rate: string; method: string; note: string | null; created_by: string | null; created_at: string;
  idempotency_key: string | null; idempotency_request_hash: string | null;
}
export interface CurrencyPreviewReceiptSnapshot {
  version: "receipt-snapshot/1"; sourceHash: string; patientId: number;
  lineageInvoiceIds: readonly number[]; sourceItemIds: readonly number[];
  receiptIds: readonly number[]; priorTransitionDocumentIds: readonly number[];
  receipts: readonly CurrencyPreviewReceipt[];
  /** Exact GLOBAL direct refunds of every origin, including refunds incorrectly
   * attached outside this family. Never only filter the in-family refund list. */
  origins: readonly { paymentId: number; globalRefundIds: readonly number[] }[];
}

function readReceipt(value: unknown): CurrencyPreviewReceipt {
  if (!record(value) || !["id", "receipt_number", "patient_id", "invoice_id", "plan_id", "opening_currency", "shift_id", "kind",
    "reversal_of_id", "amount_minor", "currency", "base_amount_minor", "base_currency", "exchange_rate", "method", "note", "created_by",
    "created_at", "idempotency_key", "idempotency_request_hash"].every(key => Object.hasOwn(value, key)) || !id(value.id) || typeof value.receipt_number !== "string" || !value.receipt_number.trim()
    || !id(value.patient_id) || !id(value.invoice_id) || value.plan_id !== null || value.opening_currency !== null
    || !id(value.shift_id) || (value.kind !== "payment" && value.kind !== "refund")
    || !id(value.amount_minor) || !isCurrency(value.currency) || value.base_currency !== "YER" || !minor(value.base_amount_minor)
    || typeof value.exchange_rate !== "string" || !/^\d{1,12}(?:\.\d{1,6})?$/.test(value.exchange_rate)
    || !/[1-9]/.test(value.exchange_rate) || typeof value.method !== "string" || !value.method.trim()
    || !nullableText(value.note) || !nullableText(value.created_by) || !utcMicroseconds(value.created_at)
    || !nullableText(value.idempotency_key) || !nullableText(value.idempotency_request_hash)
    || (value.kind === "payment" ? value.reversal_of_id !== null : !id(value.reversal_of_id))
    || !Object.values(value).every(field => field === null || typeof field === "string"
      || typeof field === "number" && Number.isSafeInteger(field) && !Object.is(field, -0))) fail("INVALID_RECEIPT_FACTS");
  if (value.currency === "YER" && (value.amount_minor !== value.base_amount_minor
    || !/^0*1(?:\.0+)?$/.test(value.exchange_rate as string))) fail("INVALID_NATIVE_BASE_FACTS");
  return value as unknown as CurrencyPreviewReceipt;
}
const receiptJson = (row: CurrencyPreviewReceipt) => JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])));

/** Pure review preview, NEVER executable eligibility. Manifests and hashes here
 * are consistency claims from the supplied snapshot, not authentication. Even
 * empty histories retain every integration gate. No client boolean, copied hash
 * or hand-entered target amount can authorize/revalue a historical receipt.
 *
 * This tranche admits only a FIRST transition whose source AND target amounts
 * already exist in each receipt's native/base facts. Cross-foreign allocations,
 * neutral mixed-native families and existing transition evidence require later
 * independent versioned proof and deliberately refuse here. No FX is computed,
 * no rounding policy is changed, and no cash/receipt/refund operation is created. */
export function previewWrongCurrencyCorrection(input: unknown) {
  if (!record(input) || !exactKeys(input, ["source", "intent", "receiptSnapshot"])) fail("INVALID_PREVIEW_INPUT");
  const amounts = evaluateWrongCurrencyAmounts(input.source, input.intent);
  const value = input.receiptSnapshot;
  if (!record(value) || !exactKeys(value, ["version", "sourceHash", "patientId", "lineageInvoiceIds", "sourceItemIds", "receiptIds", "priorTransitionDocumentIds", "receipts", "origins"])
    || value.version !== "receipt-snapshot/1" || value.sourceHash !== amounts.sourceHash || value.patientId !== amounts.patientId
    || !ids(value.lineageInvoiceIds) || !value.lineageInvoiceIds.length || !value.lineageInvoiceIds.includes(amounts.invoiceId)
    || !ids(value.sourceItemIds) || !sameIds(value.sourceItemIds, amounts.lines.map(row => row.itemId))
    || !ids(value.receiptIds) || !ids(value.priorTransitionDocumentIds)
    || !denseArray(value.receipts) || !denseArray(value.origins)) fail("INCOMPLETE_RECEIPT_SNAPSHOT");
  const snapshot = value as unknown as CurrencyPreviewReceiptSnapshot;
  if (snapshot.priorTransitionDocumentIds.length) fail("PRIOR_TRANSITION_REQUIRES_VERSIONED_PROOF");
  const receipts = Array.from(snapshot.receipts).map(readReceipt);
  if (!sameIds(snapshot.receiptIds, receipts.map(row => row.id))
    || new Set(receipts.map(row => row.id)).size !== receipts.length
    || new Set(receipts.map(row => row.receipt_number)).size !== receipts.length
    || receipts.some(row => row.patient_id !== amounts.patientId || !snapshot.lineageInvoiceIds.includes(row.invoice_id))) fail("RECEIPT_MEMBERSHIP_MISMATCH");
  const originals = receipts.filter(row => row.kind === "payment");
  if (!Array.from(snapshot.origins).every(row => record(row) && exactKeys(row, ["paymentId", "globalRefundIds"]) && id(row.paymentId) && ids(row.globalRefundIds))
    || new Set(snapshot.origins.map(row => row.paymentId)).size !== snapshot.origins.length
    || !sameIds(snapshot.origins.map(row => row.paymentId), originals.map(row => row.id))) fail("GLOBAL_REFUND_MEMBERSHIP_MISMATCH");
  for (const refund of receipts.filter(row => row.kind === "refund")) {
    const origin = originals.find(row => row.id === refund.reversal_of_id);
    if (!origin || refund.invoice_id !== origin.invoice_id || refund.currency !== origin.currency
      || refund.base_currency !== origin.base_currency || refund.exchange_rate !== origin.exchange_rate
      || refund.created_at < origin.created_at) fail("INVALID_REFUND_ORIGIN");
  }
  for (const origin of originals) {
    const refunds = receipts.filter(row => row.kind === "refund" && row.reversal_of_id === origin.id);
    if (!sameIds(snapshot.origins.find(row => row.paymentId === origin.id)!.globalRefundIds, refunds.map(row => row.id))) fail("GLOBAL_REFUND_MEMBERSHIP_MISMATCH");
    const native = safe(refunds.reduce((sum, row) => sum + BigInt(row.amount_minor), 0n));
    const base = safe(refunds.reduce((sum, row) => sum + BigInt(row.base_amount_minor), 0n));
    if (!isRefundBaseBudgetValid({ originalAmountMinor: origin.amount_minor, originalBaseAmountMinor: origin.base_amount_minor,
      refundedAmountMinor: native, refundedBaseAmountMinor: base })) fail("REFUND_BUDGET_REQUIRES_REVIEW");
  }
  const stored = (row: CurrencyPreviewReceipt, currency: Currency, side: "SOURCE" | "TARGET") => {
    if (currency === row.currency) return { minor: row.amount_minor, basis: "recorded-native" as const };
    if (currency === row.base_currency) return { minor: row.base_amount_minor, basis: "recorded-base" as const };
    return fail(`${side}_SETTLEMENT_EVIDENCE_REQUIRED`);
  };
  const evidence = receipts.map(row => Object.freeze({ receiptId: row.id, originId: row.reversal_of_id ?? row.id,
    direction: row.kind === "payment" ? 1 as const : -1 as const,
    source: Object.freeze(stored(row, amounts.fromCurrency, "SOURCE")),
    target: Object.freeze(stored(row, amounts.toCurrency, "TARGET")),
    immutableReceiptJson: receiptJson(row) }));
  const sourceSettled = safe(evidence.reduce((sum, row) => sum + BigInt(row.direction) * BigInt(row.source.minor), 0n));
  const targetSettled = safe(evidence.reduce((sum, row) => sum + BigInt(row.direction) * BigInt(row.target.minor), 0n));
  const principalDeltas = Object.freeze([
    Object.freeze({ currency: amounts.fromCurrency, minor: negate(amounts.sourceNetMinor) }),
    Object.freeze({ currency: amounts.toCurrency, minor: amounts.targetNetMinor }),
  ]);
  const settlementDeltas = Object.freeze([
    Object.freeze({ currency: amounts.fromCurrency, minor: negate(sourceSettled) }),
    Object.freeze({ currency: amounts.toCurrency, minor: targetSettled }),
  ]);
  // Credits stay signed. These are DIFFERENT currency buckets, never summed.
  const debtDeltas = Object.freeze([
    Object.freeze({ currency: amounts.fromCurrency, minor: negate(amounts.sourceNetMinor - sourceSettled) }),
    Object.freeze({ currency: amounts.toCurrency, minor: amounts.targetNetMinor - targetSettled }),
  ]);
  // A deterministic content binding, NOT a signature, approval or durable
  // command. A later server contract must bind its own locked snapshot and key.
  const previewBinding = JSON.stringify({ policy: CURRENCY_PREVIEW_POLICY, amounts,
    lineageInvoiceIds: [...snapshot.lineageInvoiceIds].sort((a, b) => a - b),
    sourceItemIds: [...snapshot.sourceItemIds].sort((a, b) => a - b),
    receiptIds: [...snapshot.receiptIds].sort((a, b) => a - b),
    origins: snapshot.origins.map(row => ({ paymentId: row.paymentId, globalRefundIds: [...row.globalRefundIds].sort((a, b) => a - b) }))
      .sort((a, b) => a.paymentId - b.paymentId),
    receipts: [...evidence].sort((a, b) => a.receiptId - b.receiptId),
  });
  return Object.freeze({ kind: "arithmetic-preview-only" as const, executable: false as const, policy: CURRENCY_PREVIEW_POLICY,
    previewBinding, amounts, sourceSettledMinor: sourceSettled, targetSettledMinor: targetSettled,
    targetRemainingMinor: Math.max(0, amounts.targetNetMinor - targetSettled), targetCreditMinor: Math.max(0, targetSettled - amounts.targetNetMinor),
    principalDeltas, settlementDeltas, debtDeltas, cashOperations: Object.freeze([] as never[]),
    receiptEvidence: Object.freeze(evidence), requiredIntegrationGates: CURRENCY_PREVIEW_GATES });
}
