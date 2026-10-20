import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { readCurrencyReclassificationEvidence } from "../../lib/invoice-currency-evidence";
import * as currencyEvidence from "../../lib/invoice-currency-evidence";
import { ReclassificationProofError } from "../../lib/invoice-currency-reclassification";
import type { DbClient } from "../../lib/db";

assertRealPostgresUrl();
stubPostgresEnv();

// Exercise real HTTP handlers and PostgreSQL. Only session identity is mocked,
// apart from the explicitly isolated proof-error boundary test below.
const auth = vi.hoisted(() => ({
  session: { username: "ci-reclassified-refund", role: "admin", userId: 1 },
}));
vi.mock("@/lib/session", () => ({ requireSession: async () => auth.session }));
const db = await import("../../lib/db");
const { POST: refundPOST } = await import("../../app/api/payments/route");
const { POST: correctPOST } = await import("../../app/api/payments/[id]/correct/route");
const actor = "ci-reclassified-refund";
const rate = 140;
let serial = 0;
let otherPatientId: number;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  await db.saveSettings({ "finance.rate.SAR": String(rate) });
  await openShift();
  const { rows: [other] } = await db.getPool().query<{ id: number }>(
    "INSERT INTO patients(patient_number,full_name) VALUES('RCB-OTHER','Synthetic other owner') RETURNING id",
  );
  otherPatientId = other.id;
  // Nonempty stock evidence makes no-stock-mutation checks meaningful.
  const { rows: [item] } = await db.getPool().query<{ id: number }>(
    "INSERT INTO inventory_items(name,created_by) VALUES('Synthetic refund stock sentinel',$1) RETURNING id", [actor],
  );
  await db.getPool().query(
    "INSERT INTO inventory_movements(item_id,kind,qty,created_by) VALUES($1,'in',7,$2)", [item.id, actor],
  );
});
afterAll(async () => { await db.resetPoolForTesting(); });

async function openShift() {
  await db.getPool().query("INSERT INTO cashier_shifts(opened_by) VALUES($1)", [actor]);
}

async function correctionDocument(
  client: DbClient, patientId: number, originalId: number, correctedId: number,
  originalCurrency: "YER" | "SAR", currency: "YER" | "SAR", key: string,
) {
  const { rows: [correction] } = await client.query<{ id: number }>(
    `INSERT INTO invoice_corrections(patient_id,currency,original_currency,original_invoice_id,
       corrected_invoice_id,idempotency_key,request_hash,reason,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,'Synthetic currency correction',$8) RETURNING id`,
    [patientId, currency, originalCurrency, originalId, correctedId, key, "a".repeat(64), actor],
  );
  await client.query("INSERT INTO invoice_correction_receipts(correction_id,receipt) VALUES($1,$2::jsonb)", [
    correction.id,
    JSON.stringify({
      patientId, currency, idempotencyKey: key, createdBy: actor,
      original: { id: originalId, patientId, baseCurrency: originalCurrency },
      corrected: { id: correctedId, patientId, baseCurrency: currency },
    }),
  ]);
  return correction.id;
}

/** The same complete, trigger-validated proof as invoice-currency-schema.test.ts,
 * with deliberately tiny cash amounts. No migration changes or disabled guards. */
