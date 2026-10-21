import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

// Same synthetic legacy-plan shape as the hosted compatibility-panel journeys.
// No invoice, historical agreement or clinical bridge is invented to satisfy a read.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId: number;
let caseId: number;
let planId: number;
const path = () => `/api/patients/${patientId}/legacy-onboarding?caseId=${caseId}`;
const missingSource = { state: "missing", clinicalCaseIds: [], sources: [], hasRecordedSchedule: false };

beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  patientId = (await db.query(`INSERT INTO patients (patient_number, full_name)
    VALUES ($1, 'Synthetic compatibility reference') RETURNING id`, [`COMPAT-${Date.now()}`])).rows[0].id;
  planId = (await db.query(`INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency)
    VALUES ($1, 'Synthetic existing installment link', 60000, 'SAR') RETURNING id`, [patientId])).rows[0].id;
  await db.query(`INSERT INTO plan_installments (plan_id, number, due_date, amount_minor)
    VALUES ($1, 1, CURRENT_DATE, 30000), ($1, 2, CURRENT_DATE + 30, 30000)`, [planId]);
  caseId = (await db.query(`INSERT INTO ortho_cases
    (patient_id, plan_id, created_by, baseline_kind, legacy_financial_mode)
    VALUES ($1, $2, 'synthetic-compatibility-http', 'legacy', 'installments') RETURNING id`, [patientId, planId])).rows[0].id;
});
afterAll(async () => { await db?.end(); });

async function state() {
  return (await db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(p)) FROM treatment_plans p WHERE patient_id=$1) AS plans,
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM plan_installments i WHERE plan_id=$2) AS installments,
    (SELECT count(*)::int FROM invoices WHERE patient_id=$1) AS invoices,
    (SELECT count(*)::int FROM payments WHERE patient_id=$1) AS payments,
    (SELECT count(*)::int FROM clinical_cases WHERE patient_id=$1) AS clinical_cases,
    (SELECT count(*)::int FROM legacy_treatment_agreements WHERE patient_id=$1) AS agreements`, [patientId, planId])).rows[0];
}

describe("legacy compatibility link versus canonical financial source over HTTP", () => {
  it("reads a real old schedule without inventing a canonical source", async () => {
    const before = await state();
    const response = await authedGet(path(), h.sessions.admin);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ onboarding: {
      caseId, complete: true, adjustmentClass: "INCLUDED", financialReference: missingSource,
    } });
    const plans = await authedGet(`/api/plans?patientId=${patientId}`, h.sessions.admin);
    expect(plans.status).toBe(200);
    expect((await plans.json()).plans).toEqual([expect.objectContaining({
      id: planId, patientId, installments: [expect.objectContaining({ amountMinor: 30000 }), expect.objectContaining({ amountMinor: 30000 })],
    })]);
    expect(await state()).toEqual(before);
    expect(before).toMatchObject({ invoices: 0, payments: 0, clinical_cases: 0, agreements: 0 });
  });

  it("denies a finance-only reader without exposing source identities", async () => {
    const response = await authedGet(path(), h.sessions.accountant);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: "هذا القسم خارج صلاحيات دورك." });
  });

  it("unlinking changes classification independently of the retained plan and creates no debt", async () => {
    const before = await state();
    const response = await authedMutation(`/api/ortho/${caseId}`, h.sessions.admin, "PATCH", JSON.stringify({ planId: null }));
    expect(response.status).toBe(200);
    const read = await authedGet(path(), h.sessions.admin);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ onboarding: {
      caseId, complete: false, adjustmentClass: "OUTSIDE_CONTRACT", financialReference: missingSource,
    } });
    expect(await state()).toEqual(before);
    expect((await db.query("SELECT plan_id FROM ortho_cases WHERE id=$1", [caseId])).rows).toEqual([{ plan_id: null }]);
  });
});
