/** M2 slice 90c (G4-4): collections on agreement-funded plans and the reversed-instalment
 * recovery on the canonical runtime, real PostgreSQL, synthetic data only. Each is served by
 * its legacy writer under finance.payments.collect inside the patient scope: the next
 * instalment with its invoice, the approved agreement's collection (a branded canonical actor
 * where the legacy writer revalidated its session), the recovery on the original invoice.
 * View and refund grants never collect; outside reads like missing, decided after the
 * writer's waits; revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { REVERSED_INSTALLMENT_RECOVERY_PURPOSE as PURPOSE } from "../../lib/reversed-installment-recovery";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-plan-collections-secret-90c");
const db = await import("../../lib/db");
const debt = await import("../../lib/debt-installments-db");
const rc = await import("../../lib/canonical-receipt-writes");
const agreements = await import("../../lib/approved-agreements");

const ACCOUNTS = {
  owner: { username: "SYN-PC-OWNER", role: "admin" },
  collector: { username: "SYN-PC-COLL", role: "cashier", patientScope: "all", grants: { "finance.payments.collect": true } },
  viewer: { username: "SYN-PC-VIEW", role: "accountant", patientScope: "all", grants: {
    "finance.payments.view": true, "finance.invoices.view": true, "finance.patient-ledger.view": true, "finance.payments.refund": true } },
  doctor: { username: "SYN-PC-DR", role: "doctor", doctor: true, patientScope: "own", grants: { "finance.payments.collect": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let blockers: Pool;
let manager: ReturnType<typeof debt.canonicalDebtActor>;
let serial = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; reason?: string; message?: string }) => error);
const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };
const key = () => `syn-pc-${++serial}-key`;
const patient = async (doctor: number | null = null) => (await q(
  "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN PC patient',$2) RETURNING id", [`SYN-PC-${++serial}`, doctor]))[0].id as number;
const receipt = (patientId: number, planId: number | null, amountMinor: number, idempotencyKey = key()) => ({
  kind: "payment" as const, patientId, invoiceId: null, planId, openingCurrency: null, amountMinor, currency: "YER" as const,
  method: "cash" as const, note: null, idempotencyKey, reversalOfId: null, similarityReview: { observedReceiptIds: [] } });
const paymentsOf = async (patientId: number) => q("SELECT id, kind, amount_minor::int AS amount, invoice_id, plan_id, created_by FROM payments WHERE patient_id=$1 ORDER BY id", [patientId]);
const auditActors = async (action: string, entityId: number) => (await q("SELECT actor FROM audit_log WHERE action=$1 AND entity_id=$2::text", [action, entityId])).map(row => row.actor);

/** A classic instalment plan (no approved agreement): two instalments of `amount`. */
async function instalmentPlan(patientId: number, amount = 5000) {
  const planId = (await q(`INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, billing_mode, start_date)
    VALUES ($1, 'SYN PC instalments', $2, 'YER', 'active', 'installments', '2026-01-01') RETURNING id`, [patientId, amount * 2]))[0].id as number;
  await q("INSERT INTO plan_installments (plan_id, number, due_date, amount_minor) VALUES ($1, 1, '2026-01-01', $2), ($1, 2, '2026-02-01', $2)", [planId, amount]);
  return planId;
}

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  blockers = new Pool({ connectionString: fx.pool.options.connectionString, ssl: false, max: 3 });
  await db.openShift({ openedBy: "SYN-PC-OWNER", opening: { YER: 0, SAR: 0, USD: 0 } });
  // Setup only: the agreement approval (not part of this slice) by a branded actor for the owner;
  // legacy staff accounts are disabled on the canonical database.
  manager = debt.canonicalDebtActor({ userId: fx.ids.owner, username: "SYN-PC-OWNER", role: "admin" }, async () => true);
}, 180_000);
afterAll(async () => { await blockers?.end(); await fx?.close(); });

