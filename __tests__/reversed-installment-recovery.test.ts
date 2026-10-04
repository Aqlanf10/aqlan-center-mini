import { describe, expect, it } from "vitest";
import { toBaseAmount, type Currency } from "../lib/money";
import {
  REVERSED_INSTALLMENT_RECOVERY_PURPOSE as PURPOSE, parseRecoveryIntent,
  projectReversedInstallmentRecovery as project, recoveryIntentFingerprintSource,
  type RecoveryIntent, type RecoveryPaymentSnapshot, type RecoverySnapshot,
} from "../lib/reversed-installment-recovery";

function receipt(extra: Partial<RecoveryPaymentSnapshot> = {}): RecoveryPaymentSnapshot {
  const row: RecoveryPaymentSnapshot = {
    id: 101, patientId: 1, invoiceId: 11, planId: 21, openingCurrency: null,
    kind: "payment", reversalOfId: null, amountMinor: 7_000, currency: "SAR",
    baseAmountMinor: 9_800, baseCurrency: "YER", exchangeRate: 140, ...extra,
  };
  row.baseAmountMinor = extra.baseAmountMinor ?? toBaseAmount(row.amountMinor, row.currency, row.baseCurrency, row.exchangeRate);
  return row;
}
function fixture(reversedMinor = 7_000): RecoverySnapshot {
  const origin = receipt();
  return {
    complete: true,
    invoice: { id: 11, patientId: 1, planId: 21, status: "paid", totalMinor: 7_000, discountMinor: 0, baseCurrency: "SAR" },
    plan: { id: 21, patientId: 1, baseCurrency: "SAR", status: "active" },
    payments: [origin, receipt({ id: 102, kind: "refund", reversalOfId: 101, amountMinor: reversedMinor })],
    creationAudits: [{ id: 501, action: "payment.create", entity: "payment", entityId: "101", details: {
      المريض: 1, المبلغ: origin.amountMinor, العملة: origin.currency, سعر_الصرف: origin.exchangeRate,
      المكافئ: origin.baseAmountMinor, الطريقة: "cash", الخطة: 21, قسط: 1, فاتورة_القسط: 11,
    } }],
    account: { patientId: 1, currency: "SAR", dueMinor: reversedMinor },
  };
}
function addPayment(input: RecoverySnapshot, extra: Partial<RecoveryPaymentSnapshot>) {
  input.payments = [...input.payments, receipt(extra)];
}
function replaceDetails(input: RecoverySnapshot, extra: Record<string, unknown>) {
  input.creationAudits = [{ ...input.creationAudits[0], details: {
    ...(input.creationAudits[0].details as Record<string, unknown>), ...extra,
  } }];
}