async function fixture(amountMinor = 3, withLineage = false) {
  const key = `reclassified-budget-${++serial}`;
  const baseAmountMinor = Math.round(amountMinor / 100 * rate);
  const client = await db.getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: [patient] } = await client.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic reclassified refund') RETURNING id", [key],
    );
    const { rows: [original] } = await client.query<{ id: number }>(
      "INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,status,created_by) VALUES($1,$2,$3,0,'YER','cancelled',$4) RETURNING id",
      [`${key}-old`, patient.id, baseAmountMinor, actor],
    );
    let correctionOriginalId = original.id;
    const sourceInvoiceIds = [original.id];
    if (withLineage) {
      const { rows: [descendant] } = await client.query<{ id: number }>(
        "INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,status,created_by) VALUES($1,$2,$3,0,'YER','cancelled',$4) RETURNING id",
        [`${key}-yer-descendant`, patient.id, baseAmountMinor, actor],
      );
      await correctionDocument(client, patient.id, original.id, descendant.id, "YER", "YER", `${key}-yer-correction`);
      correctionOriginalId = descendant.id;
      sourceInvoiceIds.push(descendant.id);
    }
    const { rows: [corrected] } = await client.query<{ id: number }>(
      "INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,status,created_by) VALUES($1,$2,$3,0,'SAR',$4,$5) RETURNING id",
      [`${key}-new`, patient.id, amountMinor, withLineage ? "cancelled" : "open", actor],
    );
    const { rows: [shift] } = await client.query<{ id: number }>("SELECT id FROM cashier_shifts WHERE status='open'");
    const { rows: [payment] } = await client.query<{ id: number }>(
      `INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,
         exchange_rate,base_amount_minor,base_currency,method,created_by)
       VALUES($1,$2,$3,$4,'payment',$5,'SAR',$6,$7,'YER','cash',$8) RETURNING id`,
      [`${key}-source`, patient.id, original.id, shift.id, amountMinor, rate, baseAmountMinor, actor],
    );
    const correctionId = await correctionDocument(
      client, patient.id, correctionOriginalId, corrected.id, "YER", "SAR", `${key}-invoice-correction`,
    );
    const { rows: [document] } = await client.query<{ id: number }>(
      `INSERT INTO invoice_settlement_reclassifications(correction_id,patient_id,source_currency,target_currency,source_invoice_ids)
       VALUES($1,$2,'YER','SAR',$3) RETURNING id`, [correctionId, patient.id, sourceInvoiceIds],
    );
    await client.query(
      `INSERT INTO invoice_settlement_reclassification_events(reclassification_id,payment_id,direction,source_minor,target_minor,payment_snapshot)
       SELECT $1,id,1,base_amount_minor,amount_minor,to_jsonb(p) FROM payments p WHERE id=$2`, [document.id, payment.id],
    );
    let correctedInvoiceId = corrected.id;
    if (withLineage) {
      const { rows: [successor] } = await client.query<{ id: number }>(
        "INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,status,created_by) VALUES($1,$2,$3,0,'SAR','open',$4) RETURNING id",
        [`${key}-sar-successor`, patient.id, amountMinor, actor],
      );
      await correctionDocument(client, patient.id, corrected.id, successor.id, "SAR", "SAR", `${key}-sar-correction`);
      correctedInvoiceId = successor.id;
    }
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const evidence = await readCurrencyReclassificationEvidence(client, patient.id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      documentId: document.id, paymentId: payment.id, sourceInvoiceId: original.id,
      targetInvoiceId: correctedInvoiceId, sourceMinor: baseAmountMinor, targetMinor: amountMinor, direction: 1,
    });
    await client.query("COMMIT");
    return {
      key, patientId: patient.id, originalInvoiceId: original.id, correctedInvoiceId,
      correctionOriginalId, sourceInvoiceIds,
      paymentId: payment.id, documentId: document.id, shiftId: shift.id, amountMinor, baseAmountMinor,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function refundInput(f: Fixture, amountMinor: number, suffix: string, patientId = f.patientId) {
  return {
    patientId, invoiceId: null, kind: "refund" as const, amountMinor,
    currency: "SAR" as const, baseCurrency: "YER" as const, exchangeRate: 999,
    method: "cash", note: null, createdBy: actor, reversalOfId: f.paymentId, idempotencyKey: `${f.key}-${suffix}`,
  };
}
function refundRequest(f: Fixture, amountMinor: number, suffix: string, patientId = f.patientId) {
  return new Request("http://localhost/api/payments", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": `${f.key}-${suffix}` },
    body: JSON.stringify({
      patientId, kind: "refund", amount: (amountMinor / 100).toFixed(2),
      currency: "SAR", method: "cash", reversalOfId: f.paymentId,
    }),
  });
}
function correctionInput(f: Fixture, suffix: string) {
  return {
    paymentId: f.paymentId, actor, actorRole: "admin", reason: "Synthetic reclassified receipt correction",
    idempotencyKey: `${f.key}-${suffix}`, replacement: null,
  };
}
function correctionRequest(f: Fixture, suffix: string, mode: "void" | "correct") {
  return new Request(`http://localhost/api/payments/${f.paymentId}/correct`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": `${f.key}-${suffix}` },
    body: JSON.stringify({
      mode, reason: "Synthetic reclassified receipt correction", amount: "0.02",
      currency: "SAR", method: "cash", target: "original",
    }),
  });
}