describe("an instalment plan", () => {
  it("a receipt on it is the next instalment with its invoice, audited in the transaction; the key replays", async () => {
    const p = await patient(), plan = await instalmentPlan(p), k = key();
    const made = await rc.commandCanonicalReceipt(await fx.session("collector"), receipt(p, plan, 5000, k));
    const payment = made.payment as unknown as { id: number; invoiceId: number; planId: number; createdBy: string };
    expect(made.replayed).toBe(false);
    expect(payment).toMatchObject({ planId: plan, createdBy: "SYN-PC-COLL", invoiceId: expect.any(Number) });
    expect((await q("SELECT plan_id, status FROM invoices WHERE id=$1", [payment.invoiceId]))[0]).toEqual({ plan_id: plan, status: "paid" });
    expect(await auditActors("payment.create", payment.id)).toEqual(["SYN-PC-COLL"]);
    expect(await rc.commandCanonicalReceipt(await fx.session("collector"), receipt(p, plan, 5000, k))).toMatchObject({ replayed: true, payment: { id: payment.id } });
    expect(await paymentsOf(p)).toHaveLength(1);
  });

  it("an inactive plan is refused with the instalment reason, and nothing is written", async () => {
    const p = await patient(), plan = await instalmentPlan(p);
    await q("UPDATE treatment_plans SET status='completed' WHERE id=$1", [plan]);
    expect(await refusal(rc.commandCanonicalReceipt(await fx.session("collector"), receipt(p, plan, 5000))))
      .toMatchObject({ reason: "inactive_plan", path: "installment" });
    expect(await paymentsOf(p)).toEqual([]);
  });

  it("view and refund grants never collect; an outside patient reads like missing; revocation", async () => {
    const p = await patient(), plan = await instalmentPlan(p);
    expect(await refusal(rc.commandCanonicalReceipt(await fx.session("viewer"), receipt(p, plan, 5000)))).toMatchObject(denied);
    expect(await refusal(rc.commandCanonicalReceipt(await fx.session("doctor"), receipt(p, plan, 5000)))).toMatchObject({ code: "patient_not_found", status: 404 });
    await fx.setGrants("collector", {}, { patientScope: "all" });
    try { expect(await refusal(rc.commandCanonicalReceipt(await fx.session("collector"), receipt(p, plan, 5000)))).toMatchObject(denied); }
    finally { await fx.setGrants("collector", { "finance.payments.collect": true }, { patientScope: "all" }); }
    expect(await paymentsOf(p)).toEqual([]);
  });

  it("refuses a patient that leaves the collector's scope while the instalment writer waits for the shift", async () => {
    const p = await patient(fx.parties.doctor!), plan = await instalmentPlan(p), session = await fx.session("doctor");
    const blocker: PoolClient = await blockers.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [p]);
      await blocker.query("SELECT id FROM cashier_shifts WHERE status='open' FOR UPDATE");
      pending = refusal(rc.commandCanonicalReceipt(session, receipt(p, plan, 5000)));
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
    expect((await q("SELECT count(*)::int AS n FROM invoices WHERE plan_id=$1", [plan]))[0].n).toBe(0);
  });
});

