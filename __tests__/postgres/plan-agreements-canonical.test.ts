/** M2 slice 94d-2 (G4-1, G4-8; contract section 13): the agreement amendment and the agreement
 * reconciliation on the canonical runtime, real PostgreSQL, synthetic data only.
 * finance.agreements.manage on all six methods; the stale rejection committed and reported;
 * other finance grants and the label never amend or reconcile; outside reads like missing,
 * decided after the patient row lock (race test); revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-plan-agreements-secret-94d2");
const db = await import("../../lib/db");
const plans = await import("../../lib/canonical-plan-writes");
const agreements = await import("../../lib/canonical-plan-agreements");
const { applyRuntimeMigrationFiles, loadMigrationFiles } = await import("../../lib/migrations");

const MANAGE = { "finance.agreements.manage": true, "finance.patient-ledger.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-AG-OWNER", role: "admin" },
  manager: { username: "SYN-AG-MGR", role: "reception", patientScope: "all", grants: MANAGE },
  creator: { username: "SYN-AG-CREATE", role: "reception", patientScope: "all", grants: { "finance.invoices.create": true, "finance.invoices.view": true } },
  ledger: { username: "SYN-AG-LEDGER", role: "accountant", patientScope: "all", grants: { "finance.patient-ledger.view": true, "finance.invoices.view": true } },
  collector: { username: "SYN-AG-COLL", role: "cashier", patientScope: "all", grants: { "finance.payments.collect": true } },
  label: { username: "SYN-AG-LABEL", role: "admin", patientScope: "all", grants: {} },
  doctor: { username: "SYN-AG-DR", role: "doctor", doctor: true, patientScope: "own", grants: MANAGE },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let blockers: Pool;
let serial = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; message?: string; name?: string }) => error);
const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };
const reason = "SYN documented upgrade";

async function patient(doctor: number | null = null) {
  return (await q("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN AG patient',$2) RETURNING id", [`SYN-AG-${++serial}`, doctor]))[0].id as number;
}
/** An approved single-item agreement with its approval invoice (the amendment's source). */
async function approvedPlan(patientId: number) {
  const n = ++serial;
  const [oldService] = await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES ($1,50000,TRUE,TRUE,'prostho') RETURNING id", [`SYN AG old ${n}`]);
  const [newService] = await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES ($1,80000,TRUE,TRUE,'prostho') RETURNING id", [`SYN AG new ${n}`]);
  const made = await db.createPlanV2({ patientId, title: "SYN AG agreement", specialty: null, primaryDoctorId: null, billingMode: "installments", baseCurrency: "YER",
    startDate: "2026-10-01", note: null, createdBy: "SYN-AG-OWNER", items: [], installments: [{ dueDate: "2026-10-01", amountMinor: 100000 }] });
  if (!made.ok) throw new Error(made.message);
  await q("INSERT INTO plan_items(plan_id,service_id,service_name,quantity,unit_price_minor,billing_rule,session_count) VALUES ($1,$2,'SYN crowns',2,50000,'once',1)", [made.planId, oldService.id]);
  await db.recordPlanConsent({ planId: made.planId, actor: "SYN-AG-OWNER", note: null });
  await plans.commandCanonicalFinancialApproval(await fx.session("owner"), made.planId,
    { expectedTotalMinor: 100000, currency: "YER", source: { kind: "new" }, reason: "SYN approval", idempotencyKey: `syn-ag-approve-${n}` });
  return { planId: made.planId, newServiceId: newService.id as number };
}
/** A completed classic instalment agreement (the reconciliation's source). */
async function classicPlan(patientId: number) {
  const n = ++serial;
  const [doctor] = await q("INSERT INTO parties(name,kind,commission_percent) VALUES ($1,'doctor',30) RETURNING id", [`SYN AG doctor ${n}`]);
  await q("INSERT INTO doctor_commission_history(party_id,percent,config,effective_from,source,reason,recorded_by) VALUES ($1,30,NULL,'2020-01-01','baseline','SYN policy','SYN-AG-OWNER')", [doctor.id]);
  const made = await db.createPlanV2({ patientId, title: "SYN AG classic", specialty: null, primaryDoctorId: doctor.id, billingMode: "installments", baseCurrency: "YER",
    startDate: "2026-10-01", note: null, createdBy: "SYN-AG-OWNER", items: [], installments: [{ dueDate: "2026-10-01", amountMinor: 12000 }, { dueDate: "2026-11-01", amountMinor: 168000 }] });
  if (!made.ok) throw new Error(made.message);
  await db.recordPlanConsent({ planId: made.planId, actor: "SYN-AG-OWNER", note: null });
  const paid = await db.recordPlanInstallment({ planId: made.planId, patientId, installmentNumber: 1, planTitle: "SYN AG classic", amountMinor: 12000, currency: "YER", baseCurrency: "YER",
    exchangeRate: 1, method: "cash", note: null, createdBy: "SYN-AG-OWNER", actorRole: "admin", idempotencyKey: `syn-ag-recon-${n}` });
  if ("reason" in paid) throw new Error(paid.reason);
  await q("UPDATE treatment_plans SET status='completed' WHERE id=$1", [made.planId]);
  return made.planId;
}
const amendment = (planId: number, sourceHash: string, newServiceId: number, key = `syn-ag-amend-${++serial}`) =>
  ({ idempotencyKey: key, expectedSourceHash: sourceHash, newServiceId, newUnitMinor: 80000, reason });
