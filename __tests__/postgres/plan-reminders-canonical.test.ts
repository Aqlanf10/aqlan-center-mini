/** M2 slice 94e (G4-8; contract section 14): instalment reminders on the canonical runtime,
 * real PostgreSQL, synthetic data only. appointments.create; finance grants, the plan edit grant
 * and the label never remind; an outside plan is skipped like a missing one, decided after the
 * plan row lock (race test); revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-plan-reminders-secret-94e");
const db = await import("../../lib/db");
const reminders = await import("../../lib/canonical-plan-reminders");

const BOOK = { "appointments.create": true };
const ACCOUNTS = {
  owner: { username: "SYN-RM-OWNER", role: "admin" },
  booker: { username: "SYN-RM-BOOK", role: "reception", patientScope: "all", appointmentScope: "all", grants: BOOK },
  collector: { username: "SYN-RM-COLL", role: "cashier", patientScope: "all", grants: { "finance.payments.collect": true } },
  creator: { username: "SYN-RM-INV", role: "reception", patientScope: "all", grants: { "finance.invoices.create": true, "finance.invoices.view": true } },
  planner: { username: "SYN-RM-PLAN", role: "doctor", patientScope: "all", grants: { "clinical.plans.view": true, "clinical.plans.edit": true } },
  label: { username: "SYN-RM-LABEL", role: "admin", patientScope: "all", grants: {} },
  doctor: { username: "SYN-RM-DR", role: "doctor", doctor: true, patientScope: "own", appointmentScope: "own", grants: BOOK },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let blockers: Pool;
let serial = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; message?: string }) => error);
const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };
const patient = async (doctor: number | null = null) => (await q(
  "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN RM patient',$2) RETURNING id", [`SYN-RM-${++serial}`, doctor]))[0].id as number;
async function plan(patientId: number) {
  const made = await db.createPlanV2({ patientId, title: "SYN RM plan", specialty: null, primaryDoctorId: null, billingMode: "installments",
    baseCurrency: "YER", startDate: "2026-01-01", note: null, createdBy: "SYN-RM-OWNER", items: [], installments: [{ dueDate: "2026-01-01", amountMinor: 5000 }, { dueDate: "2026-02-01", amountMinor: 5000 }] });
  if (!made.ok) throw new Error(made.message);
  return made.planId;
}
const stamped = async (planId: number) => (await q("SELECT last_reminder_at IS NOT NULL AS stamped FROM treatment_plans WHERE id=$1", [planId]))[0].stamped as boolean;
const audits = async (planId: number) => (await q("SELECT actor, details FROM audit_log WHERE action='plan.installment_reminder' AND entity_id=$1::text ORDER BY id", [planId]));

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  blockers = new Pool({ connectionString: fx.pool.options.connectionString, ssl: false, max: 3 });
}, 180_000);
afterAll(async () => { await blockers?.end(); await fx?.close(); });

describe("instalment reminders", () => {
  it("appointments.create stamps a plan, an instalment and a bulk batch with the actor's audit", async () => {
    const session = await fx.session("booker"), a = await plan(await patient()), b = await plan(await patient()), c = await plan(await patient());
    expect(await reminders.commandCanonicalPlanReminders(session, { planIds: [a], bulk: false })).toMatchObject({ updatedCount: 1 });
    expect(await stamped(a)).toBe(true);
    expect(await reminders.commandCanonicalPlanReminders(session, { planIds: [b], installmentNumber: 2, bulk: false })).toMatchObject({ updatedCount: 1 });
    expect(await q("SELECT number FROM plan_installments WHERE plan_id=$1 AND last_reminder_at IS NOT NULL", [b])).toEqual([{ number: 2 }]);
    expect(await reminders.commandCanonicalPlanReminders(session, { planIds: [b], installmentNumber: 9, bulk: false })).toMatchObject({ updatedCount: 0 });
    expect(await reminders.commandCanonicalPlanReminders(session, { planIds: [c, a, 2_000_000_000], bulk: true })).toMatchObject({ updatedCount: 2 });
    expect(await audits(a)).toEqual([{ actor: "SYN-RM-BOOK", details: null }, { actor: "SYN-RM-BOOK", details: { جماعي: true } }]);
    expect(await audits(b)).toEqual([{ actor: "SYN-RM-BOOK", details: { القسط: 2 } }]);
  });

  it("finance grants, the plan edit grant and the label never remind; outside is skipped like missing; revocation", async () => {
    const outside = await plan(await patient()), mine = await plan(await patient(fx.parties.doctor!));
    for (const key of ["collector", "creator", "planner", "label"] as const) {
      expect(await refusal(reminders.commandCanonicalPlanReminders(await fx.session(key), { planIds: [outside], bulk: false })), key).toMatchObject(denied);
    }
    const doctor = await fx.session("doctor");
    expect(await reminders.commandCanonicalPlanReminders(doctor, { planIds: [outside], bulk: false })).toMatchObject({ updatedCount: 0 });
    expect(await reminders.commandCanonicalPlanReminders(doctor, { planIds: [2_000_000_000], bulk: false })).toMatchObject({ updatedCount: 0 });
    expect(await reminders.commandCanonicalPlanReminders(doctor, { planIds: [outside, mine], bulk: true })).toMatchObject({ updatedCount: 1 });
    expect([await stamped(outside), await stamped(mine)]).toEqual([false, true]);
    expect(await audits(outside)).toEqual([]);
    await fx.setGrants("booker", {}, { patientScope: "all", appointmentScope: "all" });
    try { expect(await refusal(reminders.commandCanonicalPlanReminders(await fx.session("booker"), { planIds: [outside], bulk: false }))).toMatchObject(denied); }
    finally { await fx.setGrants("booker", BOOK, { patientScope: "all", appointmentScope: "all" }); }
    expect(await stamped(outside)).toBe(false);
  });

  it("skips a patient that leaves the clinician's scope while the reminder waits for the plan row", async () => {
    const pid = await patient(fx.parties.doctor!), p = await plan(pid), session = await fx.session("doctor");
    const blocker: PoolClient = await blockers.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM treatment_plans WHERE id=$1 FOR UPDATE", [p]);
      await blocker.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [pid]);
      pending = reminders.commandCanonicalPlanReminders(session, { planIds: [p], bulk: false });
      let waiting = false;
      for (let i = 0; i < 500 && !waiting; i++) {
        waiting = (await q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM treatment_plans WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE%'")).length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ updatedCount: 0 });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending?.catch(() => undefined); }
    expect(await stamped(p)).toBe(false);
    expect(await audits(p)).toEqual([]);
  });
});
