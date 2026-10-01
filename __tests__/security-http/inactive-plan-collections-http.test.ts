import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, harness } from "./_server";
import { PATIENT_NUMBER_SQL } from "../../lib/document-numbers";

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  await db.query(`INSERT INTO cashier_shifts (opened_by) SELECT 'inactive-plan-http'
    WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`);
}, 120_000);
afterAll(async () => { await db?.end(); });
async function seed(status: string) {
  const { rows: [patient] } = await db.query<{ id: number }>(
    // Use the canonical short patient-number shape. These rows remain in the
    // shared HTTP fixture and are subsequently rendered by the phone-width gate.
    `INSERT INTO patients (patient_number, full_name)
     VALUES (${PATIENT_NUMBER_SQL}, 'Synthetic plan HTTP') RETURNING id`,
  );
  const { rows: [plan] } = await db.query<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, billing_mode, status)
     VALUES ($1, 'Synthetic agreement', 300000, 'YER', 'installments', $2) RETURNING id`, [patient.id, status],
  );
  await db.query(`INSERT INTO plan_installments (plan_id, number, due_date, amount_minor)
    VALUES ($1, 1, CURRENT_DATE, 300000)`, [plan.id]);
  return { patientId: patient.id, planId: plan.id };
}
const post = (path: string, target: { patientId: number; planId: number }, key: string) => authedMutation(
  path, h.sessions.reception, "POST", JSON.stringify({ ...target, amount: "150000", currency: "YER", method: "cash" }),
  { "Idempotency-Key": key },
);

describe("inactive plan collection over built HTTP", () => {
  it.each(["completed", "cancelled"])("both endpoints refuse new receipts for a %s plan", async (status) => {
    const target = await seed(status);
    for (const path of ["/api/payments", `/api/plans/${target.planId}`]) {
      const response = await post(path, target, crypto.randomUUID());
      expect(response.status).toBe(409);
      expect((await response.json()).message).toContain("الخطة غير جارية");
    }
    expect((await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM payments WHERE patient_id = $1`, [target.patientId])).rows[0].n).toBe(0);
    expect((await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM invoices WHERE patient_id = $1`, [target.patientId])).rows[0].n).toBe(0);
  });

  it.each(["general", "dedicated"])("%s endpoint replays the same receipt after closure", async (door) => {
    const target = await seed("active");
    const path = door === "general" ? "/api/payments" : `/api/plans/${target.planId}`;
    const key = crypto.randomUUID();
    const first = await post(path, target, key);
    expect(first.status).toBe(201);
    const original = await first.json();
    const close = await authedMutation(`/api/plans/${target.planId}`, h.sessions.reception,
      "PATCH", JSON.stringify({ status: "completed" }));
    expect(close.status).toBe(200);
    const again = await post(path, target, key);
    expect(again.status).toBe(200);
    const replay = await again.json();
    expect(door === "general" ? replay.id : replay.paymentId).toBe(door === "general" ? original.id : original.paymentId);
    expect((await post(path, target, crypto.randomUUID())).status).toBe(409);
    expect((await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM payments WHERE patient_id = $1`, [target.patientId])).rows[0].n).toBe(1);
    expect((await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM invoices WHERE patient_id = $1`, [target.patientId])).rows[0].n).toBe(1);
  });
});