async function snapshot() {
  const { rows: [row] } = await db.getPool().query(`
    SELECT
      (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb) FROM payments p) AS payments,
      (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb) FROM audit_log a) AS audits,
      (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY id),'[]'::jsonb) FROM invoice_settlement_reclassification_events e) AS events,
      (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY id),'[]'::jsonb) FROM invoice_settlement_reclassifications d) AS documents,
      (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY id),'[]'::jsonb) FROM invoice_corrections c) AS corrections,
      (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY id),'[]'::jsonb) FROM invoices i) AS invoices,
      (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY id),'[]'::jsonb) FROM inventory_items i) AS stock_items,
      (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY id),'[]'::jsonb) FROM inventory_movements m) AS stock_movements,
      (SELECT last_value::text FROM payments_id_seq) AS payment_sequence`);
  // The nontransactional sequence also detects an INSERT attempted then rolled
  // back by 0063: containment must return review BEFORE attempting that write.
  return row;
}
async function expectOnlyHttpReplayAudit(
  before: Awaited<ReturnType<typeof snapshot>>, f: Fixture, paymentId: number, suffix: string,
) {
  const after = await snapshot();
  const { audits: beforeAudits, ...beforeFinancial } = before;
  const { audits: afterAudits, ...afterFinancial } = after;
  expect(afterFinancial).toEqual(beforeFinancial);
  expect(afterAudits).toHaveLength(beforeAudits.length + 1);
  expect(afterAudits.slice(0, beforeAudits.length)).toEqual(beforeAudits);
  expect(afterAudits.at(-1)).toMatchObject({
    action: "payment.idempotent_replay", entity: "payment", entity_id: String(paymentId),
    actor, actor_role: "admin", details: { المريض: f.patientId, مفتاح_الإعادة: `${f.key}-${suffix}` },
  });
  return after;
}
async function originalEvidence(f: Fixture) {
  return (await db.getPool().query(
    `SELECT to_jsonb(p) AS payment,to_jsonb(e) AS event,to_jsonb(d) AS document
       FROM payments p JOIN invoice_settlement_reclassification_events e ON e.payment_id=p.id
       JOIN invoice_settlement_reclassifications d ON d.id=e.reclassification_id WHERE p.id=$1`, [f.paymentId],
  )).rows[0];
}
async function expectConserved(f: Fixture, refundCount: number) {
  const { rows: [totals] } = await db.getPool().query(
    `SELECT sum(amount_minor)::text AS native,sum(base_amount_minor)::text AS base,count(*)::int AS count
       FROM payments WHERE reversal_of_id=$1 AND kind='refund'`, [f.paymentId],
  );
  expect(totals).toEqual({ native: String(f.amountMinor), base: String(f.baseAmountMinor), count: refundCount });
  const evidence = await readCurrencyReclassificationEvidence(db.getPool(), f.patientId);
  expect(evidence).toHaveLength(refundCount + 1);
  expect(evidence.reduce((sum, row) => sum + row.direction * row.sourceMinor, 0)).toBe(0);
  expect(evidence.reduce((sum, row) => sum + row.direction * row.targetMinor, 0)).toBe(0);
}
async function historicalOneMinorRefund(f: Fixture, suffix: string) {
  const key = `${f.key}-${suffix}`;
  const requestHash = createHash("sha256").update(JSON.stringify({
    v: 1, actor, patientId: f.patientId, invoiceId: f.originalInvoiceId, kind: "refund", amountMinor: 1,
    currency: "SAR", baseCurrency: "YER", exchangeRate: rate, method: "cash", reversalOfId: f.paymentId,
  })).digest("hex");
  // A valid old standalone-FX refund. The normal 0063 trigger creates its proof;
  // this deliberately does not use the new cumulative allocation writer.
  const { rows: [refund] } = await db.getPool().query<{ id: number }>(
    `INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,
       exchange_rate,base_amount_minor,base_currency,method,created_by,reversal_of_id,idempotency_key,idempotency_request_hash)
     VALUES($1,$2,$3,$4,'refund',1,'SAR',$5,1,'YER','cash',$6,$7,$8,$9) RETURNING id`,
    [`${key}-receipt`, f.patientId, f.originalInvoiceId, f.shiftId, rate, actor, f.paymentId, key, requestHash],
  );
  return refund.id;
}

