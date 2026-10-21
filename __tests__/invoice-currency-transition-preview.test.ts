import { describe, expect, it } from "vitest";
import { CURRENCIES, MINOR_UNITS, type Currency } from "../lib/money";
import { previewWrongCurrencyCorrection, CURRENCY_PREVIEW_GATES, type CurrencyPreviewReceipt, type CurrencyPreviewReceiptSnapshot } from "../lib/invoice-currency-transition-preview";
const directions = CURRENCIES.flatMap(from => CURRENCIES.filter(to => from !== to).map(to => [from, to] as const));
const receipt = (change: Partial<CurrencyPreviewReceipt> = {}): CurrencyPreviewReceipt => ({
  id: 1, receipt_number: "SYNTHETIC-R1", patient_id: 7, invoice_id: 10, plan_id: null, opening_currency: null, shift_id: 5,
  kind: "payment", reversal_of_id: null, amount_minor: 1000, currency: "SAR", base_amount_minor: 4100, base_currency: "YER",
  exchange_rate: "410.000000", method: "cash", note: "Original receipt fact", created_by: "Synthetic actor",
  created_at: "2026-01-01T10:00:00.123456Z", idempotency_key: "synthetic-key", idempotency_request_hash: "b".repeat(64), ...change,
});
const refund = (change: Partial<CurrencyPreviewReceipt> = {}): CurrencyPreviewReceipt => receipt({ id: 2, receipt_number: "SYNTHETIC-R2", kind: "refund", reversal_of_id: 1, amount_minor: 250, base_amount_minor: 1025, created_at: "2026-01-01T10:00:01.123456Z", ...change });
function fixture(fromCurrency: Currency = "YER", toCurrency: Currency = "SAR", receipts: CurrencyPreviewReceipt[] = []) {
  const source = { patientId: 7, invoiceId: 10, sourceHash: "a".repeat(64), currency: fromCurrency, totalMinor: 100 * MINOR_UNITS[fromCurrency], discountMinor: 0,
    lines: [{ itemId: 31, quantity: 1, unitPriceMinor: 100 * MINOR_UNITS[fromCurrency] }] };
  const intent = { version: 1, purpose: "wrong-currency", mode: "preserve-numerals", fromCurrency, toCurrency, reason: "Explicit wrong-currency review" };
  const receiptSnapshot: CurrencyPreviewReceiptSnapshot = { version: "receipt-snapshot/1", patientId: 7, sourceHash: source.sourceHash,
    lineageInvoiceIds: [9, 10], sourceItemIds: [31], receiptIds: receipts.map(row => row.id), priorTransitionDocumentIds: [], receipts,
    origins: receipts.filter(row => row.kind === "payment").map(row => ({ paymentId: row.id, globalRefundIds: receipts.filter(refund => refund.reversal_of_id === row.id).map(refund => refund.id) })) };
  return { source, intent, receiptSnapshot };
}
const code = (fn: () => unknown, expected: string) => expect(fn).toThrowError(expect.objectContaining({ code: expected }));
describe("non-activated six-direction transition preview", () => {
  it.each(directions)("previews unpaid %s → %s but NEVER grants execution", (from, to) => {
    const result = previewWrongCurrencyCorrection(fixture(from, to));
    expect(result).toMatchObject({ kind: "arithmetic-preview-only", executable: false, targetSettledMinor: 0, targetRemainingMinor: 100 * MINOR_UNITS[to], targetCreditMinor: 0 });
    expect(result.receiptEvidence).toEqual([]); expect(result.cashOperations).toEqual([]);
    expect(result.requiredIntegrationGates).toEqual(CURRENCY_PREVIEW_GATES); expect(result.requiredIntegrationGates).toHaveLength(7);
    expect(result).not.toHaveProperty("idempotencyKey"); expect(result).not.toHaveProperty("correctedInvoice");
  });
  it.each([["YER", "SAR", "SAR"], ["YER", "USD", "USD"], ["SAR", "YER", "SAR"], ["USD", "YER", "USD"]] as const)("uses native/base facts for %s → %s", (from, to, native) => {
    const result = previewWrongCurrencyCorrection(fixture(from, to, [receipt({ currency: native }), refund({ currency: native })]));
    expect(result.sourceSettledMinor).toBe(from === "YER" ? 3075 : 750); expect(result.targetSettledMinor).toBe(to === "YER" ? 3075 : 750);
    expect(result.receiptEvidence.map(row => [row.source.basis, row.target.basis])).toEqual(Array(2).fill(from === "YER" ? ["recorded-base", "recorded-native"] : ["recorded-native", "recorded-base"]));
    expect(result.executable).toBe(false); expect(result.cashOperations).toEqual([]);
  });
  it.each([["SAR", "USD"], ["USD", "SAR"]] as const)("refuses paid %s → %s absent source/target proof", (from, to) => {
    code(() => previewWrongCurrencyCorrection(fixture(from, to, [receipt({ currency: from })])), "TARGET_SETTLEMENT_EVIDENCE_REQUIRED");
    code(() => previewWrongCurrencyCorrection(fixture(from, to, [receipt({ currency: to })])), "SOURCE_SETTLEMENT_EVIDENCE_REQUIRED");
  });
  it("reviewed invoice prices do not prove historical receipt allocation", () => {
    const input = fixture("SAR", "USD", [receipt()]);
    code(() => previewWrongCurrencyCorrection({ ...input, intent: { ...input.intent, mode: "reviewed-target-amounts", lines: [{ itemId: 31, unitPrice: "1" }], discount: "0" } }), "TARGET_SETTLEMENT_EVIDENCE_REQUIRED");
  });
  it("refuses mixed-native, including neutral groups lacking versioned proof", () => {
    const native = receipt({ id: 3, receipt_number: "SYNTHETIC-R3", currency: "YER", amount_minor: 100, base_amount_minor: 100, exchange_rate: "1.000000" });
    const nativeRefund = refund({ id: 4, receipt_number: "SYNTHETIC-R4", reversal_of_id: 3, currency: "YER", amount_minor: 100, base_amount_minor: 100, exchange_rate: "1.000000" });
    for (const rows of [[receipt(), native], [receipt(), native, nativeRefund]]) code(() => previewWrongCurrencyCorrection(fixture("YER", "SAR", rows)), "TARGET_SETTLEMENT_EVIDENCE_REQUIRED");
  });
  it("keeps zero base and independent recorded rates without revaluation", () => {
    const rows = [receipt({ amount_minor: 1, base_amount_minor: 0, exchange_rate: "0.100000" }), receipt({ id: 3, receipt_number: "SYNTHETIC-R3", exchange_rate: "500.000000", base_amount_minor: 5000 })];
    const result = previewWrongCurrencyCorrection(fixture("SAR", "YER", rows));
    expect(result).toMatchObject({ sourceSettledMinor: 1001, targetSettledMinor: 5000 });
    expect(result.receiptEvidence[0].target).toEqual({ minor: 0, basis: "recorded-base" });
    expect(JSON.parse(result.receiptEvidence[0].immutableReceiptJson)).toMatchObject({ exchange_rate: "0.100000", base_amount_minor: 0 });
    expect(result.requiredIntegrationGates).toContain("IMMUTABLE_FULL_RECEIPT_ROWS_AND_RECORDED_ROUNDING_POLICY");
  });
  it("conserves separate currency buckets including credit, without cash", () => {
    const result = previewWrongCurrencyCorrection(fixture("YER", "SAR", [receipt({ amount_minor: 15000, base_amount_minor: 61500 })]));
    expect(result).toMatchObject({ targetRemainingMinor: 0, targetCreditMinor: 5000 });
    expect(result.principalDeltas).toEqual([{ currency: "YER", minor: -100 }, { currency: "SAR", minor: 10000 }]);
    expect(result.settlementDeltas).toEqual([{ currency: "YER", minor: -61500 }, { currency: "SAR", minor: 15000 }]);
    expect(result.debtDeltas).toEqual([{ currency: "YER", minor: 61400 }, { currency: "SAR", minor: -5000 }]);
    for (let i = 0; i < 2; i++) expect(result.debtDeltas[i].minor).toBe(result.principalDeltas[i].minor - result.settlementDeltas[i].minor);
    expect(result.cashOperations).toEqual([]);
  });
});
describe("whole-document and immutable receipt requirements", () => {
  it.each([undefined, null, {}, { approved: true }])("absent proof is not no receipts %j", receiptSnapshot => code(() => previewWrongCurrencyCorrection({ ...fixture(), receiptSnapshot }), "INCOMPLETE_RECEIPT_SNAPSHOT"));
  it.each([
    { sourceHash: "b".repeat(64) }, { version: "receipt-snapshot/2" }, { patientId: 8 }, { lineageInvoiceIds: [] }, { lineageInvoiceIds: [9] },
    { lineageInvoiceIds: [10, 10] }, { sourceItemIds: [] }, { sourceItemIds: [31, 32] }, { sourceItemIds: [31, 31] }, { approved: true }, { receiptIds: [1, 1] }, { priorTransitionDocumentIds: [0] },
  ])("validates membership even without receipts %j", change => { const input = fixture(); code(() => previewWrongCurrencyCorrection({ ...input, receiptSnapshot: { ...input.receiptSnapshot, ...change } }), "INCOMPLETE_RECEIPT_SNAPSHOT"); });
  it("refuses prior transitions even without receipts", () => { const input = fixture(); input.receiptSnapshot.priorTransitionDocumentIds = [1]; code(() => previewWrongCurrencyCorrection(input), "PRIOR_TRANSITION_REQUIRES_VERSIONED_PROOF"); });
  it("forbids approval/rate/execution escape fields", () => { for (const extra of [{ exchangeRate: 500 }, { approved: true }, { executable: true }]) code(() => previewWrongCurrencyCorrection({ ...fixture(), ...extra }), "INVALID_PREVIEW_INPUT"); });
  it.each([{ patient_id: 8 }, { invoice_id: 999 }, { id: 2 }, { receipt_number: "SYNTHETIC-R2" }])("rejects detached/duplicate membership %j", change => {
    const input = fixture("YER", "SAR", [receipt(), refund()]); input.receiptSnapshot.receipts = [{ ...receipt(), ...change }, refund()];
    code(() => previewWrongCurrencyCorrection(input), "RECEIPT_MEMBERSHIP_MISMATCH");
  });
  it.each([
    { invoice_id: null }, { plan_id: 2 }, { opening_currency: "YER" }, { amount_minor: 0 }, { amount_minor: -1 }, { amount_minor: 0.5 },
    { amount_minor: Number.MAX_SAFE_INTEGER + 1 }, { base_amount_minor: -1 }, { base_currency: "USD" }, { currency: "EUR" },
    { exchange_rate: 410 }, { exchange_rate: "0" }, { exchange_rate: "1e3" }, { exchange_rate: "-1" }, { exchange_rate: "1.0000001" },
    { created_at: "2026-02-31T10:00:00.000000Z" }, { created_at: "2026-01-01T10:00:00Z" }, { created_at: "2026-01-01T10:00:00.123456+00:00" },
    { created_by: undefined }, { receipt_number: "" }, { shift_id: 0 }, { method: "" }, { kind: "adjustment" }, { reversal_of_id: 2 }, { note: {} }, { future_column: Infinity },
  ])("rejects malformed/lossy receipt %j", change => code(() => previewWrongCurrencyCorrection(fixture("YER", "SAR", [{ ...receipt(), ...change } as CurrencyPreviewReceipt])), "INVALID_RECEIPT_FACTS"));
  it("refuses conflicting native YER base/rate", () => {
    for (const row of [receipt({ currency: "YER", exchange_rate: "1" }), receipt({ currency: "YER", base_amount_minor: 1000, exchange_rate: "2" })]) code(() => previewWrongCurrencyCorrection(fixture("YER", "SAR", [row])), "INVALID_NATIVE_BASE_FACTS");
  });
  it("requires exact union and GLOBAL direct refund membership, including empty origin sets", () => {
    const input = fixture("YER", "SAR", [receipt(), refund()]);
    for (const receiptIds of [[1], [1, 2, 3]]) code(() => previewWrongCurrencyCorrection({ ...input, receiptSnapshot: { ...input.receiptSnapshot, receiptIds } }), "RECEIPT_MEMBERSHIP_MISMATCH");
    for (const origins of [[], [{ paymentId: 1, globalRefundIds: [] }], [{ paymentId: 1, globalRefundIds: [2, 999] }], [{ paymentId: 1, globalRefundIds: [2, 2] }], [{ paymentId: 1, globalRefundIds: [2] }, { paymentId: 1, globalRefundIds: [2] }]]) code(() => previewWrongCurrencyCorrection({ ...input, receiptSnapshot: { ...input.receiptSnapshot, origins } }), "GLOBAL_REFUND_MEMBERSHIP_MISMATCH");
    const missingEmpty = fixture("YER", "SAR", [receipt()]); missingEmpty.receiptSnapshot.origins = [];
    code(() => previewWrongCurrencyCorrection(missingEmpty), "GLOBAL_REFUND_MEMBERSHIP_MISMATCH");
  });
  it.each([{ reversal_of_id: 999 }, { reversal_of_id: 2 }, { invoice_id: 9 }, { currency: "USD" }, { exchange_rate: "411.000000" }, { created_at: "2026-01-01T10:00:00.123455Z" }])("rejects orphan/cross-origin/refund before origin %j", change => code(() => previewWrongCurrencyCorrection(fixture("YER", "SAR", [receipt(), refund(change as Partial<CurrencyPreviewReceipt>)])), "INVALID_REFUND_ORIGIN"));
  it("retains complete facts including extra columns and exact microseconds, detached and immutable", () => {
    const rows = [receipt({ extra_persisted_column: "do not discard" }), refund({ created_at: "2026-01-01T10:00:00.123457Z" })];
    const input = fixture("YER", "SAR", rows), before = structuredClone(input), result = previewWrongCurrencyCorrection(input);
    expect(input).toEqual(before); expect(JSON.parse(result.receiptEvidence[0].immutableReceiptJson)).toEqual(rows[0]);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.receiptEvidence)).toBe(true); expect(Object.isFrozen(result.receiptEvidence[0].source)).toBe(true);
    rows[0].note = "changed after preview"; expect(JSON.parse(result.receiptEvidence[0].immutableReceiptJson).note).toBe("Original receipt fact");
    expect(previewWrongCurrencyCorrection(input).previewBinding).not.toBe(result.previewBinding);
  });
  it("binds intent/source/membership/policy but cannot authenticate supplied claims", () => {
    const input = fixture(), result = previewWrongCurrencyCorrection(input);
    expect(result.previewBinding).toBe(previewWrongCurrencyCorrection(input).previewBinding);
    const changed = structuredClone(input); changed.receiptSnapshot.lineageInvoiceIds = [8, 9, 10]; expect(previewWrongCurrencyCorrection(changed).previewBinding).not.toBe(result.previewBinding);
    const reason = structuredClone(input); reason.intent.reason = "Different review"; expect(previewWrongCurrencyCorrection(reason).previewBinding).not.toBe(result.previewBinding);
    expect(JSON.parse(result.previewBinding).policy).toBe("wrong-currency-preview/1");
    expect(previewWrongCurrencyCorrection({ ...input, intent: { ...input.intent, mode: "reviewed-target-amounts", lines: [{ itemId: 31, unitPrice: "100" }], discount: "0" } }).previewBinding).not.toBe(result.previewBinding);
    const reordered = fixture("YER", "SAR", [receipt(), refund()]), first = previewWrongCurrencyCorrection(reordered);
    reordered.receiptSnapshot.receipts = [...reordered.receiptSnapshot.receipts].reverse(); reordered.receiptSnapshot.receiptIds = [2, 1]; reordered.receiptSnapshot.lineageInvoiceIds = [10, 9];
    expect(previewWrongCurrencyCorrection(reordered).previewBinding).toBe(first.previewBinding); expect(result.executable).toBe(false);
  });
});
describe("conserved stored refund budgets, without rewriting v1", () => {
  it.each([[1001, 4100], [1000, 4101], [1000, 4099], [250, 4101]])("refuses native/base overrun or exhausted residual %i/%i", (amount_minor, base_amount_minor) => code(() => previewWrongCurrencyCorrection(fixture("YER", "SAR", [receipt(), refund({ amount_minor, base_amount_minor })])), "REFUND_BUDGET_REQUIRES_REVIEW"));
  it("accepts stored cumulative rounding and zero base without re-rounding refunds", () => {
    const original = receipt({ amount_minor: 3, base_amount_minor: 4, exchange_rate: "133.333333" });
    const first = refund({ amount_minor: 1, base_amount_minor: 1, exchange_rate: "133.333333" });
    const second = refund({ id: 3, receipt_number: "SYNTHETIC-R3", amount_minor: 1, base_amount_minor: 2, exchange_rate: "133.333333" });
    expect(previewWrongCurrencyCorrection(fixture("YER", "SAR", [original, first, second]))).toMatchObject({ sourceSettledMinor: 1, targetSettledMinor: 1, executable: false });
    expect(previewWrongCurrencyCorrection(fixture("YER", "SAR", [receipt({ amount_minor: 3, base_amount_minor: 1 }), refund({ amount_minor: 1, base_amount_minor: 0 })]))).toMatchObject({ sourceSettledMinor: 1, targetSettledMinor: 2 });
  });
  it("aggregates all refunds, not each in isolation", () => {
    const rows = [receipt(), refund({ amount_minor: 600, base_amount_minor: 2460 }), refund({ id: 3, receipt_number: "SYNTHETIC-R3", amount_minor: 600, base_amount_minor: 2460 })];
    code(() => previewWrongCurrencyCorrection(fixture("YER", "SAR", rows)), "REFUND_BUDGET_REQUIRES_REVIEW");
  });
  it("refuses v1-compatible exhausted excess-base history only within this new proposal", () => {
    const original = receipt({ amount_minor: 3, base_amount_minor: 14, exchange_rate: "450.000000" });
    const refunds = [2, 3, 4].map(id => refund({ id, receipt_number: `SYNTHETIC-R${id}`, amount_minor: 1, base_amount_minor: 5, exchange_rate: "450.000000" }));
    code(() => previewWrongCurrencyCorrection(fixture("YER", "SAR", [original, ...refunds])), "REFUND_BUDGET_REQUIRES_REVIEW");
  });
  it("rejects settlement overflow without clamping", () => {
    const rows = [receipt({ amount_minor: Number.MAX_SAFE_INTEGER, base_amount_minor: 0 }), receipt({ id: 3, receipt_number: "SYNTHETIC-R3", amount_minor: 1, base_amount_minor: 0 })];
    code(() => previewWrongCurrencyCorrection(fixture("YER", "SAR", rows)), "SETTLEMENT_OUT_OF_RANGE");
  });
});