const reconcile = (sourceHash: string, key = `syn-ag-recon-key-${++serial}`) => ({ operationKey: key, expectedSourceHash: sourceHash, reason: "SYN reconciliation" });
const STALE = "a".repeat(64);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  blockers = new Pool({ connectionString: fx.pool.options.connectionString, ssl: false, max: 3 });
  if (!(await q("SELECT to_regclass('public.agreement_delta_amendments') IS NOT NULL AS present"))[0].present) {
    await applyRuntimeMigrationFiles(fx.pool, (await loadMigrationFiles()).filter(file => file.version === "0066"));
  }
  await db.openShift({ openedBy: "SYN-AG-OWNER", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await blockers?.end(); await fx?.close(); });

describe("agreement amendment and reconciliation", () => {
  it("amends by finance.agreements.manage: preview, delta invoice and audit, replay, status; a stale source commits its rejection", async () => {
    const { planId, newServiceId } = await approvedPlan(await patient()), session = await fx.session("manager");
    const view = await agreements.readCanonicalAgreementAmendment(session, planId);
    expect(view).toMatchObject({ planId, previousAgreementMinor: 100000 });
    const input = amendment(planId, view.sourceHash, newServiceId);
    const saved = await agreements.commandCanonicalAgreementAmendment(session, planId, input);
    expect(saved).toMatchObject({ replayed: false, previousAgreementMinor: 100000, deltaMinor: 60000, revisedAgreementMinor: 160000, cashMovementMinor: 0 });
    expect(await q("SELECT total_minor::int AS total, created_by FROM invoices WHERE id=$1", [saved.deltaInvoiceId])).toEqual([{ total: 60000, created_by: "SYN-AG-MGR" }]);
    expect((await q("SELECT actor FROM audit_log WHERE action='plan.agreement_delta_amendment' AND entity_id=$1::text", [planId])).map(row => row.actor)).toEqual(["SYN-AG-MGR"]);
    expect(await agreements.commandCanonicalAgreementAmendment(session, planId, input)).toEqual({ ...saved, replayed: true });
    expect(await agreements.readCanonicalAgreementAmendmentStatus(session, planId, input)).toMatchObject({ state: "committed" });
    // Stale: the rejection proof commits, then the refusal; the status reports it; the same key stays refused.
    const stale = amendment(planId, STALE, newServiceId);
    expect(await refusal(agreements.commandCanonicalAgreementAmendment(session, planId, stale))).toMatchObject({ name: "CanonicalAgreementStale", code: "stale" });
    expect(await q("SELECT plan_id FROM agreement_delta_attempt_rejections WHERE idempotency_key=$1", [stale.idempotencyKey])).toEqual([{ plan_id: planId }]);
    expect(await agreements.readCanonicalAgreementAmendmentStatus(session, planId, stale)).toMatchObject({ state: "rejected_stale" });
    expect(await refusal(agreements.commandCanonicalAgreementAmendment(session, planId, stale))).toMatchObject({ code: "stale" });
    expect(await q("SELECT id FROM agreement_delta_amendments WHERE plan_id=$1", [planId])).toHaveLength(1);
  });

  it("reconciles by finance.agreements.manage: preview, receipt, replay, status; a stale source commits its rejection", async () => {
    const planId = await classicPlan(await patient()), session = await fx.session("manager");
    const view = await agreements.readCanonicalAgreementReconciliation(session, planId);
    expect(view).toMatchObject({ status: "preview", canConfirm: true, amounts: { agreedMinor: 180000, unbilledPrincipalMinor: 168000 } });
    const command = reconcile(view.sourceHash);
    const saved = await agreements.commandCanonicalAgreementReconciliation(session, planId, command);
    expect(saved).toMatchObject({ status: "reconciled", replayed: false, reconciliation: { planId, cashMovementMinor: 0 } });
    expect((await q("SELECT actor FROM audit_log WHERE action='plan.agreement_reconciliation' AND entity_id=$1::text", [planId])).map(row => row.actor)).toEqual(["SYN-AG-MGR"]);
    expect(await agreements.commandCanonicalAgreementReconciliation(session, planId, command)).toMatchObject({ replayed: true, reconciliation: saved.reconciliation });
    expect(await agreements.readCanonicalAgreementReconciliationStatus(session, planId, command)).toMatchObject({ state: "committed" });
    const other = await classicPlan(await patient()), stale = reconcile(STALE);
    expect(await refusal(agreements.commandCanonicalAgreementReconciliation(session, other, stale))).toMatchObject({ name: "CanonicalAgreementStale", code: "agreement_source_changed" });
    expect(await q("SELECT plan_id FROM agreement_reconciliation_rejections WHERE operation_key=$1", [stale.operationKey])).toEqual([{ plan_id: other }]);
    expect(await agreements.readCanonicalAgreementReconciliationStatus(session, other, stale)).toMatchObject({ state: "rejected" });
    expect(await q("SELECT id FROM agreement_reconciliations WHERE plan_id=$1", [other])).toEqual([]);
  });

  it("other finance grants and the label never amend or reconcile; outside reads like missing; revocation", async () => {
    const { planId: amendPlan, newServiceId } = await approvedPlan(await patient()), reconPlan = await classicPlan(await patient());
    const owner = await fx.session("owner");
    const hash = (await agreements.readCanonicalAgreementAmendment(owner, amendPlan)).sourceHash;
    const reconHash = (await agreements.readCanonicalAgreementReconciliation(owner, reconPlan)).sourceHash;
    const six = (session: Awaited<ReturnType<typeof fx.session>>, amend: number, recon: number): (() => Promise<unknown>)[] => [
      () => agreements.readCanonicalAgreementAmendment(session, amend),
      () => agreements.commandCanonicalAgreementAmendment(session, amend, amendment(amend, hash, newServiceId)),
      () => agreements.readCanonicalAgreementAmendmentStatus(session, amend, amendment(amend, hash, newServiceId)),
      () => agreements.readCanonicalAgreementReconciliation(session, recon),
      () => agreements.commandCanonicalAgreementReconciliation(session, recon, reconcile(reconHash)),
      () => agreements.readCanonicalAgreementReconciliationStatus(session, recon, reconcile(reconHash)),
    ];
    const each = async (calls: (() => Promise<unknown>)[]) => { const out = []; for (const call of calls) out.push(await refusal(call())); return out; };
    for (const key of ["creator", "ledger", "collector", "label"] as const) {
      for (const [index, error] of (await each(six(await fx.session(key), amendPlan, reconPlan))).entries()) expect(error, `${key} #${index}`).toMatchObject(denied);
    }
    // The own-scoped doctor: outside plans read exactly like missing ones on all six methods.
    const doctor = await fx.session("doctor");
    const outside = await each(six(doctor, amendPlan, reconPlan));
    const missing = await each(six(doctor, 2_000_000_000, 2_000_000_000));
    for (const [index, error] of outside.entries()) {
      expect(error, `outside #${index}`).toMatchObject({ code: "missing" });
      expect({ code: error?.code, message: error?.message, name: error?.name }, `outside #${index}`).toEqual({ code: missing[index]?.code, message: missing[index]?.message, name: missing[index]?.name });
    }
    // Inside its scope the doctor reads the preview.
    const { planId: mine } = await approvedPlan(await patient(fx.parties.doctor!));
    expect(await agreements.readCanonicalAgreementAmendment(doctor, mine)).toMatchObject({ planId: mine });
    // Revocation between two calls.
    await fx.setGrants("manager", {}, { patientScope: "all" });
    try { expect(await refusal(agreements.readCanonicalAgreementReconciliation(await fx.session("manager"), reconPlan))).toMatchObject(denied); }
    finally { await fx.setGrants("manager", MANAGE, { patientScope: "all" }); }
    expect(await q("SELECT id FROM agreement_delta_amendments WHERE plan_id=$1", [amendPlan])).toEqual([]);
    expect(await q("SELECT id FROM agreement_reconciliations WHERE plan_id=$1", [reconPlan])).toEqual([]);
  });

  it("refuses a patient that leaves the clinician's scope while the amendment waits for the patient row", async () => {
    const pid = await patient(fx.parties.doctor!), { planId, newServiceId } = await approvedPlan(pid), session = await fx.session("doctor");
    const input = amendment(planId, (await agreements.readCanonicalAgreementAmendment(session, planId)).sourceHash, newServiceId);
    const blocker: PoolClient = await blockers.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [pid]);
      pending = refusal(agreements.commandCanonicalAgreementAmendment(session, planId, input));
      let waiting = false;
      for (let i = 0; i < 500 && !waiting; i++) {
        waiting = (await q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM patients WHERE id=$1 FOR NO KEY UPDATE%'")).length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ code: "missing" });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
    expect(await q("SELECT id FROM agreement_delta_amendments WHERE plan_id=$1", [planId])).toEqual([]);
    expect(await q("SELECT idempotency_key FROM agreement_delta_attempt_rejections WHERE plan_id=$1", [planId])).toEqual([]);
  });
});
