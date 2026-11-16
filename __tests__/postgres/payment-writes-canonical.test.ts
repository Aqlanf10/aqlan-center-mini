/** M2 slice 91: payment correction and debt repayment on the canonical runtime, real
 * PostgreSQL, synthetic data only. finance.payments.void (+ finance.payments.collect for a
 * replacement); finance.payments.collect inside the patient scope for arrangements and
 * collection; the legacy writers on the operation's transaction (shift rule, request keys,
 * audit in the same transaction); refusals roll everything back; revocation; a debt actor
 * cannot be forged. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-payment-writes-secret-91");
const db = await import("../../lib/db");
const writes = await import("../../lib/canonical-payment-writes");
const debts = await import("../../lib/debt-installments-db");

const VIEW = { "finance.payments.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-PW-OWNER", role: "admin" },
  voider: { username: "SYN-PW-VOID", role: "reception", patientScope: "all", grants: { ...VIEW, "finance.payments.void": true } },
  corrector: { username: "SYN-PW-CORR", role: "reception", patientScope: "all", grants: { ...VIEW, "finance.payments.void": true, "finance.payments.collect": true } },
  collector: { username: "SYN-PW-COLL", role: "reception", patientScope: "all", grants: { "finance.payments.collect": true } },
  doctor: { username: "SYN-PW-DR", role: "doctor", doctor: true, patientScope: "own", grants: { "finance.payments.collect": true } },
  reader: { username: "SYN-PW-READ", role: "reception", patientScope: "all", grants: { "finance.patient-ledger.view": true, "finance.invoices.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let serial = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; reason?: string; message?: string }) => error);
const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };
const count = async (sql: string, args: unknown[]) => (await q(`SELECT count(*)::int AS n FROM ${sql}`, args))[0].n as number;

async function patient(doctor: number | null = null) {
  return (await q("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN PW patient',$2) RETURNING id", [`SYN-PW-${++serial}`, doctor]))[0].id as number;
}
async function receipt(patientId: number, amountMinor = 5000) {
  const made = await db.recordPayment({ patientId, invoiceId: null, openingCurrency: null, amountMinor, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
    kind: "payment", method: "cash", note: null, createdBy: "SYN", idempotencyKey: `syn-pw-receipt-${++serial}` });
  expect(made.reason).toBeNull();
  return (made as { payment: { id: number } }).payment.id;
}
async function debt(patientId: number, amount = 60000) {
  const invoiceId = (await q("INSERT INTO invoices(invoice_number,patient_id,base_currency,total_minor,discount_minor,created_by) VALUES($1,$2,'YER',$3,0,'SYN') RETURNING id", [`SYN-PW-INV-${++serial}`, patientId, amount]))[0].id as number;
  return {
    target: { patientId, currency: "YER" as const, invoiceId, openingCurrency: null },
    terms: { mode: "installments", installments: [{ dueDate: "2026-12-01", amountMinor: amount, kind: "installment" }] },
    expectedVersion: 0, expectedRemainingMinor: amount, reason: "SYN schedule", idempotencyKey: `syn-pw-schedule-${++serial}`,
  };
}
const collection = (patientId: number, arrangementId: number, amountMinor: number, idempotencyKey = `syn-pw-collect-${++serial}`) =>
  ({ patientId, arrangementId, expectedVersion: 1, amountMinor, currency: "YER" as const, method: "cash" as const, note: null, idempotencyKey });
const noRate = async () => ({ exchangeRate: 1, acknowledgmentRate: 1 });
/** Runs `body` with no open shift: closes the open one at its expected counts (closed shifts
 * are append-only), then opens a fresh one. */
