import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, baseUrl, harness } from "./_server";
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let serial = 0;
const stamp = Date.now();
async function fixture(existing = false, fixed = false) {
  const patientId = (await db.query<{ id: number }>(`INSERT INTO patients (patient_number, full_name)
    VALUES ($1, 'Synthetic consent HTTP patient') RETURNING id`, [`CONSENT-HTTP-${stamp}-${++serial}`])).rows[0].id;
  const planId = (await db.query<{ id: number }>(`INSERT INTO treatment_plans
    (patient_id, title, total_minor, base_currency, total_from_items)
    VALUES ($1, 'Synthetic HTTP agreement', $2, 'SAR', $3) RETURNING id`, [patientId, fixed ? 3001 : 99, !fixed])).rows[0].id;
  if (!fixed) await db.query(`INSERT INTO plan_items (plan_id, service_name, category, tooth_code, quantity, unit_price_minor)
    VALUES ($1, 'Synthetic filling', 'filling', 11, 1, 3001)`, [planId]);
  if (existing) await db.query(`INSERT INTO plan_installments (plan_id, number, due_date, amount_minor)
    VALUES ($1, 1, '2026-10-03', 1000), ($1, 2, '2026-11-03', 2001)`, [planId]);
  return { planId, patientId };
}
async function snapshot(f: { planId: number; patientId: number }) {
  return (await db.query(`SELECT jsonb_build_object(
    'plan', (SELECT to_jsonb(p) FROM treatment_plans p WHERE id = $1),
    'chart', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tooth_conditions t WHERE patient_id = $2),
    'schedule', (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM plan_installments i WHERE plan_id = $1),
    'audits', (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_log a WHERE action = 'plan.consent' AND entity_id = $3),
    'invoices', (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i WHERE patient_id = $2),
    'payments', (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p WHERE patient_id = $2)) AS data`,
  [f.planId, f.patientId, String(f.planId)])).rows[0].data;
}
const post = (id: number, body: unknown, session = h.sessions.admin) =>
  authedMutation(`/api/plans/${id}/consent`, session, "POST", JSON.stringify(body));
beforeAll(async () => { h = await harness(); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect(); });
afterAll(async () => { await db?.end(); });
describe("built HTTP consent all-or-nothing boundary", () => {
  it.each([{ count: 61 }, { count: -1 }, { count: "bad" }, { count: 2, everyDays: 0 },
    { count: 2, everyDays: 366 }, { count: 2, firstDueDate: "2026-02-30" }])("400 leaves agreement unchanged: %j", async (body) => {
      const f = await fixture(); const before = await snapshot(f);
      expect((await post(f.planId, body)).status).toBe(400); expect(await snapshot(f)).toEqual(before);
    });
  it("409 with existing schedule leaves consent, chart, total and installments unchanged", async () => {
    const f = await fixture(true); const before = await snapshot(f);
    const response = await post(f.planId, { count: 2 }); expect(response.status).toBe(409);
    expect((await response.json()).message).not.toContain("سُجّلت الموافقة"); expect(await snapshot(f)).toEqual(before);
  });
  it("consent-only preserves a fixed SAR agreement schedule and produces no financial postings", async () => {
    const f = await fixture(true, true); const before = await snapshot(f);
    const response = await post(f.planId, {}); expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ totalMinor: 3001, installments: 0 });
    const after = await snapshot(f); expect(after.schedule).toEqual(before.schedule);
    expect(after.plan.total_minor).toBe(before.plan.total_minor); expect(after.chart).toBeNull();
    expect(after.invoices).toEqual(before.invoices); expect(after.payments).toEqual(before.payments);
    expect(after.audits).toHaveLength(1);
  });
  it("commits a single complete command and refuses a second consent unchanged", async () => {
    const f = await fixture(); const response = await post(f.planId, { count: 3, firstDueDate: "2028-02-29" });
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ totalMinor: 3001, installments: 3 });
    const saved = await snapshot(f); expect(saved.chart).toHaveLength(1); expect(saved.schedule).toHaveLength(3); expect(saved.audits).toHaveLength(1);
    expect(saved.invoices).toBeNull(); expect(saved.payments).toBeNull();
    expect((await post(f.planId, {})).status).toBe(409); expect(await snapshot(f)).toEqual(saved);
  });
  it("enforces authentication, current role and same-origin CSRF before writes", async () => {
    const f = await fixture(); const before = await snapshot(f); const path = `/api/plans/${f.planId}/consent`;
    expect((await fetch(`${baseUrl}${path}`, { method: "POST", headers: { Origin: baseUrl, "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);
    for (const session of [h.sessions.doctorA, h.sessions.accountant]) expect((await post(f.planId, {}, session)).status).toBe(403);
    expect((await authedMutation(path, h.sessions.admin, "POST", "{}", { Origin: "https://foreign.example" })).status).toBe(403);
    expect(await snapshot(f)).toEqual(before);
  });
});