describe("reclassified receipts preserve both the original base budget and migration 0063 proof", () => {
  it("returns explicit HTTP 409 before INSERT for incompatible second 1/2, replays first 1/1, and completes remaining 2/3", async () => {
    // Cash sits on the YER ancestor, not correction.original_invoice_id. Both
    // historical YER invoices are members of 0063's source_invoice_ids.
    const f = await fixture(3, true);
    expect(f.correctionOriginalId).not.toBe(f.originalInvoiceId);
    expect(f.sourceInvoiceIds).toEqual([f.originalInvoiceId, f.correctionOriginalId]);
    const original = await originalEvidence(f);
    const stockBefore = await snapshot();
    const first = await refundPOST(refundRequest(f, 1, "first"));
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({ amountMinor: 1, baseAmountMinor: 1, exchangeRate: rate, invoiceId: f.originalInvoiceId });
    const beforeRefusal = await snapshot();
    expect((await db.recordPayment(refundInput(f, 1, "service-blocked"))).reason).toBe("refund_snapshot_review_required");
    expect(await snapshot()).toEqual(beforeRefusal);
    const second = await refundPOST(refundRequest(f, 1, "second"));
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ reason: "refund_snapshot_review_required" });
    expect(await snapshot()).toEqual(beforeRefusal);
    const replay = await refundPOST(refundRequest(f, 1, "first"));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    await expectOnlyHttpReplayAudit(beforeRefusal, f, firstBody.id, "first");
    const remaining = await refundPOST(refundRequest(f, 2, "remaining"));
    expect(remaining.status).toBe(201);
    expect(await remaining.json()).toMatchObject({ amountMinor: 2, baseAmountMinor: 3 });
    await expectConserved(f, 2);
    expect(await originalEvidence(f)).toEqual(original);
    const after = await snapshot();
    expect(after.stock_items).toEqual(stockBefore.stock_items);
    expect(after.stock_movements).toEqual(stockBefore.stock_movements);
  });

  it.each([
    { amount: 3, chunks: [3], bases: [4] },
    { amount: 3, chunks: [2, 1], bases: [3, 1] },
    { amount: 300, chunks: [100, 200], bases: [140, 280] },
  ])("retains compatible refund results for $amount minor split $chunks", async ({ amount, chunks, bases }) => {
    const f = await fixture(amount);
    const original = await originalEvidence(f);
    for (const [index, chunk] of chunks.entries()) {
      const result = await db.recordPayment(refundInput(f, chunk, `compatible-${index}`));
      expect(result.reason).toBeNull();
      expect(result.payment).toMatchObject({ amountMinor: chunk, baseAmountMinor: bases[index], exchangeRate: rate });
    }
    await expectConserved(f, chunks.length);
    expect(await originalEvidence(f)).toEqual(original);
  });

  it("voids a compatible remaining 2/3 and replays before fully-refunded and closed-shift checks", async () => {
    const f = await fixture();
    const first = await db.recordPayment(refundInput(f, 1, "first"));
    expect(first.reason).toBeNull();
    const request = correctionInput(f, "void");
    const result = await db.correctPayment(request);
    expect(result.reason).toBeNull();
    if (result.reason !== null) return;
    expect(result.reversal).toMatchObject({ amountMinor: 2, baseAmountMinor: 3, invoiceId: f.originalInvoiceId });
    expect(result.replacement).toBeNull();
    await expectConserved(f, 2);
    await db.getPool().query("UPDATE cashier_shifts SET status='closed',closed_at=NOW(),closed_by=$1 WHERE status='open'", [actor]);
    try {
      const before = await snapshot();
      const replay = await db.correctPayment(request);
      expect(replay).toMatchObject({ reason: null, replayed: true, reversal: { id: result.reversal!.id } });
      expect(await snapshot()).toEqual(before);
      const refundReplay = await refundPOST(refundRequest(f, 1, "first"));
      expect(refundReplay.status).toBe(200);
      expect(await refundReplay.json()).toMatchObject({ id: first.payment!.id, amountMinor: 1, baseAmountMinor: 1 });
      await expectOnlyHttpReplayAudit(before, f, first.payment!.id, "first");
    } finally { await openShift(); }
  });

  it("corrects compatibly onto the current SAR invoice without rewriting the retired receipt or proof", async () => {
    const f = await fixture(3, true);
    const original = await originalEvidence(f);
    expect((await db.recordPayment(refundInput(f, 1, "first"))).reason).toBeNull();
    const response = await correctPOST(correctionRequest(f, "replace", "correct"), { params: Promise.resolve({ id: String(f.paymentId) }) });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      replayed: false,
      reversal: { amountMinor: 2, baseAmountMinor: 3, invoiceId: f.originalInvoiceId },
      replacement: { amountMinor: 2, baseAmountMinor: 3, invoiceId: f.correctedInvoiceId, currency: "SAR" },
    });
    await expectConserved(f, 2);
    expect(await originalEvidence(f)).toEqual(original);
    const beforeReplay = await snapshot();
    const replay = await correctPOST(correctionRequest(f, "replace", "correct"), { params: Promise.resolve({ id: String(f.paymentId) }) });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, reversal: { id: body.reversal.id }, replacement: { id: body.replacement.id } });
    expect(await snapshot()).toEqual(beforeReplay);
  });

  it("allows new collection and cumulative refunds on a later SAR successor outside the old source list", async () => {
    const f = await fixture(3, true);
    expect(f.sourceInvoiceIds).not.toContain(f.correctedInvoiceId);
    const proofBefore = await readCurrencyReclassificationEvidence(db.getPool(), f.patientId);
    const collected = await db.recordPayment({
      patientId: f.patientId, invoiceId: f.correctedInvoiceId, kind: "payment", amountMinor: 3,
      currency: "SAR", baseCurrency: "YER", exchangeRate: rate, method: "cash",
      note: null, createdBy: actor, idempotencyKey: `${f.key}-later-collection`,
    });
    expect(collected.reason).toBeNull();
    expect(collected.payment).toMatchObject({ amountMinor: 3, baseAmountMinor: 4, invoiceId: f.correctedInvoiceId });
    const later = { ...f, paymentId: collected.payment!.id, originalInvoiceId: f.correctedInvoiceId };
    for (const [index, base] of [1, 2, 1].entries()) {
      const refunded = await db.recordPayment(refundInput(later, 1, `later-refund-${index}`));
      expect(refunded.reason).toBeNull();
      expect(refunded.payment).toMatchObject({ amountMinor: 1, baseAmountMinor: base, invoiceId: f.correctedInvoiceId });
    }
    expect((await db.getPool().query(
      "SELECT sum(amount_minor)::text AS native,sum(base_amount_minor)::text AS base FROM payments WHERE reversal_of_id=$1",
      [later.paymentId],
    )).rows).toEqual([{ native: "3", base: "4" }]);
    expect(await readCurrencyReclassificationEvidence(db.getPool(), f.patientId)).toEqual(proofBefore);
  });

  it("refuses incompatible correction remainders before either reversal or replacement is inserted", async () => {
    const f = await fixture();
    await historicalOneMinorRefund(f, "old-first");
    await historicalOneMinorRefund(f, "old-second");
    expect(await readCurrencyReclassificationEvidence(db.getPool(), f.patientId)).toHaveLength(3);
    const before = await snapshot();
    expect((await db.correctPayment(correctionInput(f, "service-void"))).reason).toBe("refund_snapshot_review_required");
    expect(await snapshot()).toEqual(before);
    for (const mode of ["void", "correct"] as const) {
      const response = await correctPOST(correctionRequest(f, `blocked-${mode}`, mode), { params: Promise.resolve({ id: String(f.paymentId) }) });
      expect(response.status).toBe(409);
      expect((await response.json()).message).toContain("مراجعة");
      expect(await snapshot()).toEqual(before);
    }
  });

  it("maps a typed inherited-target proof failure to HTTP 409 without mutating valid evidence", async () => {
    const f = await fixture(3, true);
    const before = await snapshot();
    const proof = vi.spyOn(currencyEvidence, "readCurrencyReclassificationEvidence")
      .mockRejectedValueOnce(new ReclassificationProofError());
    try {
      const response = await correctPOST(correctionRequest(f, "proof-error", "correct"), {
        params: Promise.resolve({ id: String(f.paymentId) }),
      });
      expect(response.status).toBe(409);
      expect((await response.json()).message).toContain("مراجعة");
      expect(proof).toHaveBeenCalledTimes(1);
      expect(await snapshot()).toEqual(before);
    } finally { proof.mockRestore(); }
    expect(await readCurrencyReclassificationEvidence(db.getPool(), f.patientId)).toHaveLength(1);
  });

  it("does not let a wrong patient use either a fresh key or an exact successful key", async () => {
    const f = await fixture();
    expect((await db.recordPayment(refundInput(f, 1, "first"))).reason).toBeNull();
    const before = await snapshot();
    for (const suffix of ["new-wrong-owner", "first"]) {
      expect((await db.recordPayment(refundInput(f, 1, suffix, otherPatientId))).reason).toBe("invalid_reversal");
      const response = await refundPOST(refundRequest(f, 1, suffix, otherPatientId));
      expect(response.status).toBe(409);
      expect((await response.json()).message).toContain("المريض");
      expect(await snapshot()).toEqual(before);
    }
  });

  it("replays an old exact key before reviewing later fully-refunded base drift, without repairing history", async () => {
    const f = await fixture();
    const firstId = await historicalOneMinorRefund(f, "old-first");
    await historicalOneMinorRefund(f, "old-second");
    await historicalOneMinorRefund(f, "old-third");
    // All four standalone proofs are valid, but 3 native / 3 base refunds do not
    // conserve this original 3 native / 4 base receipt.
    expect(await readCurrencyReclassificationEvidence(db.getPool(), f.patientId)).toHaveLength(4);
    const before = await snapshot();
    const replay = await refundPOST(refundRequest(f, 1, "old-first"));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: firstId, amountMinor: 1, baseAmountMinor: 1 });
    const beforeRefusal = await expectOnlyHttpReplayAudit(before, f, firstId, "old-first");
    const fresh = await refundPOST(refundRequest(f, 1, "new-review"));
    expect(fresh.status).toBe(409);
    expect(await fresh.json()).toMatchObject({ reason: "refund_snapshot_review_required" });
    expect(await snapshot()).toEqual(beforeRefusal);
  });
});
