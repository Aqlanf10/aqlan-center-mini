import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbClient, Payment } from "../../lib/db";
import { durableMoneyCommand, readDurableMoneyAcknowledgment, restoreMoneyCommand, type DurableMoneyCommand } from "../../lib/durable-money-command";
import { readCurrencyReclassificationEvidence } from "../../lib/invoice-currency-evidence";
import { toBaseAmount } from "../../lib/money";
import { calculationRateMatchesStoredSnapshot } from "../../lib/payment-acknowledgment";
import { provePaymentCalculation } from "../../lib/payment-acknowledgment-db";
import { prepareManualCashFixture } from "./_manual-cash-fixture";
import { validatePostgresTestTarget } from "./_safe-target";
import { stubPostgresEnv } from "./_setup";

/** Actual HTTP handlers, actual PG18 receipts/audits, and the actual durable
 * reader. Only session identity and two explicit settings-read failures are
 * mocked. Synthetic inserts model historical
 * append-only evidence; no receipt/audit rewrite, trigger bypass, or migration. */
const originalEnvironment = { ...process.env };
validatePostgresTestTarget(originalEnvironment);
stubPostgresEnv();
const auth = vi.hoisted(() => ({ session: { username: "synthetic-payment-ack", role: "admin", userId: 1 } }));
vi.mock("@/lib/session", () => ({ requireSession: async () => auth.session }));
const db = await import("../../lib/db");
const { POST: paymentPOST } = await import("../../app/api/payments/route");
const { POST: correctionPOST } = await import("../../app/api/payments/[id]/correct/route");
const ACTOR = "synthetic-payment-ack";
const RAW = 140.1234567;
const RAW_UP = 140.1234568;
const STORED = 140.123457;
const WHY = "Synthetic acknowledgment correction";
let serial = 0;
let shiftId: number;
let otherPatientId: number;

