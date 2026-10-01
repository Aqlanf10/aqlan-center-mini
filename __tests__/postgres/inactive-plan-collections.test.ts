import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
const { ensureSchema, getPool, resetPoolForTesting, openShift, recordPayment, recordPlanInstallment,
  setPlanStatus, patientLedger } = await import("../../lib/db");

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "inactive-plan-pg", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function seed() {
  const { rows: [patient] } = await getPool().query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'Synthetic plan race') RETURNING id`,
    [`PLAN-RACE-${crypto.randomUUID()}`],
  );
  const { rows: [plan] } = await getPool().query<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, billing_mode)
     VALUES ($1, 'Synthetic agreement', 300000, 'YER', 'installments') RETURNING id`, [patient.id],
  );
  await getPool().query(
    `INSERT INTO plan_installments (plan_id, number, due_date, amount_minor) VALUES ($1, 1, CURRENT_DATE, 300000)`, [plan.id],
  );
  return { patientId: patient.id, planId: plan.id };
}
type Target = Awaited<ReturnType<typeof seed>>;
type Mode = "ordinary" | "installment";
function collect(target: Target, mode: Mode, key: string) {
  const input = { ...target, amountMinor: 150000, currency: "YER" as const, baseCurrency: "YER" as const,
    exchangeRate: 1, method: "cash", note: null, createdBy: "inactive-plan-pg", idempotencyKey: key };
  return mode === "ordinary"
    ? recordPayment({ ...input, invoiceId: null, kind: "payment" })
    : recordPlanInstallment({ ...input, installmentNumber: 1, planTitle: "Synthetic agreement" });
}

describe("inactive plan collection serialization on PostgreSQL", () => {
  it.each(["ordinary", "installment"] as const)("%s collection rechecks a concurrent cancellation after waiting for the plan lock", async (mode) => {
    const target = await seed();
    const canceller = await getPool().connect();
    let pending: ReturnType<typeof collect> | undefined;
    try {
      await canceller.query("BEGIN");
      await canceller.query(`SELECT id FROM treatment_plans WHERE id = $1 FOR UPDATE`, [target.planId]);
      pending = collect(target, mode, `cancel-race-${mode}`);
      // Attach rejection immediately even if an assertion below fails before await.
      void pending.catch(() => {});
      let waiting = false;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const { rows } = await getPool().query<{ waiting: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
           AND wait_event_type = 'Lock' AND query LIKE '%FROM treatment_plans%'
           AND (query LIKE '%FOR SHARE%' OR query LIKE '%FOR UPDATE OF t%')) AS waiting`,
        );
        if (rows[0].waiting) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await canceller.query(`UPDATE treatment_plans SET status = 'cancelled' WHERE id = $1`, [target.planId]);
      await canceller.query("COMMIT");
      expect(await pending).toMatchObject({ reason: "inactive_plan" });
      const ledger = await patientLedger(target.patientId);
      expect(ledger.payments).toHaveLength(0);
      expect(ledger.invoices).toHaveLength(0);
    } finally {
      await canceller.query("ROLLBACK").catch(() => {});
      canceller.release();
      await pending;
    }
  }, 20_000);

  it.each(["ordinary", "installment"] as const)("%s receipt committed before closure remains replayable", async (mode) => {
    const target = await seed();
    const first = await collect(target, mode, `before-close-${mode}`);
    expect("reason" in first ? first.reason : null).toBeNull();
    await setPlanStatus(target.planId, "completed", { actor: "inactive-plan-pg", actorRole: "admin" });
    const replay = await collect(target, mode, `before-close-${mode}`);
    expect(replay).toMatchObject({ replayed: true });
    expect(await collect(target, mode, `after-close-${mode}`)).toMatchObject({ reason: "inactive_plan" });
    expect((await patientLedger(target.patientId)).payments).toHaveLength(1);
  });
});