describe("explicit reversed-installment recovery projection", () => {
  it.each([7_000, 2_000])("preserves the original invoice and plan for a proven %i-minor reversal", (amount) => {
    const input = fixture(amount);
    const untouched = structuredClone(input);
    expect(project(input)).toEqual({
      kind: "recoverable", purpose: PURPOSE, patientId: 1, invoiceId: 11, planId: 21,
      originPaymentId: 101, creationAuditId: 501, currency: "SAR", rawInvoiceStatus: "paid",
      principalMinor: 7_000, linkedNetPaidMinor: 7_000 - amount, remainingMinor: amount,
      actualAccountDueMinor: amount, suggestedCashMinor: amount, accountCreditReview: false,
      reversalPaymentIds: [102],
    });
    expect(input).toEqual(untouched);
  });

  it("uses the current linked remainder after a partial explicit recovery", () => {
    const input = fixture(2_000);
    addPayment(input, { id: 103, amountMinor: 1_000 });
    input.account.dueMinor = 1_000;
    expect(project(input)).toMatchObject({ kind: "recoverable", remainingMinor: 1_000, linkedNetPaidMinor: 6_000, suggestedCashMinor: 1_000 });
  });

  it.each(["completed", "cancelled"] as const)("retains issued-invoice recovery when its plan is %s", (status) => {
    const input = fixture(); input.plan!.status = status;
    expect(project(input)).toMatchObject({ kind: "recoverable", planId: 21 });
  });

  it("supports a manually reopened original without changing its raw status", () => {
    const input = fixture(); input.invoice.status = "open";
    expect(project(input)).toMatchObject({ kind: "recoverable", rawInvoiceStatus: "open" });
  });

  it("never revives a cancelled original", () => {
    const input = fixture(); input.invoice.status = "cancelled";
    expect(project(input)).toEqual({ kind: "excluded", reason: "cancelled_invoice" });
  });

  it("does not reinterpret manual paid status without a linked reversal", () => {
    const input = fixture(); input.payments = []; input.creationAudits = [];
    expect(project(input)).toEqual({ kind: "excluded", reason: "no_reversal" });
  });

  it("does not offer a corrected paid replacement covered by receipts on the cancelled original", () => {
    const input = fixture(); input.invoice.id = 12; input.payments = []; input.creationAudits = [];
    expect(project(input)).toEqual({ kind: "excluded", reason: "no_reversal" });
  });

  it("excludes non-plan and zero-principal documents", () => {
    const noPlan = fixture(); noPlan.invoice.planId = null;
    expect(project(noPlan)).toEqual({ kind: "excluded", reason: "not_plan_invoice" });
    const zero = fixture(); zero.invoice.totalMinor = 0;
    expect(project(zero)).toEqual({ kind: "excluded", reason: "zero_principal" });
  });

  it("includes all paired replacement receipts before deciding whether anything remains", () => {
    const equal = fixture(); addPayment(equal, { id: 103, amountMinor: 7_000 }); equal.account.dueMinor = 0;
    expect(project(equal)).toEqual({ kind: "excluded", reason: "settled" });
    const lower = fixture(); addPayment(lower, { id: 103, amountMinor: 5_000 }); lower.account.dueMinor = 2_000;
    expect(project(lower)).toMatchObject({ kind: "recoverable", remainingMinor: 2_000, linkedNetPaidMinor: 5_000 });
  });

  it("handles a later refund of a correctly associated recovery through its actual origin", () => {
    const input = fixture();
    addPayment(input, { id: 103, amountMinor: 7_000 });
    addPayment(input, { id: 104, kind: "refund", reversalOfId: 103, amountMinor: 1_000 });
    input.account.dueMinor = 1_000;
    expect(project(input)).toMatchObject({ kind: "recoverable", originPaymentId: 101, remainingMinor: 1_000, reversalPaymentIds: [102, 104] });
  });

  it("surfaces an already lost plan association instead of rewriting old invoice-only receipts", () => {
    const input = fixture(); addPayment(input, { id: 103, planId: null, amountMinor: 7_000 }); input.account.dueMinor = 0;
    expect(project(input)).toEqual({ kind: "review_required", reason: "historical_plan_attribution_gap" });
    expect(input.payments[2].planId).toBeNull();
  });

  it.each([3_000, 0, -2_000])("caps automatic cash against actual bucket due %i and flags the credit discrepancy", (dueMinor) => {
    const input = fixture(); input.account.dueMinor = dueMinor;
    expect(project(input)).toMatchObject({ kind: "recoverable", remainingMinor: 7_000,
      actualAccountDueMinor: dueMinor, suggestedCashMinor: Math.max(0, dueMinor), accountCreditReview: true });
  });

  it("does not inflate an invoice recovery when other invoices increase account due", () => {
    const input = fixture(2_000); input.account.dueMinor = 20_000;
    expect(project(input)).toMatchObject({ kind: "recoverable", remainingMinor: 2_000, suggestedCashMinor: 2_000, accountCreditReview: false });
  });

  it.each(["SAR", "USD"] as const)("settles %s invoices in the same nominal currency", (currency) => {
    const input = fixture(); input.invoice.baseCurrency = currency; input.plan!.baseCurrency = currency; input.account.currency = currency;
    input.payments = input.payments.map((row) => receipt({ ...row, currency, exchangeRate: 530, baseAmountMinor: 37_100 }));
    replaceDetails(input, { العملة: currency, سعر_الصرف: 530, المكافئ: 37_100 });
    expect(project(input)).toMatchObject({ kind: "recoverable", currency, remainingMinor: 7_000 });
  });

  it("settles a YER invoice using original recorded foreign FX, with no current-settings input", () => {
    const input = fixture(2_000); input.invoice.baseCurrency = "YER"; input.invoice.totalMinor = 9_800;
    input.plan!.baseCurrency = "YER"; input.account = { patientId: 1, currency: "YER", dueMinor: 2_800 };
    expect(project(input)).toMatchObject({ kind: "recoverable", currency: "YER", principalMinor: 9_800, remainingMinor: 2_800 });
  });

  it("refuses foreign-to-foreign settlement instead of guessing a rate", () => {
    const input = fixture(); input.payments[0].currency = "USD"; input.payments[1].currency = "USD";
    expect(project(input)).toEqual({ kind: "review_required", reason: "unsupported_settlement" });
  });

  it("rejects a refund carrying today's different FX rather than its origin snapshot", () => {
    const input = fixture(); input.payments = [input.payments[0], receipt({ id: 102, kind: "refund", reversalOfId: 101, exchangeRate: 150 })];
    expect(project(input)).toEqual({ kind: "review_required", reason: "invalid_refund_lineage" });
  });

  it.each([
    { rawRate: 140.1234567, storedRate: 140.123457, amountMinor: 7_000, baseAmountMinor: 9_809 },
    { rawRate: 140.4999996, storedRate: 140.5, amountMinor: 100, baseAmountMinor: 140 },
  ])("requires review for valid precision drift at rate $rawRate without reconstructing recorded money", ({ rawRate, storedRate, amountMinor, baseAmountMinor }) => {
    const input = fixture();
    input.invoice.totalMinor = amountMinor;
    input.account.dueMinor = amountMinor;
    input.payments = [
      receipt({ amountMinor, exchangeRate: storedRate, baseAmountMinor }),
      receipt({ id: 102, kind: "refund", reversalOfId: 101, amountMinor, exchangeRate: storedRate }),
    ];
    replaceDetails(input, { المبلغ: amountMinor, سعر_الصرف: rawRate, المكافئ: baseAmountMinor });
    expect(project(input)).toEqual({ kind: "review_required", reason: "creation_provenance_mismatch" });
    expect(input.payments[0].baseAmountMinor).toBe(baseAmountMinor);
  });

  it("rejects a target-divergent refund supplied by the required reversal closure", () => {
    const input = fixture();
    input.payments[1].invoiceId = 12;
    expect(project(input)).toEqual({ kind: "review_required", reason: "ownership_mismatch" });
  });

  it("rejects a referenced origin outside the selected invoice rather than ignoring it", () => {
    const input = fixture();
    addPayment(input, { id: 99, invoiceId: 12, amountMinor: 1_000 });
    input.payments[1].reversalOfId = 99;
    expect(project(input)).toEqual({ kind: "review_required", reason: "ownership_mismatch" });
  });

  it("requires a complete snapshot; read errors or pagination cannot grant recovery", () => {
    const input = fixture(); input.complete = false;
    expect(project(input)).toEqual({ kind: "review_required", reason: "incomplete_snapshot" });
  });

  it("requires unique structural creation provenance; a note or copied plan ID is insufficient", () => {
    const missing = fixture(); missing.creationAudits = [];
    expect(project(missing)).toEqual({ kind: "review_required", reason: "missing_creation_provenance" });
    const duplicate = fixture(); duplicate.creationAudits = [...duplicate.creationAudits, { ...duplicate.creationAudits[0], id: 502 }];
    expect(project(duplicate)).toEqual({ kind: "review_required", reason: "ambiguous_creation_provenance" });
    const mismatch = fixture(); replaceDetails(mismatch, { الخطة: 99 });
    expect(project(mismatch)).toEqual({ kind: "review_required", reason: "creation_provenance_mismatch" });
    // Adapter conversion from PostgreSQL int8 text must never turn unsupported
    // identifiers into accepted provenance, including rounded values above MAX_SAFE.
    for (const wireId of ["0", "-1", "9007199254740992", "9007199254740993", "9223372036854775807"]) {
      const unsafe = fixture(); unsafe.creationAudits = [{ ...unsafe.creationAudits[0], id: Number(wireId) }];
      expect(project(unsafe)).toEqual({ kind: "review_required", reason: "creation_provenance_mismatch" });
    }
  });

  it("verifies original installment principal against its creation receipt", () => {
    const input = fixture(); input.invoice.totalMinor = 8_000;
    expect(project(input)).toEqual({ kind: "review_required", reason: "origin_principal_mismatch" });
  });

  it("does not qualify only because a later unrelated receipt was refunded", () => {
    const input = fixture(); input.payments = [input.payments[0]];
    addPayment(input, { id: 103, amountMinor: 1_000 });
    addPayment(input, { id: 104, kind: "refund", reversalOfId: 103, amountMinor: 1_000 });
    expect(project(input)).toEqual({ kind: "excluded", reason: "no_reversal" });
  });

  it.each(["plan-owner", "account-owner", "payment-owner", "payment-invoice", "payment-plan"] as const)("fails closed for %s mismatch", (which) => {
    const input = fixture();
    if (which === "plan-owner") input.plan!.patientId = 2;
    if (which === "account-owner") input.account.patientId = 2;
    if (which === "payment-owner") input.payments[0].patientId = 2;
    if (which === "payment-invoice") input.payments[0].invoiceId = 12;
    if (which === "payment-plan") input.payments[0].planId = 22;
    expect(project(input)).toEqual({ kind: "review_required", reason: "ownership_mismatch" });
  });

  it("fails closed for the wrong plan/account currency", () => {
    const input = fixture(); input.plan!.baseCurrency = "USD";
    expect(project(input)).toEqual({ kind: "review_required", reason: "currency_mismatch" });
  });

  it("rejects missing origins, target-divergent refunds, duplicate rows and over-refunds", () => {
    const missing = fixture(); missing.payments[1].reversalOfId = 999;
    expect(project(missing)).toEqual({ kind: "review_required", reason: "invalid_refund_lineage" });
    const gap = fixture(); gap.payments[1].planId = null;
    expect(project(gap)).toEqual({ kind: "review_required", reason: "invalid_refund_lineage" });
    const duplicate = fixture(); duplicate.payments = [...duplicate.payments, duplicate.payments[0]];
    expect(project(duplicate)).toEqual({ kind: "review_required", reason: "invalid_payment" });
    const excess = fixture(); addPayment(excess, { id: 103, kind: "refund", reversalOfId: 101, amountMinor: 1 });
    expect(project(excess)).toEqual({ kind: "review_required", reason: "refund_exceeds_origin" });
  });

  it.each([NaN, Infinity, -1, 1.25, Number.MAX_SAFE_INTEGER + 1])("rejects invalid recorded amount %s", (amountMinor) => {
    const input = fixture(); input.payments[0].amountMinor = amountMinor;
    expect(project(input)).toEqual({ kind: "review_required", reason: "invalid_payment" });
  });
});

