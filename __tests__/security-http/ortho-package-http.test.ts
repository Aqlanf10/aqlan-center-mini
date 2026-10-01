import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, harness } from "./_server";

/**
 * (P1-B) ربط حالة التقويم باتفاقها على التطبيق المبني: للإدارة والطبيب والاستقبال فقط،
 * وخطةُ مريضٍ آخر مرفوضة — وكل رفضٍ بالعربية بلا تفاصيل داخلية.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let caseId = 0;
let planId = 0;
let foreignPlan = 0;
const stamp = Date.now();

const patch = (session: { cookie: string }, body: unknown) =>
  authedMutation(`/api/ortho/${caseId}`, session, "PATCH", JSON.stringify(body));

async function arabic(response: Response) {
  const body = await response.json().catch(() => ({})) as { message?: string };
  expect(body.message ?? "").toMatch(/[؀-ۿ]/);
  expect(JSON.stringify(body)).not.toMatch(/error:|at \/|stack|violates|constraint/i);
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const patient = async (suffix: string) => (await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [`PKGH-${suffix}-${stamp}`, `مريض ${suffix}`])).rows[0].id;
  const plan = async (patientId: number) => {
    const id = (await db.query<{ id: number }>(
      `INSERT INTO treatment_plans (patient_id, title, total_minor) VALUES ($1, 'باقة تقويم', 600000) RETURNING id`, [patientId])).rows[0].id;
    await db.query(`INSERT INTO plan_installments (plan_id, number, due_date, amount_minor) VALUES ($1, 1, CURRENT_DATE, 600000)`, [id]);
    return id;
  };
  const mine = await patient("M");
  planId = await plan(mine);
  foreignPlan = await plan(await patient("F"));
  caseId = (await db.query<{ id: number }>(
    `INSERT INTO ortho_cases (patient_id, created_by) VALUES ($1, 'doctor') RETURNING id`, [mine])).rows[0].id;
}, 120_000);

afterAll(async () => { await db?.end(); });

describe("(P1-B) linking an orthodontic case to its agreement over HTTP", () => {
  it("finance-only roles cannot link", async () => {
    const response = await patch(h.sessions.cashier, { planId });
    expect([401, 403]).toContain(response.status);
    await arabic(response);
  });

  it("another patient's plan is refused in Arabic", async () => {
    const response = await patch(h.sessions.reception, { planId: foreignPlan });
    expect(response.status).toBe(409);
    await arabic(response);
    expect((await db.query(`SELECT plan_id FROM ortho_cases WHERE id = $1`, [caseId])).rows[0].plan_id).toBeNull();
  });

  it("an invalid plan id is a 400 in Arabic", async () => {
    const response = await patch(h.sessions.reception, { planId: "abc" });
    expect(response.status).toBe(400);
    await arabic(response);
  });

  it("reception links the patient's own agreement — funded, audited", async () => {
    const response = await patch(h.sessions.reception, { planId });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, changed: true, funded: true });
    expect((await db.query(`SELECT plan_id FROM ortho_cases WHERE id = $1`, [caseId])).rows[0].plan_id).toBe(planId);
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'ortho.plan_link' AND entity_id = $1`,
      [String(caseId)])).rows[0].n).toBe(1);
  });
});