describe("an approved agreement", () => {
  async function approved(patientId: number) {
    const made = await db.createPlanV2({ patientId, title: "SYN PC agreement", specialty: null, primaryDoctorId: null, billingMode: "installments",
      baseCurrency: "YER", startDate: "2026-10-01", note: null, createdBy: "SYN-PC-OWNER", items: [], installments: [{ dueDate: "2026-10-01", amountMinor: 9000 }] });
    if (!made.ok) throw new Error(made.message);
    await db.recordPlanConsent({ planId: made.planId, actor: "SYN-PC-OWNER", note: null });
    await agreements.approveAgreement({ planId: made.planId, expectedTotalMinor: 9000, currency: "YER", source: { kind: "new" },
      reason: "SYN approval", idempotencyKey: key(), session: manager as never });
    return made.planId;
  }

  it("a receipt on it is the agreement's collection by the canonical actor, audited in the transaction", async () => {
    const p = await patient(), plan = await approved(p), k = key();
    const made = await rc.commandCanonicalReceipt(await fx.session("collector"), receipt(p, plan, 4000, k));
    const payment = made.payment as unknown as { id: number; createdBy: string; amountMinor: number };
    expect(payment).toMatchObject({ createdBy: "SYN-PC-COLL", amountMinor: 4000 });
    expect(await auditActors("plan.approved_collection", payment.id)).toEqual(["SYN-PC-COLL"]);
    expect(await db.getPlan(plan, "2026-10-19")).toMatchObject({ approvedAgreement: { paidMinor: 4000, remainingMinor: 5000 } });
    expect(await rc.commandCanonicalReceipt(await fx.session("collector"), receipt(p, plan, 4000, k))).toMatchObject({ replayed: true, payment: { id: payment.id } });
    expect(await paymentsOf(p)).toHaveLength(1);
  });

  it("refused to view grants and outside the scope; an excess rolls back", async () => {
    const p = await patient(), plan = await approved(p);
    expect(await refusal(rc.commandCanonicalReceipt(await fx.session("viewer"), receipt(p, plan, 1000)))).toMatchObject(denied);
    expect(await refusal(rc.commandCanonicalReceipt(await fx.session("doctor"), receipt(p, plan, 1000)))).toMatchObject({ code: "patient_not_found", status: 404 });
    expect(await refusal(rc.commandCanonicalReceipt(await fx.session("collector"), receipt(p, plan, 9001)))).toMatchObject({ code: expect.any(String), message: expect.stringContaining("يتجاوز") });
    expect(await paymentsOf(p)).toEqual([]);
  });
});

describe("the reversed-instalment recovery", () => {
  async function reversed(doctor: number | null = null) {
    const p = await patient(doctor), plan = await instalmentPlan(p, 3000);
    const made = await db.recordPlanInstallment({ patientId: p, planId: plan, installmentNumber: 1, planTitle: "SYN PC instalments", amountMinor: 3000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null, createdBy: "SYN-PC-OWNER", actorRole: "admin", idempotencyKey: key() });
    if (!("paymentId" in made)) throw new Error(`instalment refused: ${made.reason}`);
    const back = await db.recordPayment({ patientId: p, invoiceId: null, kind: "refund", amountMinor: 3000, currency: "YER", baseCurrency: "YER",
      exchangeRate: 1, method: "cash", note: "SYN reversal", createdBy: "SYN-PC-OWNER", reversalOfId: made.paymentId });
    if (back.reason !== null) throw new Error(`refund refused: ${back.reason}`);
    return { patientId: p, invoiceId: made.invoiceId };
  }
  const intent = (target: { patientId: number; invoiceId: number }, amountMinor = 3000) => ({ purpose: PURPOSE, patientId: target.patientId,
    invoiceId: target.invoiceId, amountMinor, currency: "YER" as const, method: "cash" as const, note: null });

  it("recovers on the original invoice with its audit; the key replays", async () => {
    const target = await reversed(), k = key();
    const made = await rc.commandCanonicalRecovery(await fx.session("collector"), intent(target), k, { observedReceiptIds: [] });
    expect(made.payment).toMatchObject({ invoiceId: target.invoiceId, createdBy: "SYN-PC-COLL", amountMinor: 3000 });
    expect(await auditActors("payment.recover_installment", made.payment.id)).toEqual(["SYN-PC-COLL"]);
    expect(await rc.commandCanonicalRecovery(await fx.session("collector"), intent(target), k, { observedReceiptIds: [] })).toMatchObject({ replayed: true, payment: { id: made.payment.id } });
  });

  it("an excess is the recovery reason; view grants and outside actors are refused; nothing is written", async () => {
    const target = await reversed(), before = (await paymentsOf(target.patientId)).length;
    expect(await refusal(rc.commandCanonicalRecovery(await fx.session("collector"), intent(target, 3001), key(), { observedReceiptIds: [] })))
      .toMatchObject({ reason: "recovery_exceeds_remaining", path: "recovery" });
    expect(await refusal(rc.commandCanonicalRecovery(await fx.session("viewer"), intent(target), key(), { observedReceiptIds: [] }))).toMatchObject(denied);
    expect(await refusal(rc.commandCanonicalRecovery(await fx.session("doctor"), intent(target), key(), { observedReceiptIds: [] })))
      .toMatchObject({ code: "patient_not_found", status: 404 });
    expect(await paymentsOf(target.patientId)).toHaveLength(before);
  });
});
