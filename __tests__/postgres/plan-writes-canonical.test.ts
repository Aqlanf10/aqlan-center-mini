/** M2 slice 94b (G4-4, G4-8; contract section 10): plan status, the creation entry and the
 * collection on a plan on the canonical runtime, real PostgreSQL, synthetic data only. Status by
 * clinical.plans.edit with the legacy reason rule and audit; the creation entry admitted and
 * scoped, then refused as legacy; the collection by finance.payments.collect on the legacy
 * writers (the instalment with its invoice, the approved agreement's collection). View grants,
 * the other write grant and the label never act; outside reads like missing, decided after the
 * plan row lock (race test); revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-plan-writes-secret-94b");
const db = await import("../../lib/db");
const debt = await import("../../lib/debt-installments-db");
const agreements = await import("../../lib/approved-agreements");
const plans = await import("../../lib/canonical-plan-writes");

const EDIT = { "clinical.plans.edit": true, "clinical.plans.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-PW-OWNER", role: "admin" },
  editor: { username: "SYN-PW-EDIT", role: "reception", patientScope: "all", grants: EDIT },
  collector: { username: "SYN-PW-COLL", role: "cashier", patientScope: "all", grants: { "finance.payments.collect": true } },
  viewer: { username: "SYN-PW-VIEW", role: "accountant", patientScope: "all", grants: {
    "clinical.plans.view": true, "finance.invoices.view": true, "finance.patient-ledger.view": true, "finance.payments.view": true } },
  label: { username: "SYN-PW-LABEL", role: "admin", patientScope: "all", grants: {} },
  doctor: { username: "SYN-PW-DR", role: "doctor", doctor: true, patientScope: "own", grants: { ...EDIT, "finance.payments.collect": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let blockers: Pool;
let manager: ReturnType<typeof debt.canonicalDebtActor>;
let serial = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; reason?: string; message?: string }) => error);
const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };
const key = () => `syn-pw-${++serial}-key`;
const patient = async (doctor: number | null = null) => (await q(
  "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN PW patient',$2) RETURNING id", [`SYN-PW-${++serial}`, doctor]))[0].id as number;
async function instalmentPlan(patientId: number, amount = 5000) {
  const planId = (await q(`INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, billing_mode, start_date)
    VALUES ($1, 'SYN PW instalments', $2, 'YER', 'active', 'installments', '2026-01-01') RETURNING id`, [patientId, amount * 2]))[0].id as number;
  await q("INSERT INTO plan_installments (plan_id, number, due_date, amount_minor) VALUES ($1, 1, '2026-01-01', $2), ($1, 2, '2026-02-01', $2)", [planId, amount]);
  return planId;
}
const collection = (amountMinor: number, idempotencyKey = key()) => ({ amountMinor, currency: "YER" as const, method: "cash" as const, note: null,
  idempotencyKey, similarityReview: { observedReceiptIds: [] } });
const statusOf = async (planId: number) => (await q("SELECT status FROM treatment_plans WHERE id=$1", [planId]))[0].status as string;
const statusAudits = async (planId: number) => q("SELECT actor, details->>'إلى' AS target FROM audit_log WHERE action='plan.status' AND entity_id=$1::text ORDER BY id", [planId]);
const paymentsOf = async (patientId: number) => q("SELECT id, created_by FROM payments WHERE patient_id=$1 ORDER BY id", [patientId]);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  blockers = new Pool({ connectionString: fx.pool.options.connectionString, ssl: false, max: 3 });
  await db.openShift({ openedBy: "SYN-PW-OWNER", opening: { YER: 0, SAR: 0, USD: 0 } });
  // Setup only: the agreement approval (not part of this slice) by a branded actor for the owner.
  manager = debt.canonicalDebtActor({ userId: fx.ids.owner, username: "SYN-PW-OWNER", role: "admin" }, async () => true);
}, 180_000);
afterAll(async () => { await blockers?.end(); await fx?.close(); });

describe("plan status", () => {
  it("clinical.plans.edit changes it with its audit; cancelling and reviving need a reason; an unchanged status writes nothing", async () => {
    const plan = await instalmentPlan(await patient()), session = await fx.session("editor");
    expect(await plans.commandCanonicalPlanStatus(session, plan, "completed", null)).toEqual({ ok: true });
    expect(await refusal(plans.commandCanonicalPlanStatus(session, plan, "cancelled", null))).toMatchObject({ code: "reason_required", status: 400 });
    expect(await plans.commandCanonicalPlanStatus(session, plan, "cancelled", "SYN stopped")).toEqual({ ok: true });
    expect(await refusal(plans.commandCanonicalPlanStatus(session, plan, "active", "no"))).toMatchObject({ code: "reason_required" });
    expect(await plans.commandCanonicalPlanStatus(session, plan, "cancelled", null)).toEqual({ ok: true });
    expect(await statusOf(plan)).toBe("cancelled");
    expect(await statusAudits(plan)).toEqual([{ actor: "SYN-PW-EDIT", target: "completed" }, { actor: "SYN-PW-EDIT", target: "cancelled" }]);
  });

  it("view grants, the collect grant and the label never change it; outside reads like a missing plan; revocation", async () => {
    const outside = await instalmentPlan(await patient()), mine = await instalmentPlan(await patient(fx.parties.doctor!));
    for (const key of ["viewer", "collector", "label"] as const) {
      expect(await refusal(plans.commandCanonicalPlanStatus(await fx.session(key), outside, "completed", null)), key).toMatchObject(denied);
    }
    const doctor = await fx.session("doctor");
    const outsideRefusal = await refusal(plans.commandCanonicalPlanStatus(doctor, outside, "completed", null));
    const missingRefusal = await refusal(plans.commandCanonicalPlanStatus(doctor, 2_000_000_000, "completed", null));
    expect(outsideRefusal).toMatchObject({ code: "plan_not_found", status: 404 });
    expect({ code: outsideRefusal?.code, message: outsideRefusal?.message }).toEqual({ code: missingRefusal?.code, message: missingRefusal?.message });
    expect(await plans.commandCanonicalPlanStatus(doctor, mine, "completed", null)).toEqual({ ok: true });
    await fx.setGrants("editor", {}, { patientScope: "all" });
    try { expect(await refusal(plans.commandCanonicalPlanStatus(await fx.session("editor"), outside, "completed", null))).toMatchObject(denied); }
    finally { await fx.setGrants("editor", EDIT, { patientScope: "all" }); }
    expect(await statusOf(outside)).toBe("active");
  });

  it("refuses a patient that leaves the clinician's scope while the change waits for the plan row", async () => {
    const p = await patient(fx.parties.doctor!), plan = await instalmentPlan(p), session = await fx.session("doctor");
    const blocker: PoolClient = await blockers.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE treatment_plans SET note='SYN held' WHERE id=$1", [plan]);
      await blocker.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [p]);
      pending = refusal(plans.commandCanonicalPlanStatus(session, plan, "completed", null));
      let waiting = false;
      for (let i = 0; i < 500 && !waiting; i++) {
        waiting = (await q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM treatment_plans WHERE id = $1 FOR UPDATE%'")).length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ code: "plan_not_found", status: 404 });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
    expect(await statusOf(plan)).toBe("active");
    expect(await statusAudits(plan)).toEqual([]);
  });
});

describe("the creation entry", () => {
  it("admitted and scoped, then refused as legacy; outside or missing reads like a missing patient; view grants refused", async () => {
    const mine = await patient(fx.parties.doctor!), outside = await patient();
    for (const [key, id] of [["editor", outside], ["doctor", mine]] as const) {
      expect(await refusal(plans.commandCanonicalPlanCreateEntry(await fx.session(key), id)), key).toMatchObject({ code: "PLAN_CREATION_ENTRY_REQUIRED", status: 409 });
    }
    expect(await refusal(plans.commandCanonicalPlanCreateEntry(await fx.session("doctor"), outside))).toMatchObject({ code: "patient_not_found", status: 404 });
    expect(await refusal(plans.commandCanonicalPlanCreateEntry(await fx.session("editor"), 2_000_000_000))).toMatchObject({ code: "patient_not_found", status: 404 });
    for (const key of ["viewer", "collector", "label"] as const) {
      expect(await refusal(plans.commandCanonicalPlanCreateEntry(await fx.session(key), outside)), key).toMatchObject(denied);
    }
    expect(await q("SELECT id FROM treatment_plans WHERE patient_id = ANY($1::int[])", [[mine, outside]])).toEqual([]);
  });
});

describe("the collection on a plan", () => {
  it("finance.payments.collect records the next instalment with its invoice and audit; the key replays; an inactive plan is refused", async () => {
    const p = await patient(), plan = await instalmentPlan(p), k = key(), session = await fx.session("collector");
    const made = await plans.commandCanonicalPlanCollection(session, plan, collection(5000, k));
    expect(made).toMatchObject({ kind: "installment", body: { invoiceId: expect.any(Number), paymentId: expect.any(Number) } });
    const body = made.body as { invoiceId: number; paymentId: number; replayed?: boolean };
    expect(body.replayed ?? false).toBe(false);
    expect((await q("SELECT plan_id, status FROM invoices WHERE id=$1", [body.invoiceId]))[0]).toEqual({ plan_id: plan, status: "paid" });
    expect((await q("SELECT actor FROM audit_log WHERE action='payment.create' AND entity_id=$1::text", [body.paymentId])).map(row => row.actor)).toEqual(["SYN-PW-COLL"]);
    expect(await plans.commandCanonicalPlanCollection(session, plan, collection(5000, k))).toMatchObject({ body: { paymentId: body.paymentId, replayed: true } });
    await q("UPDATE treatment_plans SET status='completed' WHERE id=$1", [plan]);
    expect(await refusal(plans.commandCanonicalPlanCollection(session, plan, collection(5000)))).toMatchObject({ reason: "inactive_plan", planCurrency: "YER" });
    expect(await paymentsOf(p)).toEqual([{ id: body.paymentId, created_by: "SYN-PW-COLL" }]);
  });

  it("an approved agreement is collected by the canonical actor, with the agreement's invoice", async () => {
    const p = await patient();
    const made = await db.createPlanV2({ patientId: p, title: "SYN PW agreement", specialty: null, primaryDoctorId: null, billingMode: "installments",
      baseCurrency: "YER", startDate: "2026-10-01", note: null, createdBy: "SYN-PW-OWNER", items: [], installments: [{ dueDate: "2026-10-01", amountMinor: 9000 }] });
    if (!made.ok) throw new Error(made.message);
    await db.recordPlanConsent({ planId: made.planId, actor: "SYN-PW-OWNER", note: null });
    await agreements.approveAgreement({ planId: made.planId, expectedTotalMinor: 9000, currency: "YER", source: { kind: "new" },
      reason: "SYN approval", idempotencyKey: key(), session: manager as never });
    const result = await plans.commandCanonicalPlanCollection(await fx.session("collector"), made.planId, collection(4000));
    expect(result).toMatchObject({ kind: "approved", body: { payment: { createdBy: "SYN-PW-COLL", amountMinor: 4000 }, invoiceId: expect.any(Number) } });
    expect(await db.getPlan(made.planId, "2026-10-19")).toMatchObject({ approvedAgreement: { paidMinor: 4000, remainingMinor: 5000 } });
  });

  it("clinical.plans.edit, view grants and the label never collect; outside reads like a missing plan; revocation", async () => {
    const p = await patient(), plan = await instalmentPlan(p);
    for (const key of ["editor", "viewer", "label"] as const) {
      expect(await refusal(plans.commandCanonicalPlanCollection(await fx.session(key), plan, collection(5000))), key).toMatchObject(denied);
    }
    expect(await refusal(plans.commandCanonicalPlanCollection(await fx.session("doctor"), plan, collection(5000)))).toMatchObject({ code: "plan_not_found", status: 404 });
    await fx.setGrants("collector", {}, { patientScope: "all" });
    try { expect(await refusal(plans.commandCanonicalPlanCollection(await fx.session("collector"), plan, collection(5000)))).toMatchObject(denied); }
    finally { await fx.setGrants("collector", { "finance.payments.collect": true }, { patientScope: "all" }); }
    expect(await paymentsOf(p)).toEqual([]);
  });
});