async function q<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await db.getPool().query<T>(sql, values)).rows;
}
async function setRate(rate: number) {
  await q("INSERT INTO settings(key,value) VALUES('finance.rate.SAR',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [String(rate)]);
  db.invalidateSettingsCache();
}
async function fixture() {
  const key = `synthetic-ack-${++serial}`;
  const [patient] = await q<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic acknowledgment patient') RETURNING id", [key]);
  const [invoice] = await q<{ id: number }>("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency) VALUES($1,$2,10000,0,'YER') RETURNING id", [key, patient.id]);
  return { key, patientId: patient.id, invoiceId: invoice.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function collection(f: Fixture, overrides: Record<string, unknown> = {}): DurableMoneyCommand {
  return { actor: ACTOR, patientId: f.patientId, owner: `collection:${f.patientId}`, receipt: null,
    attempt: { key: `${f.key}-collect`, phase: "sending", request: { url: "/api/payments", operation: "payment",
      body: JSON.stringify({ patientId: f.patientId, invoiceId: f.invoiceId, kind: "payment", amount: "0.81", currency: "SAR", method: "cash", note: null, ...overrides }) } } };
}
function correction(f: Fixture, origin: Payment, remainingMinor: number, mode: "correct" | "void", overrides: Record<string, unknown> = {}): DurableMoneyCommand {
  return { actor: ACTOR, patientId: f.patientId, owner: `correction:${origin.id}`,
    receipt: { id: origin.id, receiptNumber: origin.receiptNumber, amountMinor: origin.amountMinor, remainingMinor,
      currency: origin.currency, method: origin.method, invoiceId: origin.invoiceId, planId: origin.planId, openingCurrency: origin.openingCurrency },
    attempt: { key: `${f.key}-${mode}`, phase: "sending", request: { url: `/api/payments/${origin.id}/correct`, operation: mode,
      body: JSON.stringify({ mode, reason: WHY, target: "original", amount: "10", currency: "YER", method: "cash", ...overrides }) } } };
}
async function send(command: DurableMoneyCommand, includeKey = true) {
  const { request, key } = command.attempt;
  const input = new Request(`http://localhost${request.url}`, { method: "POST", headers: { "content-type": "application/json", ...(includeKey ? { "idempotency-key": key } : {}) }, body: request.body });
  const response = request.operation === "payment" ? await paymentPOST(input)
    : await correctionPOST(input, { params: Promise.resolve({ id: String(command.receipt!.id) }) });
  const payload = await response.json();
  return { status: response.status, payload, ack: readDurableMoneyAcknowledgment(payload, command) };
}
function restored(command: DurableMoneyCommand) {
  const saved = durableMoneyCommand(command);
  const recovered = restoreMoneyCommand(saved, command.patientId, command.actor);
  expect(recovered.attempt).toEqual({ key: command.attempt.key, request: command.attempt.request, phase: "uncertain" });
  expect(durableMoneyCommand(recovered).original).toBe(saved.original);
  return recovered;
}
async function snapshot() {
  const [state] = await q(`SELECT
    (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb) FROM payments p) AS payments,
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb) FROM audit_log a) AS audits,
    (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY id),'[]'::jsonb) FROM invoices i) AS invoices,
    (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb) FROM cashier_shifts s) AS shifts,
    (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY id),'[]'::jsonb) FROM invoice_corrections c) AS corrections,
    (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY id),'[]'::jsonb) FROM invoice_settlement_reclassifications d) AS documents,
    (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY id),'[]'::jsonb) FROM invoice_settlement_reclassification_events e) AS events,
    (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY id),'[]'::jsonb) FROM inventory_items i) AS stock,
    (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY id),'[]'::jsonb) FROM inventory_movements m) AS movements,
    (SELECT last_value::text FROM payments_id_seq) AS payment_sequence,
    (SELECT last_value::text FROM receipt_number_seq) AS receipt_sequence`);
  return state;
}
async function replay(command: DurableMoneyCommand, expectedPaymentId: number | null) {
  const before = await snapshot();
  const result = await send(restored(command));
  expect(result.status).toBe(200);
  expect(result.ack).toMatchObject({ paymentId: expectedPaymentId });
  const after = await snapshot();
  if (command.attempt.request.operation === "payment") {
    const { audits: oldAudits, ...oldFinancial } = before;
    const { audits: newAudits, ...newFinancial } = after;
    expect(newFinancial).toEqual(oldFinancial);
    const oldRows = oldAudits as unknown[], newRows = newAudits as unknown[];
    expect(newRows.slice(0, oldRows.length)).toEqual(oldRows);
    expect(newRows.slice(oldRows.length)).toEqual([expect.objectContaining({ action: "payment.idempotent_replay", entity_id: String(expectedPaymentId) })]);
  } else expect(after).toEqual(before);
  return result;
}
async function insertPayment(f: Fixture, options: {
  amountMinor?: number; baseAmountMinor?: number; rate?: number | string; kind?: "payment" | "refund";
  reversalOfId?: number; actor?: string; method?: string; patientId?: number; invoiceId?: number;
  key?: string; hash?: string; note?: string;
} = {}) {
  const [inserted] = await q<{ id: number }>(`INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,
    amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,note,created_by,reversal_of_id,idempotency_key,idempotency_request_hash)
    VALUES($1,$2,$3,$4,$5,$6,'SAR',$7,$8,'YER',$9,$10,$11,$12,$13,$14) RETURNING id`,
  [`${f.key}-legacy-${++serial}`, options.patientId ?? f.patientId, options.invoiceId ?? f.invoiceId, shiftId,
    options.kind ?? "payment", options.amountMinor ?? 81, options.rate ?? RAW, options.baseAmountMinor ?? 113,
    options.method ?? "cash", options.note ?? null, options.actor ?? ACTOR, options.reversalOfId ?? null, options.key ?? null, options.hash ?? null]);
  const receipt = await db.getPayment(inserted.id);
  if (!receipt) throw new Error("Synthetic receipt missing");
  return receipt;
}
async function legacyClosure(f: Fixture, options: { currentMethod?: string; prior?: boolean } = {}) {
  const origin = await insertPayment(f, options.prior ? { rate: RAW_UP, baseAmountMinor: 114 } : {});
  if (options.prior) await insertPayment(f, { kind: "refund", amountMinor: 1, baseAmountMinor: 1, rate: STORED,
    reversalOfId: origin.id, actor: "synthetic-earlier-cashier", method: "transfer" });
  const command = correction(f, origin, options.prior ? 80 : 81, "void");
  const reversal = await insertPayment(f, { kind: "refund", amountMinor: command.receipt!.remainingMinor, baseAmountMinor: 113,
    rate: STORED, reversalOfId: origin.id, method: options.currentMethod ?? "cash", key: command.attempt.key,
    note: `تصحيح السند ${origin.receiptNumber}: ${WHY}` });
  return { origin, reversal, command };
}
async function insertCorrectionAudit(f: Fixture, origin: Payment, reversal: Payment, replacement: Payment | null = null) {
  await q(`INSERT INTO audit_log(actor,actor_role,action,entity,entity_id,summary,details)
    VALUES($1,'admin','payment.correct','payment',$2,$3,$4::jsonb)`, [ACTOR, String(origin.id), origin.receiptNumber, JSON.stringify({
    الطريقة: replacement ? "تصحيح" : "إبطال", السبب: WHY, المريض: f.patientId,
    سند_العكس: reversal.receiptNumber, المبلغ_المعكوس: reversal.amountMinor, العملة_المعكوسة: reversal.currency,
    السند_الصحيح: replacement?.receiptNumber ?? null, المبلغ_الصحيح: replacement?.amountMinor ?? null, العملة_الصحيحة: replacement?.currency ?? null,
  })]);
}

beforeAll(async () => {
  await prepareManualCashFixture(originalEnvironment);
  await db.ensureSchema();
  const [version] = await q<{ version: string }>("SELECT current_setting('server_version_num') AS version");
  expect(Number(version.version)).toBeGreaterThanOrEqual(180000);
  expect(Number(version.version)).toBeLessThan(190000);
  [{ id: shiftId }] = await q<{ id: number }>("INSERT INTO cashier_shifts(opened_by) VALUES($1) RETURNING id", [ACTOR]);
  [{ id: otherPatientId }] = await q<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES('ACK-OTHER','Synthetic unrelated patient') RETURNING id");
  const [item] = await q<{ id: number }>("INSERT INTO inventory_items(name,created_by) VALUES('Synthetic acknowledgment stock sentinel',$1) RETURNING id", [ACTOR]);
  await q("INSERT INTO inventory_movements(item_id,kind,qty,created_by) VALUES($1,'in',7,$2)", [item.id, ACTOR]);
}, 180000);
beforeEach(async () => { await setRate(RAW); });
afterAll(async () => { await db.resetPoolForTesting(); });

describe("durable acknowledgment proves real receipts instead of repricing stored FX", () => {
  it("accepts raw-rate 81/113 on HTTP 201 and same-key 200 without changing financial rows", async () => {
    const f = await fixture(), command = collection(f);
    const result = await send(command);
    expect(result.status).toBe(201);
    expect(result.payload).toMatchObject({ amountMinor: 81, baseAmountMinor: 113, exchangeRate: STORED });
    expect(toBaseAmount(81, "SAR", "YER", STORED)).toBe(114);
    expect(result.ack).toEqual({ paymentId: result.payload.id });
    expect(result.payload.acknowledgmentEvidence).toMatchObject({ version: 1, operation: "payment", requestKey: command.attempt.key,
      calculation: { kind: "generic-v1-request-rate", paymentId: result.payload.id, amountMinor: 81,
        baseAmountMinor: 113, exchangeRate: STORED, calculationRate: RAW } });
    const repeated = await replay(command, result.payload.id);
    expect(repeated.payload.id).toBe(result.payload.id);
    for (const patch of [{ idempotencyKey: "unrelated-key" }, { patientId: otherPatientId }, { createdBy: "other" },
      { invoiceId: f.invoiceId + 1000 }, { amountMinor: 82 }, { baseAmountMinor: 112 }, { exchangeRate: 141 }, { method: "transfer" }, { reversalOfId: result.payload.id + 1 }]) {
      expect(readDurableMoneyAcknowledgment({ ...result.payload, ...patch }, command)).toBeNull();
    }
    const proof = result.payload.acknowledgmentEvidence;
    for (const acknowledgmentEvidence of [{ version: 1, status: "unconfirmed" }, { ...proof, version: 99 },
      { ...proof, requestKey: "another-command" }, { ...proof, calculation: { ...proof.calculation, calculationRate: STORED } },
      { ...proof, calculation: { ...proof.calculation, calculationRate: 140 } },
      { ...proof, calculation: { ...proof.calculation, paymentId: result.payload.id + 1 } }]) {
      expect(readDurableMoneyAcknowledgment({ ...result.payload, acknowledgmentEvidence }, command)).toBeNull();
    }
  });

  it("a historical raw receipt needs the observed hash witness, not invented creation audit", async () => {
    const f = await fixture(), command = collection(f);
    const hash = createHash("sha256").update(JSON.stringify({ v: 1, actor: ACTOR, patientId: f.patientId,
      invoiceId: f.invoiceId, kind: "payment", amountMinor: 81, currency: "SAR", baseCurrency: "YER",
      exchangeRate: RAW, method: "cash", reversalOfId: null })).digest("hex");
    const origin = await insertPayment(f, { key: command.attempt.key, hash });
    await replay(command, origin.id);
    expect(await q("SELECT id FROM audit_log WHERE action='payment.create' AND entity_id=$1", [String(origin.id)])).toEqual([]);
    await setRate(175.9876543);
    const before = await snapshot(), result = await send(restored(command));
    expect(result.status).toBe(409);
    expect(result.ack).toBeNull();
    expect(await snapshot()).toEqual(before);
  });

  it.each(["void", "correct"] as const)("closes the exact 80/113 residual budget through %s with unrelated prior refund actor/method", async (mode) => {
    const f = await fixture();
    await setRate(RAW_UP);
    const created = await send(collection(f));
    expect(created.status).toBe(201);
    const origin = created.payload as Payment;
    expect(origin).toMatchObject({ amountMinor: 81, baseAmountMinor: 114, exchangeRate: STORED });
    await insertPayment(f, { kind: "refund", amountMinor: 1, baseAmountMinor: 1, rate: STORED,
      reversalOfId: origin.id, actor: "synthetic-earlier-cashier", method: "transfer" });
    const command = correction(f, origin, 80, mode), result = await send(command);
    expect(result.status).toBe(201);
    expect(result.payload.reversal).toMatchObject({ amountMinor: 80, baseAmountMinor: 113, reversalOfId: origin.id, method: "cash" });
    expect(toBaseAmount(80, "SAR", "YER", STORED)).toBe(112);
    expect(result.ack).toMatchObject({ paymentId: mode === "correct" ? result.payload.replacement.id : null, reversal: { id: result.payload.reversal.id } });
    expect(readDurableMoneyAcknowledgment(result.payload, { ...command,
      receipt: { ...command.receipt!, remainingMinor: 79 } })).toBeNull();
    await replay(command, mode === "correct" ? result.payload.replacement.id : null);
    const [totals] = await q("SELECT SUM(amount_minor)::text AS native,SUM(base_amount_minor)::text AS base FROM payments WHERE reversal_of_id=$1", [origin.id]);
    expect(totals).toEqual({ native: "81", base: "114" });
    for (const patch of [{ reversalOfId: origin.id + 1000 }, { method: "transfer" }, { amountMinor: 79 }, { baseAmountMinor: 112 }]) {
      expect(readDurableMoneyAcknowledgment({ ...result.payload, reversal: { ...result.payload.reversal, ...patch } }, command)).toBeNull();
    }
  });

  it("accepts a complete historical 81/113 budget void without revaluing the immutable source", async () => {
    const f = await fixture(), origin = await insertPayment(f);
    const command = correction(f, origin, 81, "void"), result = await send(command);
    expect(result.status).toBe(201);
    expect(result.payload.reversal).toMatchObject({ amountMinor: 81, baseAmountMinor: 113, exchangeRate: STORED });
    expect(result.ack).toMatchObject({ paymentId: null, reversal: { id: result.payload.reversal.id } });
    await replay(command, null);
  });

  it("confirms a raw replacement only while a valid original raw-rate witness remains", async () => {
    const f = await fixture(), sourceCommand = collection(f, { amount: "500", currency: "YER" });
    const source = await send(sourceCommand);
    expect(source.status).toBe(201);
    const command = correction(f, source.payload as Payment, 500, "correct", { amount: "0.81", currency: "SAR" });
    const first = await send(command);
    expect(first.status).toBe(201);
    expect(first.payload.replacement).toMatchObject({ amountMinor: 81, baseAmountMinor: 113, exchangeRate: STORED });
    expect(first.ack).toMatchObject({ paymentId: first.payload.replacement.id });
    await replay(command, first.payload.replacement.id);
    await setRate(175.9876543);
    const before = await snapshot(), unknown = await send(restored(command));
    expect(unknown.status).toBe(200); // Existing writer replay contract is deliberately unchanged.
    expect(unknown.payload.replacement.id).toBe(first.payload.replacement.id);
    expect(unknown.ack).toBeNull();
    expect(unknown.payload.acknowledgmentEvidence).toEqual({ version: 1, status: "unconfirmed" });
    expect(await snapshot()).toEqual(before);
    expect(restored(command).attempt.key).toBe(command.attempt.key);
    await setRate(RAW);
    await replay(command, first.payload.replacement.id);
  });

  it.each([false, true])("optional settings observation failure does not change saved-key admission: off-grid=%s", async (offGrid) => {
    const f = await fixture(), source = await send(collection(f, { amount: "500", currency: "YER" }));
    expect(source.status).toBe(201);
    const command = correction(f, source.payload as Payment, 500, "correct", offGrid ? { amount: "0.81", currency: "SAR" } : {});
    const first = await send(command);
    expect(first.status).toBe(201);
    expect(first.ack).toMatchObject({ paymentId: first.payload.replacement.id });
    const recovered = restored(command), before = await snapshot();
    const settings = vi.spyOn(db, "getSettings").mockRejectedValueOnce(new Error("Synthetic optional settings read failure"));
    try {
      const result = await send(recovered);
      expect(settings).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(200);
      expect(result.payload).toMatchObject({ replayed: true, idempotencyKey: command.attempt.key,
        replacement: { id: first.payload.replacement.id } });
      if (offGrid) {
        expect(result.ack).toBeNull();
        expect(result.payload.acknowledgmentEvidence).toEqual({ version: 1, status: "unconfirmed" });
      } else expect(result.ack).toMatchObject({ paymentId: first.payload.replacement.id });
      expect(recovered.attempt.key).toBe(command.attempt.key);
      expect(recovered.attempt.request).toEqual(command.attempt.request);
      expect(await snapshot()).toEqual(before);
    } finally { settings.mockRestore(); }
  });

  it("does not promote missing or ambiguous correction audit into a confirmed legacy replay", async () => {
    const f = await fixture(), legacy = await legacyClosure(f, { prior: true });
    let before = await snapshot();
    const missing = await send(restored(legacy.command));
    expect(missing.status).toBe(200);
    expect(missing.ack).toBeNull();
    expect(missing.payload.acknowledgmentEvidence).toEqual({ version: 1, status: "unconfirmed" });
    expect(await snapshot()).toEqual(before);
    await insertCorrectionAudit(f, legacy.origin, legacy.reversal);
    await replay(legacy.command, null);
    await insertCorrectionAudit(f, legacy.origin, legacy.reversal);
    before = await snapshot();
    const ambiguous = await send(restored(legacy.command));
    expect(ambiguous.status).toBe(200);
    expect(ambiguous.ack).toBeNull();
    expect(ambiguous.payload.acknowledgmentEvidence).toEqual({ version: 1, status: "unconfirmed" });
    expect(await snapshot()).toEqual(before);
  });

  it("enumerates refund membership globally instead of hiding a different patient's linked refund", async () => {
    const f = await fixture(), legacy = await legacyClosure(f);
    await insertCorrectionAudit(f, legacy.origin, legacy.reversal);
    await replay(legacy.command, null);
    await insertPayment(f, { kind: "refund", amountMinor: 1, baseAmountMinor: 1, rate: STORED,
      reversalOfId: legacy.origin.id, patientId: otherPatientId, actor: "synthetic-other-cashier" });
    const before = await snapshot(), contaminated = await send(restored(legacy.command));
    expect(contaminated.status).toBe(200);
    expect(contaminated.ack).toBeNull();
    expect(await snapshot()).toEqual(before);
  });

  it("refuses an audited legacy reversal whose method does not match the original receipt", async () => {
    const f = await fixture(), legacy = await legacyClosure(f, { currentMethod: "transfer" });
    await insertCorrectionAudit(f, legacy.origin, legacy.reversal);
    const before = await snapshot(), result = await send(restored(legacy.command));
    expect(result.status).toBe(200);
    expect(result.ack).toBeNull();
    expect(await snapshot()).toEqual(before);
  });

  it("keeps a hash-matching but base-contradictory historical HTTP replay explicitly unconfirmed", async () => {
    const f = await fixture(), command = collection(f);
    const hash = createHash("sha256").update(JSON.stringify({ v: 1, actor: ACTOR, patientId: f.patientId,
      invoiceId: f.invoiceId, kind: "payment", amountMinor: 81, currency: "SAR", baseCurrency: "YER",
      exchangeRate: RAW, method: "cash", reversalOfId: null })).digest("hex");
    const origin = await insertPayment(f, { key: command.attempt.key, hash, baseAmountMinor: 112 });
    const before = await snapshot(), result = await send(restored(command)), after = await snapshot();
    expect(result.status).toBe(200);
    expect(result.payload).toMatchObject({ id: origin.id, baseAmountMinor: 112,
      acknowledgmentEvidence: { version: 1, status: "unconfirmed" } });
    expect(result.ack).toBeNull();
    const { audits: oldAudits, ...oldFinancial } = before, { audits: newAudits, ...newFinancial } = after;
    expect(newFinancial).toEqual(oldFinancial);
    expect((newAudits as unknown[]).slice(0, (oldAudits as unknown[]).length)).toEqual(oldAudits);
    expect((newAudits as unknown[]).slice((oldAudits as unknown[]).length)).toEqual([
      expect.objectContaining({ action: "payment.idempotent_replay", entity_id: String(origin.id) }),
    ]);
  });

  it("rolls back a new correction when its persisted audit membership cannot be proved before commit", async () => {
    const f = await fixture(), source = await send(collection(f, { amount: "500", currency: "YER" }));
    expect(source.status).toBe(201);
    const origin = source.payload as Payment;
    await q(`INSERT INTO audit_log(actor,actor_role,action,entity,entity_id,summary,details)
      VALUES($1,'admin','payment.correct','payment',$2,'Synthetic contradictory prior audit',$3::jsonb)`,
    [ACTOR, String(origin.id), JSON.stringify({ السبب: "Contradictory synthetic historical event", المريض: f.patientId })]);
    const command = correction(f, origin, 500, "correct"), before = await snapshot(), result = await send(command), after = await snapshot();
    expect(result.status).toBe(500);
    expect(result.ack).toBeNull();
    const { payment_sequence: oldPayments, receipt_sequence: oldReceipts, ...oldFinancial } = before;
    const { payment_sequence: newPayments, receipt_sequence: newReceipts, ...newFinancial } = after;
    expect(newFinancial).toEqual(oldFinancial);
    // PostgreSQL sequences are nontransactional, so attempted inserts may consume
    // numbers even though every financial row and the new audit rolled back.
    expect(BigInt(newPayments as string)).toBeGreaterThanOrEqual(BigInt(oldPayments as string));
    expect(BigInt(newReceipts as string)).toBeGreaterThanOrEqual(BigInt(oldReceipts as string));
    expect(await q("SELECT id FROM payments WHERE idempotency_key=$1 OR reversal_of_id=$2", [command.attempt.key, origin.id])).toEqual([]);
  });

  it.each(["void", "correct"] as const)("preserves normal keyed HTTP %s acknowledgment and exact replay", async (mode) => {
    const f = await fixture(), source = await send(collection(f, { amount: "500", currency: "YER" }));
    expect(source.status).toBe(201);
    const command = correction(f, source.payload as Payment, 500, mode), result = await send(command);
    expect(result.status).toBe(201);
    expect(result.payload.reversal).toMatchObject({ amountMinor: 500, baseAmountMinor: 500, currency: "YER", exchangeRate: 1 });
    const expectedId = mode === "correct" ? result.payload.replacement.id : null;
    expect(result.ack).toMatchObject({ paymentId: expectedId });
    await replay(command, expectedId);
  });

  it.each(["void", "correct"] as const)("preserves omitted-key HTTP %s admission without adding evidence", async (mode) => {
    const f = await fixture(), source = await send(collection(f, { amount: "500", currency: "YER" }));
    expect(source.status).toBe(201);
    const command = correction(f, source.payload as Payment, 500, mode), result = await send(command, false);
    expect(result.status).toBe(201);
    expect(result.payload).toMatchObject({ idempotencyKey: null, replayed: false });
    expect(result.payload).not.toHaveProperty("acknowledgmentEvidence");
    expect(result.payload.reversal).toMatchObject({ amountMinor: 500, baseAmountMinor: 500 });
    expect(mode === "correct" ? result.payload.replacement.amountMinor : result.payload.replacement).toBe(mode === "correct" ? 10 : null);
  });

  it.each(["void", "correct"] as const)("preserves direct %s caller opt-out without adding evidence", async (mode) => {
    const f = await fixture(), source = await send(collection(f, { amount: "500", currency: "YER" }));
    expect(source.status).toBe(201);
    const result = await db.correctPayment({ paymentId: source.payload.id, reason: WHY, actor: ACTOR, actorRole: "admin",
      idempotencyKey: `${f.key}-direct`, replacement: mode === "void" ? null : {
        amountMinor: 10, currency: "YER", exchangeRate: 1, method: "cash", target: { kind: "original" },
      } });
    if (result.reason !== null) throw new Error(`Synthetic direct correction refused: ${result.reason}`);
    expect(result).toMatchObject({ replayed: false, reversal: { amountMinor: 500, baseAmountMinor: 500 } });
    expect(result).not.toHaveProperty("acknowledgmentEvidence");
    expect(mode === "correct" ? result.replacement?.amountMinor : result.replacement).toBe(mode === "correct" ? 10 : null);
  });

  it.each(["YER", "SAR"] as const)("keeps direct-arithmetic %s receipt acknowledgments compatible", async (currency) => {
    const f = await fixture();
    await setRate(140);
    const command = collection(f, { amount: "10", currency }), first = await send(command);
    expect(first.status).toBe(201);
    expect(first.ack).toEqual({ paymentId: first.payload.id });
    await replay(command, first.payload.id);
  });
});

async function correctionDocument(client: DbClient, patientId: number, originalId: number, correctedId: number,
  originalCurrency: "YER" | "SAR", currency: "YER" | "SAR", key: string) {
  const { rows: [document] } = await client.query<{ id: number }>(`INSERT INTO invoice_corrections(patient_id,currency,original_currency,
    original_invoice_id,corrected_invoice_id,idempotency_key,request_hash,reason,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,'Synthetic acknowledgment lineage',$8) RETURNING id`,
  [patientId, currency, originalCurrency, originalId, correctedId, key, "a".repeat(64), ACTOR]);
  await client.query("INSERT INTO invoice_correction_receipts(correction_id,receipt) VALUES($1,$2::jsonb)", [document.id, JSON.stringify({
    patientId, currency, idempotencyKey: key, createdBy: ACTOR,
    original: { id: originalId, patientId, baseCurrency: originalCurrency }, corrected: { id: correctedId, patientId, baseCurrency: currency },
  })]);
  return document.id;
}
/** Complete append-only 0063 proof, including an ancestor before reclassification
 * and a successor afterward. The database validates the real mapping at COMMIT. */
async function reclassifiedFixture() {
  const key = `synthetic-ack-lineage-${++serial}`, client = await db.getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: [patient] } = await client.query<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic acknowledgment lineage patient') RETURNING id", [key]);
    async function invoice(suffix: string, currency: "YER" | "SAR", status: string) {
      const { rows: [row] } = await client.query<{ id: number }>(`INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,status,created_by)
        VALUES($1,$2,$3,0,$4,$5,$6) RETURNING id`, [`${key}-${suffix}`, patient.id, currency === "YER" ? 4 : 3, currency, status, ACTOR]);
      return row.id;
    }
    const sourceId = await invoice("source", "YER", "cancelled");
    const middleId = await invoice("middle", "YER", "cancelled");
    await correctionDocument(client, patient.id, sourceId, middleId, "YER", "YER", `${key}-ancestor`);
    const mappedId = await invoice("mapped", "SAR", "cancelled");
    const targetId = await invoice("target", "SAR", "open");
    const { rows: [source] } = await client.query<{ id: number }>(`INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,
      amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by)
      VALUES($1,$2,$3,$4,'payment',3,'SAR',140,4,'YER','cash',$5) RETURNING id`, [`${key}-receipt`, patient.id, sourceId, shiftId, ACTOR]);
    const correctionId = await correctionDocument(client, patient.id, middleId, mappedId, "YER", "SAR", `${key}-reclassified`);
    const { rows: [document] } = await client.query<{ id: number }>(`INSERT INTO invoice_settlement_reclassifications(correction_id,patient_id,source_currency,target_currency,source_invoice_ids)
      VALUES($1,$2,'YER','SAR',$3) RETURNING id`, [correctionId, patient.id, [sourceId, middleId]]);
    await client.query(`INSERT INTO invoice_settlement_reclassification_events(reclassification_id,payment_id,direction,source_minor,target_minor,payment_snapshot)
      SELECT $1,id,1,base_amount_minor,amount_minor,to_jsonb(p) FROM payments p WHERE id=$2`, [document.id, source.id]);
    await correctionDocument(client, patient.id, mappedId, targetId, "SAR", "SAR", `${key}-successor`);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const evidence = await readCurrencyReclassificationEvidence(client, patient.id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ documentId: document.id, paymentId: source.id, sourceInvoiceId: sourceId, targetInvoiceId: targetId });
    await client.query("COMMIT");
    const origin = await db.getPayment(source.id);
    if (!origin) throw new Error("Synthetic reclassified source missing");
    return { key, patientId: patient.id, invoiceId: sourceId, mappedId, targetId, documentId: document.id, origin };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

describe("durable correction acknowledgment follows verified settlement lineage only", () => {
  it("accepts the real inherited target mapping and rejects copied, disconnected, or contradictory proof", async () => {
    await setRate(140);
    const f = await reclassifiedFixture();
    const command = correction(f, f.origin, 3, "correct", { amount: "0.02", currency: "SAR" });
    const first = await send(command);
    expect(first.status).toBe(201);
    expect(first.payload.reversal).toMatchObject({ invoiceId: f.invoiceId, reversalOfId: f.origin.id, amountMinor: 3, baseAmountMinor: 4 });
    expect(first.payload.replacement).toMatchObject({ invoiceId: f.targetId, amountMinor: 2, baseAmountMinor: 3 });
    expect(first.ack).toMatchObject({ paymentId: first.payload.replacement.id });
    const proof = first.payload.acknowledgmentEvidence;
    expect(proof).toMatchObject({ version: 1, operation: "correct", requestKey: command.attempt.key,
      correction: { replacementLineage: { kind: "reclassified-original-target", patientId: f.patientId,
        originalPaymentId: f.origin.id, sourceInvoiceId: f.invoiceId, targetInvoiceId: f.targetId,
        documentId: f.documentId, documentCorrectedInvoiceId: f.mappedId } } });
    expect(proof.correction.replacementLineage.path).toHaveLength(1);
    await replay(command, first.payload.replacement.id);
    for (const patch of [
      { patientId: otherPatientId }, { originalPaymentId: f.origin.id + 1000 }, { sourceInvoiceId: f.mappedId },
      { targetInvoiceId: f.mappedId }, { sourceInvoiceIds: [] }, { path: [] },
      { path: [{ ...proof.correction.replacementLineage.path[0], originalInvoiceId: f.invoiceId }] },
      { path: [{ ...proof.correction.replacementLineage.path[0], correctedInvoiceId: f.mappedId }] },
    ]) {
      const tampered = { ...first.payload, acknowledgmentEvidence: { ...proof, correction: { ...proof.correction,
        replacementLineage: { ...proof.correction.replacementLineage, ...patch } } } };
      expect(readDurableMoneyAcknowledgment(tampered, command)).toBeNull();
    }
    // A later legitimate same-currency invoice correction must not rewrite the
    // receipt or make its saved target cease to be provable during retry.
    const client = await db.getPool().connect();
    let laterInvoiceId: number;
    try {
      await client.query("BEGIN");
      const { rows: [later] } = await client.query<{ id: number }>(`INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,status,created_by)
        VALUES($1,$2,3,0,'SAR','open',$3) RETURNING id`, [`${f.key}-later`, f.patientId, ACTOR]);
      laterInvoiceId = later.id;
      await client.query("UPDATE invoices SET status='cancelled' WHERE id=$1", [f.targetId]);
      await correctionDocument(client, f.patientId, f.targetId, laterInvoiceId, "SAR", "SAR", `${f.key}-later-correction`);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    const currentLineage = await readCurrencyReclassificationEvidence(db.getPool(), f.patientId);
    expect(currentLineage.find(row => row.paymentId === f.origin.id)?.targetInvoiceId).toBe(laterInvoiceId);
    const replayedAfterMove = await replay(command, first.payload.replacement.id);
    expect(replayedAfterMove.payload.replacement.invoiceId).toBe(f.targetId);
    expect(replayedAfterMove.payload.acknowledgmentEvidence.correction.replacementLineage).toMatchObject({
      sourceInvoiceId: f.invoiceId, targetInvoiceId: f.targetId, path: proof.correction.replacementLineage.path,
    });
    const explicit = { ...command, attempt: { ...command.attempt, request: { ...command.attempt.request,
      body: JSON.stringify({ mode: "correct", reason: WHY, invoiceId: f.invoiceId, amount: "0.02", currency: "SAR", method: "cash" }) } } };
    expect(readDurableMoneyAcknowledgment(first.payload, explicit)).toBeNull();
  });
});


describe("response evidence matches PostgreSQL exact six-decimal snapshots", () => {
  it.each([
    ["original raw witness", RAW, STORED, true],
    ["same base is not the same stored rate", 140, STORED, false],
    ["half tie carries integer", 1.9999995, 2, true],
    ["half tie carries decimal", 9.9999995, 10, true],
    ["below half", 1.9999994, 1.999999, true],
    ["scientific half tie", 5e-7, 1e-6, true],
    ["scientific exact", 1e-6, 1e-6, true],
    ["tiny rounds zero", 4.9e-7, 0, false],
    ["smaller scientific rounds zero", 1e-9, 0, false],
    ["positive stored zero", 1e-6, 0, false],
    ["overflow at precision boundary", 1e12, 1e12, false],
    ["large scientific overflow", 1e21, 1e21, false],
    ["largest nearby representable rate", 999999999999.9999, 999999999999.9999, true],
    ["stored overprecision is not normalized", 1.234567, 1.2345671, false],
    ["negative rate", -1, -1, false],
    ["zero rate", 0, 0, false],
    ["nonfinite rate", Infinity, 1, false],
    ["NaN rate", NaN, 1, false],
  ] as const)("%s agrees with actual numeric(18,6) range and rounding", async (_label, calculationRate, storedRate, expected) => {
    const [postgres] = await q<{ matches: boolean }>(`WITH candidate AS (
      SELECT ROUND($1::numeric,6) AS rounded,$2::numeric AS stored)
      SELECT CASE WHEN rounded>0 AND rounded<1000000000000::numeric
        THEN rounded::numeric(18,6)=stored AND stored=ROUND(stored,6)
          AND $3::numeric=stored ELSE FALSE END AS matches FROM candidate`,
    [String(calculationRate), String(storedRate), String(Number(String(storedRate)))]);
    expect(postgres.matches).toBe(expected);
    expect(calculationRateMatchesStoredSnapshot(calculationRate, storedRate)).toBe(postgres.matches);
  });

  it.each([
    ["999999999999.123456", false],
    ["99999999999.123456", false],
    ["999999999999.123400", true],
    ["1234567890.123457", true],
  ] as const)("persisted large-rate %s requires an exact Number DTO roundtrip", async (storedDecimal, representable) => {
    const rate = Number(storedDecimal), f = await fixture();
    const [postgres] = await q<{ roundtrip: boolean }>("SELECT $1::numeric(18,6)=$2::numeric AS roundtrip", [storedDecimal, String(rate)]);
    expect(postgres.roundtrip).toBe(representable);
    const hashAtRate = (candidate: number) => createHash("sha256").update(JSON.stringify({ v: 1, actor: ACTOR,
      patientId: f.patientId, invoiceId: f.invoiceId, kind: "payment", amountMinor: 1, currency: "SAR",
      baseCurrency: "YER", exchangeRate: candidate, method: "cash", reversalOfId: null })).digest("hex");
    const key = `${f.key}-dto-roundtrip`;
    const row = await insertPayment(f, { amountMinor: 1, baseAmountMinor: toBaseAmount(1, "SAR", "YER", rate),
      rate: storedDecimal, key, hash: hashAtRate(rate) });
    const before = await snapshot();
    const proof = await provePaymentCalculation(db.getPool(), { paymentId: row.id, key, rates: [rate], hashAtRate });
    if (representable) expect(proof).toMatchObject({ paymentId: row.id, calculationRate: rate, exchangeRate: rate });
    else expect(proof).toBeNull();
    expect(await snapshot()).toEqual(before);
  });
});
