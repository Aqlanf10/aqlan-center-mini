/** M2 slice 94d-1 (G4-1, G4-8; contract section 12): the plan's financial approval on the canonical
 * runtime, real PostgreSQL, synthetic data only. A new agreement by finance.invoices.create with its
 * approval invoice and audit, replayed by its key; matching an existing source also needs
 * finance.agreements.manage; view grants, collect alone and the label never approve; outside reads
 * like missing, decided after the patient row lock (race test); revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-financial-approval-secret-94d");
const db = await import("../../lib/db");
const plans = await import("../../lib/canonical-plan-writes");

const CREATE = { "finance.invoices.create": true, "finance.invoices.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-FA-OWNER", role: "admin" },
  approver: { username: "SYN-FA-APPR", role: "reception", patientScope: "all", grants: CREATE },
  manager: { username: "SYN-FA-MGR", role: "reception", patientScope: "all", grants: { ...CREATE, "finance.patient-ledger.view": true, "finance.agreements.manage": true } },
  viewer: { username: "SYN-FA-VIEW", role: "accountant", patientScope: "all", grants: { "finance.invoices.view": true, "finance.patient-ledger.view": true } },
  collector: { username: "SYN-FA-COLL", role: "cashier", patientScope: "all", grants: { "finance.payments.collect": true } },
  label: { username: "SYN-FA-LABEL", role: "admin", patientScope: "all", grants: {} },
  doctor: { username: "SYN-FA-DR", role: "doctor", doctor: true, patientScope: "own", grants: CREATE },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let blockers: Pool;
let serial = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; message?: string }) => error);
const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };
const key = () => `syn-fa-${++serial}-key`;
const patient = async (doctor: number | null = null) => (await q(
  "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN FA patient',$2) RETURNING id", [`SYN-FA-${++serial}`, doctor]))[0].id as number;
async function consentedPlan(patientId: number) {
  const made = await db.createPlanV2({ patientId, title: "SYN FA agreement", specialty: null, primaryDoctorId: null, billingMode: "installments",
    baseCurrency: "YER", startDate: "2026-10-01", note: null, createdBy: "SYN-FA-OWNER", items: [], installments: [{ dueDate: "2026-10-01", amountMinor: 9000 }] });
  if (!made.ok) throw new Error(made.message);
  await db.recordPlanConsent({ planId: made.planId, actor: "SYN-FA-OWNER", note: null });
  return made.planId;
}
const approval = (source: { kind: "new" } | { kind: "opening"; historicalPaidMinor: number } = { kind: "new" }, idempotencyKey = key()) =>
  ({ expectedTotalMinor: 9000, currency: "YER" as const, source, reason: "SYN approval", idempotencyKey });
const approvals = async (planId: number) => q("SELECT created_by FROM approved_agreement_principals WHERE plan_id=$1", [planId]);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  blockers = new Pool({ connectionString: fx.pool.options.connectionString, ssl: false, max: 3 });
}, 180_000);
afterAll(async () => { await blockers?.end(); await fx?.close(); });

describe("financial approval", () => {
  it("finance.invoices.create approves a new agreement with its invoice and audit; the key replays", async () => {
    const p = await consentedPlan(await patient()), session = await fx.session("approver"), k = key();
    expect(await plans.commandCanonicalFinancialApproval(session, p, approval({ kind: "new" }, k))).toEqual({ planId: p, replayed: false });
    expect(await approvals(p)).toEqual([{ created_by: "SYN-FA-APPR" }]);
    expect(await q("SELECT total_minor::int AS total, created_by FROM invoices WHERE plan_id=$1", [p])).toEqual([{ total: 9000, created_by: "SYN-FA-APPR" }]);
    expect((await q("SELECT actor FROM audit_log WHERE action='plan.financial_approval' AND entity_id=$1::text", [p])).map(row => row.actor)).toEqual(["SYN-FA-APPR"]);
    expect(await plans.commandCanonicalFinancialApproval(session, p, approval({ kind: "new" }, k))).toEqual({ planId: p, replayed: true });
    expect(await approvals(p)).toHaveLength(1);
  });

  it("matching an existing source needs finance.agreements.manage as well", async () => {
    const p = await consentedPlan(await patient());
    expect(await refusal(plans.commandCanonicalFinancialApproval(await fx.session("approver"), p, approval({ kind: "opening", historicalPaidMinor: 0 }))))
      .toMatchObject({ code: "agreement_source_not_granted", status: 403 });
    // With the grant, the writer itself decides the source (no opening balance here: refused by its own rule, not by the grant).
    const managed = await refusal(plans.commandCanonicalFinancialApproval(await fx.session("manager"), p, approval({ kind: "opening", historicalPaidMinor: 0 })));
    expect(managed).toMatchObject({ code: expect.any(String) });
    expect(managed?.code).not.toBe("agreement_source_not_granted");
    expect(managed?.message).not.toMatch(/CAPABILITY_DENIED/);
    expect(await approvals(p)).toEqual([]);
  });

  it("view grants, collect alone and the label never approve; outside reads like missing; revocation", async () => {
    const outside = await consentedPlan(await patient()), mine = await consentedPlan(await patient(fx.parties.doctor!));
    for (const key of ["viewer", "collector", "label"] as const) {
      expect(await refusal(plans.commandCanonicalFinancialApproval(await fx.session(key), outside, approval())), key).toMatchObject(denied);
    }
    const doctor = await fx.session("doctor");
    const outsideRefusal = await refusal(plans.commandCanonicalFinancialApproval(doctor, outside, approval()));
    const missingRefusal = await refusal(plans.commandCanonicalFinancialApproval(doctor, 2_000_000_000, approval()));
    expect(outsideRefusal).toMatchObject({ code: "plan_not_found", status: 404 });
    expect({ code: outsideRefusal?.code, message: outsideRefusal?.message }).toEqual({ code: missingRefusal?.code, message: missingRefusal?.message });
    expect(await plans.commandCanonicalFinancialApproval(doctor, mine, approval())).toMatchObject({ replayed: false });
    await fx.setGrants("approver", {}, { patientScope: "all" });
    try { expect(await refusal(plans.commandCanonicalFinancialApproval(await fx.session("approver"), outside, approval()))).toMatchObject(denied); }
    finally { await fx.setGrants("approver", CREATE, { patientScope: "all" }); }
    expect(await approvals(outside)).toEqual([]);
  });

  it("refuses a patient that leaves the clinician's scope while the approval waits for the patient row", async () => {
    const pid = await patient(fx.parties.doctor!), p = await consentedPlan(pid), session = await fx.session("doctor");
    const blocker: PoolClient = await blockers.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [pid]);
      pending = refusal(plans.commandCanonicalFinancialApproval(session, p, approval()));
      let waiting = false;
      for (let i = 0; i < 500 && !waiting; i++) {
        waiting = (await q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM patients WHERE id=$1 FOR NO KEY UPDATE%'")).length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ code: "plan_not_found", status: 404 });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
    expect(await approvals(p)).toEqual([]);
  });
});