async function withoutShift(body: () => Promise<void>) {
  const shift = await db.getOpenShift();
  expect((await db.closeShift({ id: shift!.id, closedBy: "SYN-PW-OWNER", counted: shift!.expected, note: "SYN close" })).reason).toBeNull();
  try { await body(); } finally { await db.openShift({ openedBy: "SYN-PW-OWNER", opening: { YER: 0, SAR: 0, USD: 0 } }); }
}

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  await db.openShift({ openedBy: "SYN-PW-OWNER", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("payment correction", () => {
  it("finance.payments.void reverses the receipt in one audited operation; an exact replay returns it", async () => {
    const p = await patient(), id = await receipt(p);
    const key = `syn-pw-void-${++serial}`;
    const command = { paymentId: id, reason: "SYN entered twice", idempotencyKey: key, replacement: null };
    const done = await writes.commandCanonicalPaymentCorrection(await fx.session("voider"), command, noRate, fx.pool);
    expect(done).toMatchObject({ reason: null, replayed: false, reversal: { kind: "refund", reversalOfId: id }, replacement: null });
    expect(await q("SELECT actor, actor_role, details->>'السبب' AS why FROM audit_log WHERE action='payment.correct' AND entity_id=$1", [String(id)]))
      .toEqual([{ actor: "SYN-PW-VOID", actor_role: "reception", why: "SYN entered twice" }]);
    const again = await writes.commandCanonicalPaymentCorrection(await fx.session("voider"), command, noRate, fx.pool);
    expect(again).toMatchObject({ replayed: true, reversal: { id: done.reversal!.id } });
    expect(await count("payments WHERE reversal_of_id=$1", [id])).toBe(1);
  });

  it("a replacement receipt also needs finance.payments.collect; refused before any write", async () => {
    const p = await patient(), id = await receipt(p);
    const replacement = { amountMinor: 4000, currency: "YER" as const, method: "cash", target: { kind: "original" as const } };
    const command = { paymentId: id, reason: "SYN wrong amount", idempotencyKey: `syn-pw-corr-${++serial}`, replacement };
    expect(await refusal(writes.commandCanonicalPaymentCorrection(await fx.session("voider"), command, noRate, fx.pool))).toMatchObject({ code: "collect_not_granted", status: 403 });
    expect(await count("payments WHERE patient_id=$1", [p])).toBe(1);
    const done = await writes.commandCanonicalPaymentCorrection(await fx.session("corrector"), command, noRate, fx.pool);
    expect(done).toMatchObject({ reversal: { amountMinor: 5000 }, replacement: { amountMinor: 4000, createdBy: "SYN-PW-CORR" } });
  });

  it("refused without the void grant (collection and ledger grants never substitute); no shift rolls back; revocation", async () => {
    const p = await patient(), id = await receipt(p);
    const command = { paymentId: id, reason: "SYN void", idempotencyKey: `syn-pw-void-${++serial}`, replacement: null };
    for (const key of ["collector", "reader"] as const) {
      expect(await refusal(writes.commandCanonicalPaymentCorrection(await fx.session(key), command, noRate, fx.pool))).toMatchObject(denied);
    }
    await withoutShift(async () => {
      expect(await refusal(writes.commandCanonicalPaymentCorrection(await fx.session("voider"), command, noRate, fx.pool))).toMatchObject({ reason: "no_shift" });
    });
    expect(await count("payments WHERE patient_id=$1", [p])).toBe(1);
    expect(await count("audit_log WHERE action='payment.correct' AND entity_id=$1", [String(id)])).toBe(0);
    await fx.setGrants("voider", VIEW, { patientScope: "all" });
    try {
      expect(await refusal(writes.commandCanonicalPaymentCorrection(await fx.session("voider"), command, noRate, fx.pool))).toMatchObject(denied);
    } finally { await fx.setGrants("voider", { ...VIEW, "finance.payments.void": true }, { patientScope: "all" }); }
  });
});

describe("debt repayment", () => {
  it("finance.payments.collect arranges and collects inside the scope; created_by and the audit carry the canonical actor; replay", async () => {
    const p = await patient(), write = await debt(p);
    const arranged = await writes.commandCanonicalDebtRepayment(await fx.session("collector"), write, fx.pool);
    expect(arranged).toMatchObject({ version: 1, replayed: false, receipt: { createdBy: "SYN-PW-COLL" } });
    expect(await writes.commandCanonicalDebtRepayment(await fx.session("collector"), write, fx.pool)).toMatchObject({ replayed: true, arrangementId: arranged.arrangementId });
    const input = collection(p, arranged.arrangementId, 20000);
    const paid = await writes.commandCanonicalDebtCollection(await fx.session("collector"), input, {}, fx.pool);
    expect(paid).toMatchObject({ replayed: false, payment: { amountMinor: 20000, createdBy: "SYN-PW-COLL", invoiceId: write.target.invoiceId } });
    expect(await q("SELECT actor, actor_role FROM audit_log WHERE action='debt_repayment.collect' AND entity_id=$1", [String(paid.payment!.id)]))
      .toEqual([{ actor: "SYN-PW-COLL", actor_role: "reception" }]);
    expect(await writes.commandCanonicalDebtCollection(await fx.session("collector"), input, {}, fx.pool)).toMatchObject({ replayed: true, payment: { id: paid.payment!.id } });
    expect(await count("payments WHERE patient_id=$1", [p])).toBe(1);
  });

  it("outside the patient scope reads like missing; no grant, no shift and revocation refuse; nothing is written", async () => {
    const mine = await patient(fx.parties.doctor!), other = await patient();
    const write = await debt(other);
    expect(await refusal(writes.commandCanonicalDebtRepayment(await fx.session("doctor"), write, fx.pool))).toMatchObject({ code: "patient_not_found", status: 404 });
    expect(await writes.commandCanonicalDebtRepayment(await fx.session("doctor"), await debt(mine), fx.pool)).toMatchObject({ version: 1 });
    expect(await refusal(writes.commandCanonicalDebtRepayment(await fx.session("reader"), write, fx.pool))).toMatchObject(denied);
    expect(await count("debt_repayment_arrangements WHERE patient_id=$1", [other])).toBe(0);
    const arranged = await writes.commandCanonicalDebtRepayment(await fx.session("collector"), write, fx.pool);
    await withoutShift(async () => {
      expect(await refusal(writes.commandCanonicalDebtCollection(await fx.session("collector"), collection(other, arranged.arrangementId, 1000), {}, fx.pool))).toMatchObject({ code: "stale" });
    });
    await fx.setGrants("collector", {}, { patientScope: "all" });
    try {
      expect(await refusal(writes.commandCanonicalDebtCollection(await fx.session("collector"), collection(other, arranged.arrangementId, 1000), {}, fx.pool))).toMatchObject(denied);
    } finally { await fx.setGrants("collector", { "finance.payments.collect": true }, { patientScope: "all" }); }
    expect(await count("payments WHERE patient_id=$1", [other])).toBe(0);
  });

  it("a debt actor cannot be forged: a plain object fails, and a branded actor whose recheck fails is refused", async () => {
    const p = await patient(), write = await debt(p);
    const forged = { userId: fx.ids.collector, username: "SYN-PW-COLL", role: "reception" };
    await expect(debts.saveDebtRepayment({ ...write, session: forged as never })).rejects.toBeTruthy();
    const stale = debts.canonicalDebtActor({ userId: fx.ids.collector, username: "SYN-PW-COLL", role: "reception" }, async () => false);
    await expect(debts.saveDebtRepayment({ ...write, session: stale })).rejects.toMatchObject({ code: "unauthorized" });
    expect(await count("debt_repayment_arrangements WHERE patient_id=$1", [p])).toBe(0);
  });
});
