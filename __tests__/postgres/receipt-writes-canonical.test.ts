/** M2 slice 90b (G4-4): ordinary receipts and refunds on the canonical runtime, real
 * PostgreSQL, synthetic data only. A receipt by finance.payments.collect, a refund by
 * finance.payments.refund, neither implying the other nor any read; administrative labels
 * and view grants never reach them; inside the patient scope (outside reads like missing,
 * decided after the writer's waits); the legacy writer's controls (shift, key replay with
 * its audit, remaining) roll the whole operation back; revocation. Agreement-funded plans
 * and the recovery (slice 90c): plan-collections-canonical.test.ts. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-receipt-writes-secret-90b");
const db = await import("../../lib/db");
const rc = await import("../../lib/canonical-receipt-writes");

const ACCOUNTS = {
  owner: { username: "SYN-RW-OWNER", role: "admin" },
  collector: { username: "SYN-RW-COLL", role: "cashier", patientScope: "all", grants: { "finance.payments.collect": true } },
  refunder: { username: "SYN-RW-REF", role: "accountant", patientScope: "all", grants: { "finance.payments.refund": true, "finance.payments.view": true } },
  viewer: { username: "SYN-RW-VIEW", role: "accountant", patientScope: "all", grants: {
    "finance.payments.view": true, "finance.invoices.view": true, "finance.patient-ledger.view": true } },
  label: { username: "SYN-RW-LABEL", role: "admin", patientScope: "all", grants: {} },
  doctor: { username: "SYN-RW-DR", role: "doctor", doctor: true, patientScope: "own", grants: { "finance.payments.collect": true } },
  other: { username: "SYN-RW-OTHER", role: "doctor", doctor: true, patientScope: "own", grants: {} },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let blockers: Pool;
let serial = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; reason?: string; message?: string }) => error);
const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };
const key = () => `syn-rw-${++serial}-key`;
const patient = async (doctor: number | null = null) => (await q(
  "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN RW patient',$2) RETURNING id", [`SYN-RW-${++serial}`, doctor]))[0].id as number;
const receipt = (patientId: number, amountMinor: number, idempotencyKey = key()) => ({
  kind: "payment" as const, patientId, invoiceId: null, planId: null, openingCurrency: null, amountMinor, currency: "YER" as const,
  method: "cash" as const, note: null, idempotencyKey, reversalOfId: null, similarityReview: { observedReceiptIds: [] } });
const refund = (patientId: number, reversalOfId: number, amountMinor: number, idempotencyKey = key()) => ({
  ...receipt(patientId, amountMinor, idempotencyKey), kind: "refund" as const, reversalOfId });
const paymentsOf = async (patientId: number) => q("SELECT id, kind, amount_minor::int AS amount, created_by, reversal_of_id FROM payments WHERE patient_id=$1 ORDER BY id", [patientId]);
const auditsOf = async (action: string, entityId: number) => q("SELECT actor FROM audit_log WHERE action=$1 AND entity_id=$2::text", [action, entityId]);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  blockers = new Pool({ connectionString: fx.pool.options.connectionString, ssl: false, max: 3 });
  await db.openShift({ openedBy: "SYN-RW-OWNER", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await blockers?.end(); await fx?.close(); });

describe("receipts", () => {
  it("finance.payments.collect records a receipt with its audit in the transaction; the same key replays with a replay audit", async () => {
    const p = await patient(), k = key();
    const made = await rc.commandCanonicalReceipt(await fx.session("collector"), receipt(p, 1310, k));
    const payment = made.payment as unknown as { id: number; amountMinor: number; createdBy: string };
    expect(made.replayed).toBe(false);
    expect(payment).toMatchObject({ amountMinor: 1310, createdBy: "SYN-RW-COLL" });
    expect(await auditsOf("payment.create", payment.id)).toEqual([{ actor: "SYN-RW-COLL" }]);
    const again = await rc.commandCanonicalReceipt(await fx.session("collector"), receipt(p, 1310, k));
    expect(again).toMatchObject({ replayed: true, payment: { id: payment.id } });
    expect(await paymentsOf(p)).toHaveLength(1);
    expect(await auditsOf("payment.idempotent_replay", payment.id)).toEqual([{ actor: "SYN-RW-COLL" }]);
    // The same key with a different amount is a conflict, and nothing changes.
    expect(await refusal(rc.commandCanonicalReceipt(await fx.session("collector"), receipt(p, 1320, k)))).toMatchObject({ reason: "idempotency_conflict" });
    expect(await paymentsOf(p)).toHaveLength(1);
  });

  it("the protected owner collects and refunds", async () => {
    const p = await patient(), owner = await fx.session("owner");
    const made = await rc.commandCanonicalReceipt(owner, receipt(p, 1410));
    const back = await rc.commandCanonicalReceipt(owner, refund(p, (made.payment as { id: number }).id, 410));
    expect(back.payment).toMatchObject({ kind: "refund", amountMinor: 410 });
  });

  it("the grant matrix: collect never refunds, refund never collects, view grants and labels reach neither; nothing is written", async () => {
    const p = await patient();
    const original = (await rc.commandCanonicalReceipt(await fx.session("collector"), receipt(p, 1510))).payment as { id: number };
    expect(await refusal(rc.commandCanonicalReceipt(await fx.session("collector"), refund(p, original.id, 100)))).toMatchObject(denied);
    expect(await refusal(rc.commandCanonicalReceipt(await fx.session("refunder"), receipt(p, 1520)))).toMatchObject(denied);
    for (const actor of ["viewer", "label", "other"] as const) {
      expect(await refusal(rc.commandCanonicalReceipt(await fx.session(actor), receipt(p, 1530)))).toMatchObject(denied);
      expect(await refusal(rc.commandCanonicalReceipt(await fx.session(actor), refund(p, original.id, 100)))).toMatchObject(denied);
    }
    expect((await paymentsOf(p)).map(row => row.amount)).toEqual([1510]);
  });

  it("a refund by finance.payments.refund stays within the receipt's remaining; an excess rolls back", async () => {
    const p = await patient();
    const original = (await rc.commandCanonicalReceipt(await fx.session("collector"), receipt(p, 1610))).payment as { id: number };
    const back = await rc.commandCanonicalReceipt(await fx.session("refunder"), refund(p, original.id, 610));
    const row = back.payment as unknown as { id: number; kind: string; reversalOfId: number; createdBy: string };
    expect(row).toMatchObject({ kind: "refund", reversalOfId: original.id, createdBy: "SYN-RW-REF" });
    expect(await auditsOf("payment.refund", row.id)).toEqual([{ actor: "SYN-RW-REF" }]);
    expect(await refusal(rc.commandCanonicalReceipt(await fx.session("refunder"), refund(p, original.id, 1001)))).toMatchObject({ reason: "reversal_exceeds_remaining" });
    expect((await paymentsOf(p)).map(r => r.amount)).toEqual([1610, 610]);
  });

  it("without an open shift the operation rolls back: no receipt, no audit", async () => {
    const p = await patient();
    const shift = (await db.getOpenShift())!;
    await db.closeShift({ id: shift.id, closedBy: "SYN-RW-OWNER", counted: shift.expected, note: null });
    try {
      expect(await refusal(rc.commandCanonicalReceipt(await fx.session("collector"), receipt(p, 1810)))).toMatchObject({ reason: "no_shift" });
      expect(await paymentsOf(p)).toEqual([]);
    } finally { await db.openShift({ openedBy: "SYN-RW-OWNER", opening: { YER: 0, SAR: 0, USD: 0 } }); }
  });
});

describe("scope", () => {
  it("an own collector collects for its patient; an outside patient reads like missing", async () => {
    const mine = await patient(fx.parties.doctor!), outside = await patient();
    expect((await rc.commandCanonicalReceipt(await fx.session("doctor"), receipt(mine, 1910))).payment).toMatchObject({ amountMinor: 1910 });
    expect(await refusal(rc.commandCanonicalReceipt(await fx.session("doctor"), receipt(outside, 1920)))).toMatchObject({ code: "patient_not_found", status: 404 });
    expect(await paymentsOf(outside)).toEqual([]);
  });

  it("refuses a patient that leaves the collector's scope while the writer waits for the shift", async () => {
    const p = await patient(fx.parties.doctor!), session = await fx.session("doctor");
    const blocker: PoolClient = await blockers.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [p]);
      await blocker.query("SELECT id FROM cashier_shifts WHERE status='open' FOR UPDATE");
      // The writer passes the early look (the change is not committed) and waits for the shift.
      pending = refusal(rc.commandCanonicalReceipt(session, receipt(p, 2010)));
      let waiting = false;
      for (let i = 0; i < 500 && !waiting; i++) {
        waiting = (await q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%cashier_shifts%'")).length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ code: "patient_not_found", status: 404 });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
    expect(await paymentsOf(p)).toEqual([]);
  });

  it("revocation: the collect grant withdrawn refuses at once", async () => {
    const p = await patient();
    await fx.setGrants("collector", {}, { patientScope: "all" });
    try {
      expect(await refusal(rc.commandCanonicalReceipt(await fx.session("collector"), receipt(p, 2110)))).toMatchObject(denied);
    } finally { await fx.setGrants("collector", { "finance.payments.collect": true }, { patientScope: "all" }); }
    expect(await paymentsOf(p)).toEqual([]);
  });
});