const body = (extra: Record<string, unknown> = {}) => ({
  purpose: PURPOSE, patientId: "1", invoiceId: "11", amount: "70", currency: "SAR", kind: "payment", method: "cash", ...extra,
});
function intent(extra: Partial<RecoveryIntent> = {}): RecoveryIntent {
  return { purpose: PURPOSE, patientId: 1, invoiceId: 11, amountMinor: 7_000, currency: "SAR", method: "cash", note: null, ...extra };
}

describe("opt-in recovery request and replay identity contract", () => {
  it("leaves requests without purpose on the ordinary path, including manual receipt targets", () => {
    expect(parseRecoveryIntent({ invoiceId: 11, planId: null, amount: "70", currency: "SAR" }, null)).toEqual({ kind: "ordinary" });
  });
  it("requires explicit purpose, one invoice target, and a valid idempotency key", () => {
    expect(parseRecoveryIntent(body(), "recovery-key-001")).toEqual({ kind: "recovery", idempotencyKey: "recovery-key-001", intent: intent() });
    expect(parseRecoveryIntent(body({ purpose: "anything-else" }), "recovery-key-001")).toEqual({ kind: "invalid", reason: "invalid_purpose" });
    expect(parseRecoveryIntent(body(), null)).toEqual({ kind: "invalid", reason: "invalid_key" });
    expect(parseRecoveryIntent(body(), "short")).toEqual({ kind: "invalid", reason: "invalid_key" });
    expect(parseRecoveryIntent(body({ invoiceId: null }), "recovery-key-001")).toEqual({ kind: "invalid", reason: "invalid_target" });
    expect(parseRecoveryIntent(body({ kind: "refund" }), "recovery-key-001")).toEqual({ kind: "invalid", reason: "invalid_target" });
  });
  it.each(["planId", "openingCurrency", "reversalOfId", "originPaymentId", "creationAuditId", "exchangeRate", "baseCurrency", "baseAmountMinor"])("rejects caller-owned %s instead of allowing fabricated association or FX", (field) => {
    expect(parseRecoveryIntent(body({ [field]: 21 }), "recovery-key-001")).toEqual({ kind: "invalid", reason: "server_owned_field" });
  });
  it.each(["", "-1", "0", "Infinity", "not-money"])("rejects invalid amount %s", (amount) => {
    expect(parseRecoveryIntent(body({ amount }), "recovery-key-001")).toEqual({ kind: "invalid", reason: "invalid_amount" });
  });
  it.each([{ value: true }, { value: false }, { value: [1] }, { value: {} }, { value: "1.5" }, { value: "-1" }])(
    "rejects non-ID/coerced target $value", ({ value }) => {
      expect(parseRecoveryIntent(body({ patientId: value }), "recovery-key-001")).toEqual({ kind: "invalid", reason: "invalid_target" });
    },
  );
  it("does not silently reinterpret an unsupported collection method", () => {
    expect(parseRecoveryIntent(body({ method: "unknown" }), "recovery-key-001")).toEqual({ kind: "invalid", reason: "invalid_method" });
  });
  it("normalizes caller intent independently of current FX and mutable balance", () => {
    const parsed = parseRecoveryIntent(body({ amount: "٧٠.٠٠", note: "  reviewed recovery  " }), " recovery-key-001 ");
    expect(parsed).toEqual({ kind: "recovery", idempotencyKey: "recovery-key-001", intent: intent({ note: "reviewed recovery" }) });
    const serialized = recoveryIntentFingerprintSource(intent(), "cashier");
    expect(JSON.parse(serialized)).toEqual({ v: "reversed-installment-recovery-1", actor: "cashier", ...intent() });
    expect(serialized).not.toContain("exchangeRate");
    expect(serialized).not.toContain("remainingMinor");
    expect(serialized).not.toContain("planId");
  });
  it("binds every caller-controlled consequential field and actor; excludes legacy ordinary v1 identity", () => {
    const original = recoveryIntentFingerprintSource(intent(), "cashier");
    const changes: Partial<RecoveryIntent>[] = [
      { patientId: 2 }, { invoiceId: 12 }, { amountMinor: 6_000 }, { currency: "USD" as Currency },
      { method: "transfer" }, { note: "changed reason" },
    ];
    for (const change of changes) expect(recoveryIntentFingerprintSource(intent(change), "cashier")).not.toBe(original);
    expect(recoveryIntentFingerprintSource(intent(), "another-cashier")).not.toBe(original);
    expect(JSON.parse(original).v).not.toBe(1);
    expect(JSON.parse(original).v).not.toBe("plan-installment-1");
  });
});