it("refuses sparse manifests, inherited/hidden receipt facts, accessors and coercible kinds", () => {
  const input = fixture("YER", "SAR", [receipt()]);
  for (const change of [{ sourceItemIds: new Array(1) }, { receiptIds: new Array(1) }, { lineageInvoiceIds: Object.assign(new Array(2), { 1: 10 }) }, { priorTransitionDocumentIds: new Array(1) }]) {
    code(() => previewWrongCurrencyCorrection({ ...input, receiptSnapshot: { ...input.receiptSnapshot, ...change } }), "INCOMPLETE_RECEIPT_SNAPSHOT");
  }
  code(() => previewWrongCurrencyCorrection({ ...input, receiptSnapshot: { ...input.receiptSnapshot, receipts: new Array(1) } }), "INCOMPLETE_RECEIPT_SNAPSHOT");
  code(() => previewWrongCurrencyCorrection({ ...input, receiptSnapshot: { ...input.receiptSnapshot, origins: new Array(1) } }), "INCOMPLETE_RECEIPT_SNAPSHOT");
  code(() => previewWrongCurrencyCorrection({ ...input, receiptSnapshot: { ...input.receiptSnapshot, origins: [{ paymentId: 1, globalRefundIds: new Array(1) }] } }), "GLOBAL_REFUND_MEMBERSHIP_MISMATCH");
  const inherited = Object.create(receipt());
  code(() => previewWrongCurrencyCorrection(fixture("YER", "SAR", [inherited])), "INVALID_RECEIPT_FACTS");
  const hidden = receipt(); Object.defineProperty(hidden, "note", { value: "hidden", enumerable: false });
  code(() => previewWrongCurrencyCorrection(fixture("YER", "SAR", [hidden])), "INVALID_RECEIPT_FACTS");
  const getter = receipt(); let read = false;
  Object.defineProperty(getter, "note", { enumerable: true, get: () => { read = true; return "secret"; } });
  code(() => previewWrongCurrencyCorrection(fixture("YER", "SAR", [getter])), "INVALID_RECEIPT_FACTS"); expect(read).toBe(false);
  code(() => previewWrongCurrencyCorrection(fixture("YER", "SAR", [receipt({ kind: { toString: () => "payment" } } as unknown as Partial<CurrencyPreviewReceipt>)])), "INVALID_RECEIPT_FACTS");
  code(() => previewWrongCurrencyCorrection(fixture("YER", "SAR", [receipt({ base_amount_minor: -0 })])), "INVALID_RECEIPT_FACTS");
});

it("never trusts custom array iterators or invokes accessor slots", () => {
  const input = fixture("YER", "SAR", [receipt()]);
  const fakeIds = new Array(1); Object.defineProperty(fakeIds, Symbol.iterator, { value: function* () { yield 31; } });
  code(() => previewWrongCurrencyCorrection({ ...input, receiptSnapshot: { ...input.receiptSnapshot, sourceItemIds: fakeIds } }), "INCOMPLETE_RECEIPT_SNAPSHOT");
  const hiddenReceipts = [receipt()]; Object.defineProperty(hiddenReceipts, Symbol.iterator, { value: function* () {} });
  code(() => previewWrongCurrencyCorrection({ ...fixture(), receiptSnapshot: { ...fixture().receiptSnapshot, receipts: hiddenReceipts } }), "INCOMPLETE_RECEIPT_SNAPSHOT");
  let read = false; const accessors = [31]; Object.defineProperty(accessors, "0", { enumerable: true, get: () => { read = true; return 31; } });
  code(() => previewWrongCurrencyCorrection({ ...input, receiptSnapshot: { ...input.receiptSnapshot, sourceItemIds: accessors } }), "INCOMPLETE_RECEIPT_SNAPSHOT"); expect(read).toBe(false);
});
