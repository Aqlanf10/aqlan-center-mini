import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { validatePostgresTestTarget } from "./_safe-target";

// SOURCE-ONLY CANDIDATE: intended for the existing isolated PostgreSQL 18 job.
// The display reader must never rewrite financial or audit history.
validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();

const { ensureSchema, getPool, resetPoolForTesting, openShift, recordPayment, correctPayment, getPayment } =
  await import("../../lib/db");
const { readReceiptProvenance, RECEIPT_PROVENANCE_REQUEST_LIMIT, RECEIPT_PROVENANCE_CONTEXT_LIMIT } =
  await import("../../lib/receipt-provenance-db");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}
let sequence = 0;
async function patient() {
  return (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name)
    VALUES ($1, 'SYNTHETIC-PROVENANCE') RETURNING id`, [`PROV-P-${++sequence}`]))[0].id;
}
async function pay(patientId: number, amountMinor: number, note: string | null = null, reversalOfId: number | null = null) {
  const result = await recordPayment({ patientId, invoiceId: null,
    kind: reversalOfId === null ? "payment" : "refund", amountMinor, currency: "YER", baseCurrency: "YER",
    exchangeRate: 1, method: "cash", note, createdBy: "SYNTHETIC-RECEIVER", reversalOfId });
  if (result.reason !== null || !result.payment) throw new Error(`Synthetic payment failed: ${result.reason}`);
  return result.payment;
}
async function correct(paymentId: number, amountMinor: number | null) {
  const result = await correctPayment({ paymentId, reason: "SYNTHETIC-PRIVATE-AUDIT-REASON",
    actor: "SYNTHETIC-PRIVATE-AUDIT-ACTOR", actorRole: "admin",
    replacement: amountMinor === null ? null : { amountMinor, currency: "YER", exchangeRate: 1, method: "cash",
      target: { kind: "original" } } });
  if (result.reason !== null || !result.reversal || (amountMinor !== null && !result.replacement)) {
    throw new Error(`Synthetic correction failed: ${result.reason}`);
  }
  return result;
}
const ref = (payment: { id: number; receiptNumber: string }) => ({ id: payment.id, receiptNumber: payment.receiptNumber });

async function snapshot() {
  return (await q(`SELECT
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p) AS payments,
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) AS invoices,
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM cashier_shifts s) AS shifts,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_log a) AS audit,
    (SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM journal_manual j) AS journal,
    (SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM journal_manual_lines j) AS journal_lines,
    (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM document_prints d) AS prints`))[0];
}
async function readUnchanged(ids: number[]) {
  const before = await snapshot();
  const result = await readReceiptProvenance(ids);
  expect(await snapshot()).toEqual(before);
  expect(Object.keys(result).sort()).toEqual([...new Set(ids)].map(String).sort());
  const publicText = JSON.stringify(result);
  for (const privateText of ["SYNTHETIC-PRIVATE-AUDIT-REASON", "SYNTHETIC-PRIVATE-AUDIT-ACTOR", "actorRole", "details", "summary"]) {
    expect(publicText).not.toContain(privateText);
  }
  return result;
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "synthetic-provenance", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("receipt provenance is an append-only read projection", () => {
  it("separates original face value, full reversal and replacement without expanding Payment", async () => {
    const original = await pay(await patient(), 50_000);
    const corrected = await correct(original.id, 5_000);
    const reversal = corrected.reversal!, replacement = corrected.replacement!;
    const result = await readUnchanged([original.id, reversal.id, replacement.id]);
    expect(result[original.id]).toMatchObject({ status: "available",
      reversal: { state: "full", reversedMinor: 50_000, remainingMinor: 0 },
      correction: { mode: "correct", reversal: ref(reversal), replacement: ref(replacement) },
      replacementOf: null, correctionUnverified: false });
    expect(result[reversal.id]).toMatchObject({ reversal: null, reversalOf: ref(original),
      correctionReversal: { mode: "correct", original: ref(original) }, correction: null });
    expect(result[replacement.id]).toMatchObject({ replacementOf: ref(original),
      reversal: { state: "none", reversedMinor: 0, remainingMinor: 5_000 } });
    const face = await getPayment(original.id);
    expect(face).toEqual(original);
    expect(face).not.toHaveProperty("receiptProvenance");
    expect(face).not.toHaveProperty("reversalOfId");
  });

  it("voids have no invented replacement and retain their exact audit-linked reversal", async () => {
    const original = await pay(await patient(), 7_000);
    const voided = await correct(original.id, null);
    const result = await readUnchanged([original.id, voided.reversal!.id]);
    expect(result[original.id].correction).toEqual({ mode: "void", reversal: ref(voided.reversal!), replacement: null });
    expect(result[voided.reversal!.id].correctionReversal).toEqual({ mode: "void", original: ref(original) });
  });

  it("does not call an earlier ordinary partial refund a correction reversal", async () => {
    const original = await pay(await patient(), 30_000);
    const ordinaryRefund = await pay(original.patientId, 10_000, `تصحيح السند ${original.receiptNumber}: lookalike`, original.id);
    const partial = await readUnchanged([original.id, ordinaryRefund.id]);
    expect(partial[original.id]).toMatchObject({ reversal: { state: "partial", reversedMinor: 10_000, remainingMinor: 20_000 },
      correction: null, correctionUnverified: false });
    expect(partial[ordinaryRefund.id]).toMatchObject({ reversalOf: ref(original), correctionReversal: null });
    const corrected = await correct(original.id, 4_000);
    expect(corrected.reversal!.amountMinor).toBe(20_000);
    const result = await readUnchanged([original.id, ordinaryRefund.id, corrected.reversal!.id, corrected.replacement!.id]);
    expect(result[original.id].reversal).toEqual({ state: "full", reversedMinor: 30_000, remainingMinor: 0 });
    expect(result[original.id].correction?.reversal).toEqual(ref(corrected.reversal!));
    expect(result[ordinaryRefund.id].correctionReversal).toBeNull();
  });

  it("keeps incoming and outgoing lineage when a replacement is itself corrected", async () => {
    const original = await pay(await patient(), 9_000);
    const first = await correct(original.id, 6_000);
    const second = await correct(first.replacement!.id, 3_000);
    const ids = [original.id, first.reversal!.id, first.replacement!.id, second.reversal!.id, second.replacement!.id];
    const result = await readUnchanged(ids);
    expect(result[first.replacement!.id]).toMatchObject({ replacementOf: ref(original),
      correction: { mode: "correct", reversal: ref(second.reversal!), replacement: ref(second.replacement!) },
      reversal: { state: "full", reversedMinor: 6_000, remainingMinor: 0 } });
    expect(result[second.replacement!.id].replacementOf).toEqual(ref(first.replacement!));
    // A one-ID read still resolves both incident edges, without returning other IDs as keys.
    const one = await readUnchanged([first.replacement!.id]);
    expect(one[first.replacement!.id]).toEqual(result[first.replacement!.id]);
  });

  it("does not infer correction from same-looking notes or a full ordinary refund", async () => {
    const original = await pay(await patient(), 8_000);
    const refund = await pay(original.patientId, 8_000, `تصحيح السند ${original.receiptNumber}: إبطال`, original.id);
    const lookalike = await pay(original.patientId, 2_000, `بدل السند ${original.receiptNumber}`);
    const result = await readUnchanged([original.id, refund.id, lookalike.id]);
    expect(result[original.id]).toMatchObject({ reversal: { state: "full", reversedMinor: 8_000, remainingMinor: 0 },
      correction: null, correctionUnverified: false });
    expect(result[refund.id]).toMatchObject({ reversalOf: ref(original), correctionReversal: null });
    expect(result[lookalike.id].replacementOf).toBeNull();
  });

  it("rejects a cross-patient replacement claimed by malformed audit data", async () => {
    const original = await pay(await patient(), 4_000);
    const refund = await pay(original.patientId, 4_000, null, original.id);
    const otherPatient = await patient();
    // Every other audit witness matches: only replacement ownership is false.
    // Seed new synthetic rows; do not update existing financial/audit records.
    const [unrelated] = await q<{ id: number; receiptNumber: string }>(`INSERT INTO payments
      (receipt_number, patient_id, shift_id, kind, amount_minor, currency, exchange_rate,
       base_amount_minor, base_currency, method, created_by, created_at)
      SELECT $1,$2,shift_id,'payment',1000,'YER',1,1000,'YER','cash',created_by,created_at
      FROM payments WHERE id=$3 RETURNING id, receipt_number AS "receiptNumber"`,
    [`PROV-FORGED-${++sequence}`, otherPatient, refund.id]);
    await q(`INSERT INTO audit_log (action, entity, entity_id, summary, details, actor, actor_role, created_at)
      SELECT 'payment.correct','payment',$1,'SYNTHETIC-MALFORMED',$2::jsonb,created_by,'admin',created_at
      FROM payments WHERE id=$3`,
    [String(original.id), JSON.stringify({ الطريقة: "تصحيح", السبب: "SYNTHETIC-PRIVATE-AUDIT-REASON", المريض: original.patientId,
      سند_العكس: refund.receiptNumber, المبلغ_المعكوس: 4_000, العملة_المعكوسة: "YER",
      السند_الصحيح: unrelated.receiptNumber, المبلغ_الصحيح: 1_000, العملة_الصحيحة: "YER" }), refund.id]);
    const result = await readUnchanged([original.id, refund.id, unrelated.id]);
    expect(result[original.id]).toMatchObject({ correction: null, correctionUnverified: true,
      reversal: { state: "full", reversedMinor: 4_000, remainingMinor: 0 } });
    expect(result[refund.id].correctionReversal).toBeNull();
    expect(result[unrelated.id].replacementOf).toBeNull();
    const only = await readUnchanged([original.id]);
    expect(JSON.stringify(only)).not.toContain(unrelated.receiptNumber);
  });

  it("treats two correction audit candidates as ambiguous, preserving structural reversal", async () => {
    const original = await pay(await patient(), 5_000);
    const corrected = await correct(original.id, 2_000);
    // Append a synthetic ambiguity; never update or delete the audit log.
    await q(`INSERT INTO audit_log (action, entity, entity_id, summary, details, actor, actor_role)
      SELECT action, entity, entity_id, summary, details, actor, actor_role FROM audit_log
      WHERE action='payment.correct' AND entity='payment' AND entity_id=$1`, [String(original.id)]);
    const result = await readUnchanged([original.id, corrected.reversal!.id, corrected.replacement!.id]);
    expect(result[original.id]).toMatchObject({ correction: null, correctionUnverified: true,
      reversal: { state: "full", reversedMinor: 5_000, remainingMinor: 0 } });
    expect(result[corrected.reversal!.id].correctionReversal).toBeNull();
    expect(result[corrected.replacement!.id].replacementOf).toBeNull();
  });

  it("does not manufacture an ordinary receipt when the requested row is missing", async () => {
    const result = await readUnchanged([2_000_000_000]);
    expect(result[2_000_000_000]).toMatchObject({ status: "unavailable", correction: null,
      correctionReversal: null, replacementOf: null });
    expect(await readReceiptProvenance([])).toEqual({});
  });

  it("fails closed when request or patient-context bounds would hide relevant history", async () => {
    const requested = Array.from({ length: RECEIPT_PROVENANCE_REQUEST_LIMIT + 1 }, (_, index) => 1_000_000 + index);
    const bounded = await readUnchanged(requested);
    expect(Object.values(bounded).every(value => value.status === "unavailable")).toBe(true);
    const p = await patient();
    const owner = await pay(p, 1_000);
    await q(`INSERT INTO payments (receipt_number, patient_id, shift_id, kind, amount_minor, currency,
      exchange_rate, base_amount_minor, base_currency, method, created_by)
      SELECT 'PROV-BOUND-' || $1::text || '-' || n::text, $1, $2, 'payment', 1, 'YER', 1, 1, 'YER', 'cash', 'synthetic'
      FROM generate_series(1, $3::int) n`, [p, owner.shiftId, RECEIPT_PROVENANCE_CONTEXT_LIMIT]);
    const result = await readUnchanged([owner.id]);
    expect(result[owner.id]).toMatchObject({ status: "unavailable", reversal: null,
      correction: null, correctionReversal: null, replacementOf: null });
  });
});
